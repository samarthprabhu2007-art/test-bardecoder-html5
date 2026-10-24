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
  torch: document.querySelector("#torchButton"),
  cameraToolsHint: document.querySelector("#cameraToolsHint"),
  pausedScanButton: document.querySelector("#pausedScanButton"),
  barcodeGuide: document.querySelector("#barcodeGuide"),
  guideModeButton: document.querySelector("#guideModeButton"),
  guideModeHint: document.querySelector("#guideModeHint"),
};

function createScanner() {
  return new Html5Qrcode("reader", {
    formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128],
    verbose: false,
  });
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
let guideTrackingId = 0;
let guideTimer = null;
let guideMode = "auto";
let currentGuideBounds = null;
let guidedScanId = 0;
let guidedScanTimer = null;
let guidedScanBusy = false;
let guidedWorkers = [];
let guidedJobSequence = 0;
const guidedZoomFactors = [1, 1.4, 1.8];
const guidedCanvases = guidedZoomFactors.map(() => {
  const canvas = document.createElement("canvas");
  return { canvas, context: canvas.getContext("2d", { willReadFrequently: true }) };
});
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
  elements.guideModeButton.disabled = !running || starting || stopping;
}

function updateGuideModeControl() {
  const isFixed = guideMode === "fixed";
  elements.guideModeButton.textContent = isFixed
    ? "Guide: Fixed center · tap to auto-follow"
    : "Guide: Auto-follow · tap to lock center";
  elements.guideModeButton.setAttribute("aria-pressed", String(isFixed));
  elements.guideModeHint.textContent = isFixed
    ? "Guide is locked at center. Guided zoom checks this area while the existing scanner keeps running."
    : "Auto-follow is on. Guided zoom checks the framed area while the existing center scanner keeps running.";
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

  // Add generous quiet-zone padding around the detected bars for the guide.
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

const CENTER_GUIDE_BOUNDS = { left: 0.03, top: 0.34, right: 0.97, bottom: 0.66 };

function showFixedCenterGuide() {
  const video = elements.reader.querySelector("video");
  if (!video?.videoWidth || !video.videoHeight) return;
  elements.barcodeGuide.hidden = false;
  placeBarcodeGuide(video, CENTER_GUIDE_BOUNDS, "FIXED CENTER", false);
}

function startBarcodeGuideTracking() {
  if (guideMode !== "auto") return;
  stopBarcodeGuideTracking(true);
  const trackingId = guideTrackingId;
  elements.barcodeGuide.hidden = false;
  elements.barcodeGuide.style.left = "3%";
  elements.barcodeGuide.style.top = "34%";
  elements.barcodeGuide.style.width = "94%";
  elements.barcodeGuide.style.height = "32%";
  elements.barcodeGuide.querySelector("span").textContent = "SEARCHING FOR BARCODE";
  const video = elements.reader.querySelector("video");

  const scanFrame = () => {
    if (trackingId !== guideTrackingId || !running || !video?.isConnected) return;
    try {
      const pattern = findBarcodePattern(video);
      if (pattern) placeBarcodeGuide(video, pattern);
    } catch {
      // Keep the last guide position if a frame is not ready for analysis.
    }
    guideTimer = setTimeout(scanFrame, 180);
  };
  scanFrame();
}

function ensureGuidedWorkers() {
  if (guidedWorkers.length) return guidedWorkers.some((slot) => !slot.failed);
  if (typeof Worker === "undefined") return false;

  const createdWorkers = [];
  try {
    for (const _scale of guidedZoomFactors) {
      const worker = new Worker(new URL("./barcode-zoom-worker.js", import.meta.url), { type: "module" });
      const slot = { worker, pending: null, failed: false };
      worker.addEventListener("message", (event) => {
        if (!slot.pending || event.data.id !== slot.pending.id) return;
        const { resolve } = slot.pending;
        slot.pending = null;
        resolve(event.data.text || null);
      });
      worker.addEventListener("error", () => {
        slot.failed = true;
        if (slot.pending) {
          slot.pending.resolve(null);
          slot.pending = null;
        }
      });
      createdWorkers.push(slot);
    }
    guidedWorkers = createdWorkers;
    return true;
  } catch {
    createdWorkers.forEach(({ worker }) => worker.terminate());
    guidedWorkers = [];
    return false;
  }
}

function sendGuidedVariant(slot, imageData, width, height) {
  if (slot.failed || slot.pending) return Promise.resolve(null);
  const id = ++guidedJobSequence;
  return new Promise((resolve) => {
    slot.pending = { id, resolve };
    try {
      slot.worker.postMessage({ id, width, height, pixels: imageData.data.buffer }, [imageData.data.buffer]);
    } catch {
      slot.pending = null;
      resolve(null);
    }
  });
}

async function decodeGuideAtMultipleScales(video, bounds, activeScanner, activeSession) {
  if (!ensureGuidedWorkers() || !video.videoWidth || !video.videoHeight) return;
  const sourceLeft = Math.max(0, Math.floor(bounds.left * video.videoWidth));
  const sourceTop = Math.max(0, Math.floor(bounds.top * video.videoHeight));
  const sourceRight = Math.min(video.videoWidth, Math.ceil(bounds.right * video.videoWidth));
  const sourceBottom = Math.min(video.videoHeight, Math.ceil(bounds.bottom * video.videoHeight));
  const sourceWidth = sourceRight - sourceLeft;
  const sourceHeight = sourceBottom - sourceTop;
  if (sourceWidth < 8 || sourceHeight < 4) return;

  const variants = [];
  const usedWidths = new Set();
  for (let index = 0; index < guidedZoomFactors.length; index += 1) {
    const slot = guidedWorkers[index];
    const surface = guidedCanvases[index];
    if (!slot || slot.failed || !surface.context) continue;
    const outputWidth = Math.min(1920, Math.round(sourceWidth * guidedZoomFactors[index]));
    if (outputWidth < 1 || usedWidths.has(outputWidth)) continue;
    usedWidths.add(outputWidth);
    const outputHeight = Math.max(1, Math.round(sourceHeight * outputWidth / sourceWidth));
    surface.canvas.width = outputWidth;
    surface.canvas.height = outputHeight;
    surface.context.drawImage(video, sourceLeft, sourceTop, sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
    const imageData = surface.context.getImageData(0, 0, outputWidth, outputHeight);
    variants.push(sendGuidedVariant(slot, imageData, outputWidth, outputHeight));
  }

  await Promise.all(variants.map(async (variant) => {
    const decodedText = await variant;
    if (decodedText && running && !hasResult && scanner === activeScanner && sessionId === activeSession) {
      acceptDecodedText(decodedText, activeScanner, activeSession);
    }
  }));
}

function stopGuidedZoomScanning() {
  guidedScanId += 1;
  clearTimeout(guidedScanTimer);
  guidedScanTimer = null;
}

function disposeGuidedWorkers() {
  stopGuidedZoomScanning();
  for (const slot of guidedWorkers) {
    slot.worker.terminate();
    slot.pending?.resolve(null);
  }
  guidedWorkers = [];
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
      await decodeGuideAtMultipleScales(video, { ...currentGuideBounds }, activeScanner, activeSession);
    } catch {
      // The original live scanner stays active if a background crop cannot be processed.
    } finally {
      guidedScanBusy = false;
    }

    if (scanId === guidedScanId && running && !hasResult) {
      guidedScanTimer = setTimeout(scanFrame, 120);
    }
  };
  void scanFrame();
}

function applyGuideMode() {
  updateGuideModeControl();
  if (!running) return;
  if (guideMode === "fixed") {
    stopBarcodeGuideTracking(true);
    showFixedCenterGuide();
  } else {
    currentGuideBounds = null;
    startBarcodeGuideTracking();
  }
  startGuidedZoomScanning();
}

function setupCameraTools(activeScanner) {
  clearTimeout(zoomApplyTimer);
  zoomApplyTimer = null;
  pendingZoom = null;
  zoomApplyInProgress = false;
  lastZoomApplyAt = 0;
  elements.cameraTools.hidden = false;
  elements.cameraToolsHint.textContent = "Zoom and flash depend on the selected camera.";
  zoomFeature = null;
  torchFeature = null;
  torchEnabled = false;
  elements.torch.setAttribute("aria-pressed", "false");
  elements.torch.textContent = "Flash unavailable";

  try {
    const cameraCapabilities = activeScanner.getRunningTrackCameraCapabilities();
    const trackCapabilities = activeScanner.getRunningTrackCapabilities();
    const zoom = cameraCapabilities.zoomFeature();
    if (zoom.isSupported()) {
      const min = zoom.min();
      const max = zoom.max();
      const step = zoom.step();
      zoomFeature = zoom;
      elements.zoomRange.min = String(min);
      elements.zoomRange.max = String(max);
      elements.zoomRange.step = String(step > 0 ? step : 0.1);
      const current = zoom.value();
      elements.zoomRange.value = String(current ?? min);
      elements.zoomRange.disabled = max <= min;
      elements.zoomValue.textContent = `${Number(elements.zoomRange.value).toFixed(1)}×`;
    } else {
      elements.zoomRange.disabled = true;
      elements.zoomValue.textContent = "Unavailable";
    }

    const torch = cameraCapabilities.torchFeature();
    if (torch.isSupported() && trackCapabilities.torch === true) {
      torchFeature = torch;
      torchEnabled = torch.value() === true;
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

    await activeScanner.applyVideoConstraints(constraints);
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
      guideMode = "auto";
      currentGuideBounds = null;
      updateGuideModeControl();
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
  const activeScanner = createScanner();
  scanner = activeScanner;

  try {
    await activeScanner.start(
      selectedCameraId || { facingMode: "environment" },
      {
        fps: 10,
        // Taller scan box so the camera can autofocus on the barcode.
        // Narrow/flat boxes cause the autofocus to hunt or lock on background.
        qrbox: (width, height) => ({
          width: Math.max(220, Math.floor(Math.min(width * 0.94, 640))),
          height: Math.max(130, Math.floor(Math.min(height * 0.32, 200))),
        }),
        // Allow flip – disableFlip: true blocks scanning on some Android rear cameras.
        disableFlip: false,
      },
      async (decodedText) => {
        acceptDecodedText(decodedText, activeScanner, currentSession);
      },
      () => {
        // No barcode in this frame is normal while scanning.
      },
    );
    starting = false;
    running = true;
    setControls();
    await Promise.allSettled([
      applyCameraQuality(activeScanner),
      refreshCameraChoices(activeScanner),
    ]);
    if (scanner !== activeScanner || !running) return;
    if (activeScanner.getState() === 2) {
      if (guideMode === "fixed") showFixedCenterGuide();
      else startBarcodeGuideTracking();
      startGuidedZoomScanning(activeScanner, currentSession);
    }
    setupCameraTools(activeScanner);
    if (stopRequested) {
      await stopCamera(pendingStopMessage);
      return;
    }
    setControls();
    setStatus("Scanning. Hold the barcode inside the green frame.", "scanning");
  } catch (error) {
    starting = false;
    running = false;
    if (scanner === activeScanner) scanner = null;
    const wasStopRequested = stopRequested;
    stopRequested = false;
    setControls();
    setStatus(wasStopRequested ? pendingStopMessage : cameraErrorMessage(error), wasStopRequested ? "idle" : "error");
  }
}

function scanAgain() {
  if (starting || stopping) return;
  if (scanner && scanner.getState() === 3) {
    try {
      scanner.resume();
      hasResult = false;
      if (guideMode === "fixed") showFixedCenterGuide();
      else startBarcodeGuideTracking();
      startGuidedZoomScanning(scanner, sessionId);
      elements.pausedScanButton.hidden = true;
      elements.resultCard.hidden = true;
      elements.result.textContent = "";
      setControls();
      setStatus("Scanning again. Hold the barcode inside the green frame.", "scanning");
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

elements.start.addEventListener("click", () => void startCamera());
elements.stop.addEventListener("click", () => void stopCamera());
elements.again.addEventListener("click", scanAgain);
elements.pausedScanButton.addEventListener("click", scanAgain);
elements.guideModeButton.addEventListener("click", () => {
  if (!running || starting || stopping) return;
  guideMode = guideMode === "auto" ? "fixed" : "auto";
  applyGuideMode();
});
elements.camera.addEventListener("change", () => void changeCamera());
window.addEventListener("pagehide", () => {
  void stopCamera(null);
  disposeGuidedWorkers();
});

updateGuideModeControl();
setControls();
