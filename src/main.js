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

function setupCameraTools(activeScanner) {
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

async function stopCamera(message = "Camera stopped.") {
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
        if (!running || hasResult || activeScanner.getState() !== 2 || scanner !== activeScanner || sessionId !== currentSession) return;
        hasResult = true;
        elements.result.textContent = decodedText;
        elements.resultCard.hidden = false;
        try {
          activeScanner.pause(true);
          setControls();
          setStatus("Code 128 detected. Camera paused; scan again to resume.", "success");
          window.alert(`Code 128 detected:\n\n${decodedText}`);
        } catch (error) {
          elements.again.hidden = true;
          setStatus(`Read ${decodedText}, but could not pause the preview: ${error?.message || "scanner error"}`, "error");
        }
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
    hasResult = false;
    elements.resultCard.hidden = true;
    elements.result.textContent = "";
    try {
      scanner.resume();
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

elements.zoomRange.addEventListener("input", async () => {
  if (!zoomFeature) return;
  const requestedZoom = Number(elements.zoomRange.value);
  elements.zoomValue.textContent = `${requestedZoom.toFixed(1)}×`;
  try {
    await zoomFeature.apply(requestedZoom);
    elements.cameraToolsHint.textContent = "Camera zoom updated.";
  } catch {
    elements.cameraToolsHint.textContent = "This camera could not apply the selected zoom.";
  }
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
elements.camera.addEventListener("change", () => void changeCamera());
window.addEventListener("pagehide", () => void stopCamera(null));

setControls();
