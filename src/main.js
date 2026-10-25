import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import "../style.css";

const elements = {
  reader: document.querySelector("#reader"),
  status: document.querySelector("#statusText"),
  statusRow: document.querySelector(".status-row"),
  start: document.querySelector("#startButton"),
  stop: document.querySelector("#stopButton"),
  again: document.querySelector("#againButton"),
  resultCard: document.querySelector("#resultCard"),
  result: document.querySelector("#resultValue"),
  camera: document.querySelector("#cameraSelect"),
  cameraTools: document.querySelector("#cameraTools"),
  zoomRange: document.querySelector("#zoomRange"),
  zoomValue: document.querySelector("#zoomValue"),
  autoZoom: document.querySelector("#autoZoomButton"),
  torch: document.querySelector("#torchButton"),
  cameraToolsHint: document.querySelector("#cameraToolsHint"),
  pausedScanButton: document.querySelector("#pausedScanButton"),
  barcodeGuide: document.querySelector("#barcodeGuide"),
};

function createScanner() {
  return new Html5Qrcode("decoder", {
    formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128],
    verbose: false,
  });
}

function createCameraSession() {
  const decoder = createScanner();
  return {
    decoder,
    stream: null,
    track: null,
    video: null,
    state: 1,
    getState() { return this.state; },
    getRunningTrackSettings() { return this.track?.getSettings() || {}; },
    getRunningTrackCapabilities() { return this.track?.getCapabilities() || {}; },
    pause() {
      this.state = 3;
      this.video?.pause();
    },
    resume() {
      this.state = 2;
      return this.video?.play();
    },
    async stop() {
      this.state = 1;
      this.stream?.getTracks().forEach((track) => track.stop());
      if (this.video) {
        this.video.pause();
        this.video.srcObject = null;
        this.video.remove();
      }
      this.stream = null;
      this.track = null;
      this.video = null;
      try { this.decoder.clear(); } catch { /* Decoder host may already be clear. */ }
    },
  };
}

let scanner = null;
let starting = false;
let running = false;
let stopping = false;
let stopRequested = false;
let hasResult = false;
let stopPromise = null;
let pendingStopMessage = "Camera stopped.";
let sessionId = 0;
let selectedCameraId = "";
let zoomFeature = null;
let torchFeature = null;
let torchEnabled = false;
let pendingZoom = null;
let zoomApplyTimer = null;
let zoomApplyInProgress = false;
let lastZoomApplyAt = 0;
let zoomMin = 1;
let zoomMax = 1;
let zoomStep = 0.1;
let autoZoomEnabled = true;
let lastAutoZoomAt = 0;
let guideTrackingId = 0;
let guideTimer = null;
let currentGuideBounds = null;
let guidedScanId = 0;
let guidedScanTimer = null;
let guidedScanBusy = false;
const guidedCropCanvas = document.createElement("canvas");
const guidedCropContext = guidedCropCanvas.getContext("2d", { willReadFrequently: true });
const guideCanvas = document.createElement("canvas");
guideCanvas.width = 320;
guideCanvas.height = 240;
const guideContext = guideCanvas.getContext("2d", { willReadFrequently: true });

function setStatus(message, kind = "idle") {
  elements.status.textContent = message;
  elements.statusRow.className = `status-row status-${kind}`;
}

function setControls() {
  elements.start.disabled = starting || running || stopping;
  elements.stop.disabled = (!starting && !running) || stopping || stopRequested;
  elements.camera.disabled = starting || stopping;
  elements.again.hidden = starting || stopping || !hasResult;
}

function findBarcodePattern(video) {
  if (!video.videoWidth || !video.videoHeight || !guideContext) return null;
  const width = guideCanvas.width;
  const height = guideCanvas.height;
  guideContext.drawImage(video, 0, 0, width, height);
  const { data } = guideContext.getImageData(0, 0, width, height);
  const rowEdges = new Uint16Array(height);
  const edgeXByRow = Array.from({ length: height }, () => []);

  for (let y = 2; y < height - 2; y += 1) {
    let previous = (data[(y * width + 1) * 4] * 0.299)
      + (data[(y * width + 1) * 4 + 1] * 0.587)
      + (data[(y * width + 1) * 4 + 2] * 0.114);
    for (let x = 2; x < width - 2; x += 1) {
      const offset = (y * width + x) * 4;
      const gray = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
      if (Math.abs(gray - previous) > 48) {
        rowEdges[y] += 1;
        edgeXByRow[y].push(x);
      }
      previous = gray;
    }
  }

  let peakRow = -1;
  let peakScore = 0;
  for (let y = 4; y < height - 4; y += 1) {
    const score = rowEdges[y - 2] + rowEdges[y - 1] + rowEdges[y] + rowEdges[y + 1] + rowEdges[y + 2];
    if (score > peakScore) {
      peakScore = score;
      peakRow = y;
    }
  }
  if (peakRow < 0 || peakScore < 75) return null;

  const minRowScore = Math.max(8, Math.floor(peakScore / 5 * 0.42));
  let top = peakRow;
  let bottom = peakRow;
  while (top > 3 && rowEdges[top - 1] >= minRowScore) top -= 1;
  while (bottom < height - 4 && rowEdges[bottom + 1] >= minRowScore) bottom += 1;
  if (bottom - top < 4) return null;

  let left = width;
  let right = 0;
  let luminanceTotal = 0;
  let brightPixels = 0;
  let pixelCount = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (const x of edgeXByRow[y]) {
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const gray = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
      luminanceTotal += gray;
      if (gray > 170) brightPixels += 1;
      pixelCount += 1;
    }
  }

  const span = right - left;
  const averageLuminance = luminanceTotal / pixelCount;
  const brightRatio = brightPixels / pixelCount;
  if (span < width * 0.22 || span > width * 0.97 || averageLuminance < 92 || brightRatio < 0.12) return null;

  // Preserve the previously working quiet-zone padding around detected bars.
  // Fixed center mode uses CENTER_GUIDE_BOUNDS and is unaffected by this.
  const paddingX = Math.max(8, span * 0.16);
  const paddingY = Math.max(8, (bottom - top) * 0.55);
  return {
    left: Math.max(0, (left - paddingX) / width),
    top: Math.max(0, (top - paddingY) / height),
    right: Math.min(1, (right + paddingX) / width),
    bottom: Math.min(1, (bottom + paddingY) / height),
  };
}

function placeBarcodeGuide(video, bounds, label = "BARCODE PATTERN", detected = true) {
  currentGuideBounds = bounds;
  const videoRect = video.getBoundingClientRect();
  const shellRect = elements.barcodeGuide.parentElement.getBoundingClientRect();
  const scale = Math.max(videoRect.width / video.videoWidth, videoRect.height / video.videoHeight);
  const renderedWidth = video.videoWidth * scale;
  const renderedHeight = video.videoHeight * scale;
  const cropLeft = (renderedWidth - videoRect.width) / 2;
  const cropTop = (renderedHeight - videoRect.height) / 2;
  const left = videoRect.left - shellRect.left + bounds.left * renderedWidth - cropLeft;
  const top = videoRect.top - shellRect.top + bounds.top * renderedHeight - cropTop;
  const right = videoRect.left - shellRect.left + bounds.right * renderedWidth - cropLeft;
  const bottom = videoRect.top - shellRect.top + bounds.bottom * renderedHeight - cropTop;

  elements.barcodeGuide.style.left = `${Math.max(0, left)}px`;
  elements.barcodeGuide.style.top = `${Math.max(0, top)}px`;
  elements.barcodeGuide.style.width = `${Math.max(0, Math.min(shellRect.width, right) - Math.max(0, left))}px`;
  elements.barcodeGuide.style.height = `${Math.max(0, Math.min(shellRect.height, bottom) - Math.max(0, top))}px`;
  elements.barcodeGuide.classList.toggle("barcode-guide-detected", detected);
  elements.barcodeGuide.querySelector("span").textContent = label;
}

function stopBarcodeGuideTracking(clear = false) {
  guideTrackingId += 1;
  clearTimeout(guideTimer);
  guideTimer = null;
  if (clear) {
    elements.barcodeGuide.hidden = true;
    elements.barcodeGuide.classList.remove("barcode-guide-detected");
    currentGuideBounds = null;
  }
}

async function scanCropWithHtml5Qrcode(decoder, imageFile) {
  // html5-qrcode creates two object URLs for every file scan but only revokes
  // one of them on the next scan. Revoke URLs for this crop after decoding so
  // continuous frame scanning does not retain every encoded image in memory.
  const originalCreateObjectURL = URL.createObjectURL;
  const cropUrls = [];
  const trackedCreateObjectURL = function (object) {
    const url = originalCreateObjectURL.call(URL, object);
    if (object === imageFile) cropUrls.push(url);
    return url;
  };
  URL.createObjectURL = trackedCreateObjectURL;
  try {
    return await decoder.scanFileV2(imageFile, false);
  } finally {
    if (URL.createObjectURL === trackedCreateObjectURL) {
      URL.createObjectURL = originalCreateObjectURL;
    }
    cropUrls.forEach((url) => URL.revokeObjectURL(url));
  }
}

const CENTER_GUIDE_BOUNDS = { left: 0.03, top: 0.34, right: 0.97, bottom: 0.66 };

function showFixedCenterGuide() {
  const video = elements.reader.querySelector("video");
  if (!video?.videoWidth || !video.videoHeight) return;
  elements.barcodeGuide.hidden = false;
  placeBarcodeGuide(video, CENTER_GUIDE_BOUNDS, "FIXED CENTER", false);
}

function isPatternNearCenter(bounds) {
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  return centerX >= 0.25 && centerX <= 0.75 && centerY >= 0.34 && centerY <= 0.66;
}

async function increaseCameraZoom(activeScanner) {
  if (!autoZoomEnabled || !zoomFeature || zoomApplyInProgress || pendingZoom !== null) return;

  const feature = zoomFeature;
  const current = Number(activeScanner.track?.getSettings().zoom ?? elements.zoomRange.value ?? zoomMin);
  if (current >= zoomMax - 0.001) {
    elements.cameraToolsHint.textContent = "Maximum camera zoom reached; still scanning the center frame.";
    return;
  }

  const range = zoomMax - zoomMin;
  const progress = range > 0 ? (current - zoomMin) / range : 1;
  // Move quickly while the barcode is small, then use smaller steps and longer
  // pauses near the target so camera focus/exposure can settle between changes.
  const stepFraction = progress < 0.55 ? 0.035 : progress < 0.8 ? 0.018 : 0.008;
  const interval = progress < 0.55 ? 420 : progress < 0.8 ? 700 : 1000;
  if (performance.now() - lastAutoZoomAt < interval) return;
  const increment = Math.max(zoomStep, range * stepFraction);
  const nextZoom = Math.min(zoomMax, current + increment);
  zoomApplyInProgress = true;
  lastAutoZoomAt = performance.now();
  try {
    await feature.apply(nextZoom);
    if (zoomFeature === feature) {
      elements.zoomRange.value = String(nextZoom);
      elements.zoomValue.textContent = `${nextZoom.toFixed(1)}?`;
      elements.cameraToolsHint.textContent = `Center barcode pattern found. Auto zoom is easing in: ${nextZoom.toFixed(1)}×`;
    }
  } catch {
    if (zoomFeature === feature) {
      elements.cameraToolsHint.textContent = "Automatic zoom is unavailable on this camera; center scanning continues.";
      zoomFeature = null;
      elements.zoomRange.disabled = true;
    }
  } finally {
    zoomApplyInProgress = false;
    if (pendingZoom !== null) scheduleZoomApply();
  }
}

function startCenterPatternTracking(activeScanner = scanner) {
  stopBarcodeGuideTracking(true);
  const trackingId = guideTrackingId;
  const video = elements.reader.querySelector("video");
  if (!video) return;

  elements.barcodeGuide.hidden = false;
  showFixedCenterGuide();
  const scanFrame = () => {
    if (trackingId !== guideTrackingId || !running || !video?.isConnected
      || scanner !== activeScanner || activeScanner?.getState() !== 2) return;
    try {
      const pattern = findBarcodePattern(video);
      if (pattern && isPatternNearCenter(pattern)) {
        void increaseCameraZoom(activeScanner);
      }
    } catch {
      // Keep scanning at the current camera zoom if pattern detection fails.
    }
    guideTimer = setTimeout(scanFrame, 180);
  };
  scanFrame();
}

async function resetCameraZoom() {
  const feature = zoomFeature;
  if (!feature) return;
  clearTimeout(zoomApplyTimer);
  zoomApplyTimer = null;
  pendingZoom = null;
  zoomApplyInProgress = true;
  try {
    await feature.apply(zoomMin);
    if (zoomFeature === feature) {
      elements.zoomRange.value = String(zoomMin);
      elements.zoomValue.textContent = `${zoomMin.toFixed(1)}×`;
      elements.cameraToolsHint.textContent = "Zoom reset. Scanning the center frame.";
    }
  } catch {
    if (zoomFeature === feature) {
      elements.cameraToolsHint.textContent = "Could not reset camera zoom; center scanning continues.";
    }
  } finally {
    zoomApplyInProgress = false;
    lastAutoZoomAt = performance.now();
    if (pendingZoom !== null) scheduleZoomApply();
  }
}

async function decodeGuideCrop(video, bounds, activeScanner, activeSession) {
  if (!video.videoWidth || !video.videoHeight || !guidedCropContext) return;
  const sourceLeft = Math.max(0, Math.floor(bounds.left * video.videoWidth));
  const sourceTop = Math.max(0, Math.floor(bounds.top * video.videoHeight));
  const sourceRight = Math.min(video.videoWidth, Math.ceil(bounds.right * video.videoWidth));
  const sourceBottom = Math.min(video.videoHeight, Math.ceil(bounds.bottom * video.videoHeight));
  const sourceWidth = sourceRight - sourceLeft;
  const sourceHeight = sourceBottom - sourceTop;
  if (sourceWidth < 8 || sourceHeight < 4) return;

  if (!running || hasResult || scanner !== activeScanner || sessionId !== activeSession) return;

  // Decode only the fixed center guide crop. Camera zoom is controlled separately
  // when barcode-like lines are detected near the center.
  const outputWidth = sourceWidth;
  const outputHeight = sourceHeight;
  guidedCropCanvas.width = outputWidth;
  guidedCropCanvas.height = outputHeight;
  guidedCropContext.imageSmoothingEnabled = false;
  guidedCropContext.drawImage(video, sourceLeft, sourceTop, sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
  const blob = await new Promise((resolve) => guidedCropCanvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob || !running || hasResult || scanner !== activeScanner || sessionId !== activeSession) return;

  try {
    const imageFile = new File([blob], "center-frame.jpg", { type: "image/jpeg" });
    const result = await scanCropWithHtml5Qrcode(activeScanner.decoder, imageFile);
    if (result?.decodedText && running && !hasResult && scanner === activeScanner && sessionId === activeSession) {
      acceptDecodedText(result.decodedText, activeScanner, activeSession);
    }
  } catch {
    // No barcode in this crop/zoom level is normal; the next live frame is tried.
  }
}

function stopGuidedZoomScanning() {
  guidedScanId += 1;
  clearTimeout(guidedScanTimer);
  guidedScanTimer = null;
}

function disposeGuideScanLoop() {
  stopGuidedZoomScanning();
}

function startGuidedZoomScanning(activeScanner = scanner, activeSession = sessionId) {
  stopGuidedZoomScanning();
  const scanId = guidedScanId;
  const video = elements.reader.querySelector("video");
  if (!video) return;

  const scanFrame = async () => {
    if (scanId !== guidedScanId || !running || hasResult || scanner !== activeScanner
      || activeScanner?.getState() !== 2 || !video.isConnected) return;

    if (guidedScanBusy) {
      guidedScanTimer = setTimeout(scanFrame, 90);
      return;
    }
    if (!currentGuideBounds) {
      guidedScanTimer = setTimeout(scanFrame, 120);
      return;
    }

    guidedScanBusy = true;
    try {
      await decodeGuideCrop(video, { ...currentGuideBounds }, activeScanner, activeSession);
    } catch {
      // Retry with the next frame if the crop cannot be processed.
    } finally {
      guidedScanBusy = false;
    }

    if (scanId === guidedScanId && running && !hasResult) {
      guidedScanTimer = setTimeout(scanFrame, 120);
    }
  };
  void scanFrame();
}

function setupCameraTools(activeScanner) {
  clearTimeout(zoomApplyTimer);
  zoomApplyTimer = null;
  pendingZoom = null;
  zoomApplyInProgress = false;
  lastZoomApplyAt = 0;
  lastAutoZoomAt = 0;
  zoomMin = 1;
  zoomMax = 1;
  zoomStep = 0.1;
  autoZoomEnabled = true;
  elements.autoZoom.textContent = "Auto zoom: On";
  elements.autoZoom.setAttribute("aria-pressed", "true");
  elements.autoZoom.disabled = true;
  elements.cameraTools.hidden = false;
  elements.cameraToolsHint.textContent = "Zoom and flash depend on the selected camera.";
  zoomFeature = null;
  torchFeature = null;
  torchEnabled = false;
  elements.torch.setAttribute("aria-pressed", "false");
  elements.torch.textContent = "Flash unavailable";

  try {
    const trackCapabilities = activeScanner.getRunningTrackCapabilities();
    if (trackCapabilities.zoom) {
      const zoom = trackCapabilities.zoom;
      const min = zoom.min ?? 1;
      const max = zoom.max ?? min;
      const step = zoom.step ?? 0.1;
      zoomMin = min;
      zoomMax = max;
      zoomStep = step > 0 ? step : 0.1;
      zoomFeature = {
        min,
        max,
        step: zoomStep,
        apply: (value) => activeScanner.track.applyConstraints({ advanced: [{ zoom: value }] }),
      };
      elements.zoomRange.min = String(min);
      elements.zoomRange.max = String(max);
      elements.zoomRange.step = String(step > 0 ? step : 0.1);
      elements.autoZoom.disabled = max <= min;
      if (max <= min) {
        elements.autoZoom.textContent = "Auto zoom unavailable";
        elements.autoZoom.setAttribute("aria-pressed", "false");
      }
      const current = activeScanner.track.getSettings().zoom;
      elements.zoomRange.value = String(current ?? min);
      elements.zoomRange.disabled = max <= min;
      elements.zoomValue.textContent = `${Number(elements.zoomRange.value).toFixed(1)}×`;
    } else {
      elements.zoomRange.disabled = true;
      elements.zoomValue.textContent = "Unavailable";
      elements.autoZoom.textContent = "Auto zoom unavailable";
      elements.autoZoom.setAttribute("aria-pressed", "false");
    }

    if (trackCapabilities.torch === true) {
      torchFeature = { apply: (value) => activeScanner.track.applyConstraints({ advanced: [{ torch: value }] }) };
      torchEnabled = activeScanner.track.getSettings().torch === true;
      elements.torch.disabled = false;
      elements.torch.textContent = torchEnabled ? "Turn flash off" : "Turn flash on";
      elements.torch.setAttribute("aria-pressed", String(torchEnabled));
    } else {
      elements.torch.disabled = true;
    }

    if (zoomFeature || torchFeature) {
      elements.cameraToolsHint.textContent = "Use the slider or flash button if this camera supports it.";
    }
  } catch {
    elements.zoomRange.disabled = true;
    elements.zoomValue.textContent = "Unavailable";
    elements.autoZoom.disabled = true;
    elements.autoZoom.textContent = "Auto zoom unavailable";
    elements.autoZoom.setAttribute("aria-pressed", "false");
    elements.torch.disabled = true;
  }
}

function cameraErrorMessage(error) {
  if (!window.isSecureContext) return "Camera access requires HTTPS or localhost.";
  if (!navigator.mediaDevices?.getUserMedia) return "This browser does not support camera access.";
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
    return "Camera permission was denied. Allow camera access in browser settings, then try again.";
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return "No camera was found on this device.";
  }
  if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
    return "The camera is busy. Close other apps using the camera and retry.";
  }
  return error?.message || "Could not start the camera. Check camera permission and try again.";
}

async function applyCameraQuality(activeScanner) {
  try {
    const capabilities = activeScanner.getRunningTrackCapabilities();

    // Build constraints progressively – only include what the track supports.
    const constraints = {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    };

    const focusModes = capabilities.focusMode;
    if (Array.isArray(focusModes)) {
      if (focusModes.includes("continuous")) {
        constraints.focusMode = "continuous";
      } else if (focusModes.includes("auto")) {
        constraints.focusMode = "auto";
      }
    }

    // Request macro / close-range focus distance when supported (helps Code 128 at card distance).
    if (capabilities.focusDistance && constraints.focusMode === "continuous") {
      // Keep continuous but also set a close-range focus hint.
      constraints.focusDistance = { ideal: 0.15 }; // ~15 cm – typical card-hold distance
    }

    await activeScanner.track.applyConstraints(constraints);
  } catch {
    // Resolution and focus controls vary by camera; keep the browser's defaults if unsupported.
  }
}

async function refreshCameraChoices(activeScanner) {
  try {
    // Enumerate after the active stream has permission; Html5Qrcode.getCameras()
    // opens a second temporary stream, which can steal or disrupt the live camera.
    const cameras = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === "videoinput")
      .map((device) => ({ id: device.deviceId, label: device.label }));
    const activeDeviceId = activeScanner.getRunningTrackSettings().deviceId;
    const automatic = document.createElement("option");
    automatic.value = "";
    automatic.textContent = "Rear camera (automatic)";
    elements.camera.replaceChildren(automatic);

    cameras.forEach((camera, index) => {
      const option = document.createElement("option");
      option.value = camera.id;
      option.textContent = camera.label?.trim() || `Camera ${index + 1}`;
      elements.camera.append(option);
    });

    if (activeDeviceId && cameras.some((camera) => camera.id === activeDeviceId)) {
      elements.camera.value = activeDeviceId;
    } else if (selectedCameraId && cameras.some((camera) => camera.id === selectedCameraId)) {
      elements.camera.value = selectedCameraId;
    } else {
      elements.camera.value = "";
    }
  } catch {
    // Camera selection is an enhancement; automatic rear-camera mode remains available.
  }
}

function acceptDecodedText(decodedText, activeScanner, activeSession) {
  if (!decodedText || !running || hasResult || activeScanner?.getState() !== 2
    || scanner !== activeScanner || sessionId !== activeSession) return;

  hasResult = true;
  elements.result.textContent = decodedText;
  elements.resultCard.hidden = false;
  stopBarcodeGuideTracking();
  stopGuidedZoomScanning();
  try {
    activeScanner.pause(true);
    elements.pausedScanButton.hidden = false;
    setControls();
    setStatus("Code 128 detected. Camera paused; scan again to resume.", "success");
    window.alert(`Code 128 detected:\n\n${decodedText}`);
  } catch (error) {
    elements.again.hidden = true;
    elements.pausedScanButton.hidden = true;
    setStatus(`Read ${decodedText}, but could not pause the preview: ${error?.message || "scanner error"}`, "error");
  }
}

async function stopCamera(message = "Camera stopped.") {
  stopBarcodeGuideTracking(true);
  stopGuidedZoomScanning();
  elements.pausedScanButton.hidden = true;
  if (stopPromise) return stopPromise;
  if (starting && !running) {
    stopRequested = true;
    pendingStopMessage = message;
    setControls();
    setStatus("Stopping after camera startup finishes…", "scanning");
    return;
  }

  stopRequested = true;
  stopping = true;
  const activeScanner = scanner;
  const shouldStop = activeScanner && (running || activeScanner.getState() === 2 || activeScanner.getState() === 3);
  running = false;
  setControls();
  stopPromise = (async () => {
    try {
      if (shouldStop) await activeScanner.stop();
    } catch (error) {
      // The scan may have ended during a simultaneous camera or page lifecycle event.
      console.debug("Scanner stop cleanup:", error);
    } finally {
      if (scanner === activeScanner) scanner = null;
      running = false;
      starting = false;
      stopRequested = false;
      stopping = false;
      stopPromise = null;
      elements.cameraTools.hidden = true;
      elements.zoomRange.disabled = true;
      elements.torch.disabled = true;
      elements.torch.textContent = "Flash unavailable";
      elements.torch.setAttribute("aria-pressed", "false");
      zoomFeature = null;
      torchFeature = null;
      torchEnabled = false;
      clearTimeout(zoomApplyTimer);
      zoomApplyTimer = null;
      pendingZoom = null;
      currentGuideBounds = null;
      setControls();
      if (message) setStatus(message, hasResult ? "success" : "idle");
    }
  })();
  return stopPromise;
}

async function startCamera() {
  if (starting || running || stopping) return;
  stopRequested = false;
  starting = true;
  hasResult = false;
  elements.pausedScanButton.hidden = true;
  elements.resultCard.hidden = true;
  elements.result.textContent = "";
  setControls();
  setStatus("Requesting camera permission…", "scanning");
  const currentSession = ++sessionId;
  const activeScanner = createCameraSession();
  scanner = activeScanner;

  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not support camera access.");
    const videoConstraints = {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      ...(selectedCameraId
        ? { deviceId: { exact: selectedCameraId } }
        : { facingMode: { ideal: "environment" } }),
    };
    activeScanner.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
    activeScanner.track = activeScanner.stream.getVideoTracks()[0];
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("aria-label", "Live camera preview");
    activeScanner.video = video;
    elements.reader.replaceChildren(video);
    video.srcObject = activeScanner.stream;
    await video.play();
    activeScanner.state = 2;
    starting = false;
    running = true;
    setControls();
    await Promise.allSettled([
      applyCameraQuality(activeScanner),
      refreshCameraChoices(activeScanner),
    ]);
    if (scanner !== activeScanner || !running) return;
    setupCameraTools(activeScanner);
    await resetCameraZoom();
    if (stopRequested) {
      await stopCamera(pendingStopMessage);
      return;
    }
    showFixedCenterGuide();
    startCenterPatternTracking(activeScanner);
    startGuidedZoomScanning(activeScanner, currentSession);
    setControls();
    setStatus("Scanning the center frame. Auto zoom increases when a barcode pattern is near the center.", "scanning");
  } catch (error) {
    await activeScanner.stop();
    starting = false;
    running = false;
    if (scanner === activeScanner) scanner = null;
    const wasStopRequested = stopRequested;
    stopRequested = false;
    setControls();
    setStatus(wasStopRequested ? pendingStopMessage : cameraErrorMessage(error), wasStopRequested ? "idle" : "error");
  }
}

async function scanAgain() {
  if (starting || stopping) return;
  if (scanner && scanner.getState() === 3) {
    try {
      await resetCameraZoom();
      await scanner.resume();
      hasResult = false;
      showFixedCenterGuide();
      startCenterPatternTracking(scanner);
      startGuidedZoomScanning(scanner, sessionId);
      elements.pausedScanButton.hidden = true;
      elements.resultCard.hidden = true;
      elements.result.textContent = "";
      setControls();
      setStatus("Scanning the center frame. Camera zoom resets and increases when a barcode pattern is near the center.", "scanning");
    } catch (error) {
      setStatus(error?.message || "Could not resume the camera. Press Start camera to retry.", "error");
    }
    return;
  }
  void startCamera();
}

async function changeCamera() {
  selectedCameraId = elements.camera.value;
  if (!running || starting || stopping) return;
  hasResult = false;
  elements.resultCard.hidden = true;
  elements.result.textContent = "";
  await stopCamera(null);
  await startCamera();
}

function scheduleZoomApply() {
  if (!zoomFeature || pendingZoom === null || zoomApplyTimer !== null) return;
  const delay = Math.max(0, 60 - (performance.now() - lastZoomApplyAt));
  zoomApplyTimer = setTimeout(() => {
    zoomApplyTimer = null;
    void applyPendingZoom();
  }, delay);
}

async function applyPendingZoom() {
  if (!zoomFeature || zoomApplyInProgress || pendingZoom === null) return;
  const activeZoomFeature = zoomFeature;
  const requestedZoom = pendingZoom;
  pendingZoom = null;
  zoomApplyInProgress = true;
  lastZoomApplyAt = performance.now();
  try {
    await activeZoomFeature.apply(requestedZoom);
    if (zoomFeature === activeZoomFeature && pendingZoom === null) {
      elements.cameraToolsHint.textContent = "Camera zoom updated.";
    }
  } catch {
    if (zoomFeature === activeZoomFeature && pendingZoom === null) {
      elements.cameraToolsHint.textContent = "This camera could not apply the selected zoom.";
    }
  } finally {
    zoomApplyInProgress = false;
    if (pendingZoom !== null) scheduleZoomApply();
  }
}

elements.zoomRange.addEventListener("input", () => {
  if (!zoomFeature) return;
  pendingZoom = Number(elements.zoomRange.value);
  elements.zoomValue.textContent = `${pendingZoom.toFixed(1)}×`;
  elements.cameraToolsHint.textContent = "Adjusting camera zoom…";
  scheduleZoomApply();
});

elements.torch.addEventListener("click", async () => {
  if (!torchFeature || elements.torch.disabled) return;
  elements.torch.disabled = true;
  try {
    await torchFeature.apply(!torchEnabled);
    torchEnabled = !torchEnabled;
    elements.torch.textContent = torchEnabled ? "Turn flash off" : "Turn flash on";
    elements.torch.setAttribute("aria-pressed", String(torchEnabled));
    elements.cameraToolsHint.textContent = torchEnabled ? "Camera flash is on." : "Camera flash is off.";
  } catch {
    elements.cameraToolsHint.textContent = "This camera could not change the flash setting.";
  } finally {
    elements.torch.disabled = !torchFeature;
  }
});

elements.autoZoom.addEventListener("click", () => {
  autoZoomEnabled = !autoZoomEnabled;
  elements.autoZoom.textContent = `Auto zoom: ${autoZoomEnabled ? "On" : "Off"}`;
  elements.autoZoom.setAttribute("aria-pressed", String(autoZoomEnabled));
  elements.cameraToolsHint.textContent = autoZoomEnabled
    ? "Auto zoom is on. It eases in more slowly at higher zoom levels."
    : "Auto zoom is off. Use the slider to adjust zoom manually.";
});

elements.start.addEventListener("click", () => void startCamera());
elements.stop.addEventListener("click", () => void stopCamera());
elements.again.addEventListener("click", scanAgain);
elements.pausedScanButton.addEventListener("click", scanAgain);
elements.camera.addEventListener("change", () => void changeCamera());
window.addEventListener("pagehide", () => {
  void stopCamera(null);
  disposeGuideScanLoop();
});

setControls();
