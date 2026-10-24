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

function setStatus(message, kind = "idle") {
  elements.status.textContent = message;
  elements.statusRow.className = `status-row status-${kind}`;
}

function setControls() {
  elements.start.disabled = starting || running || stopping;
  elements.stop.disabled = (!starting && !running) || stopping || stopRequested;
  elements.again.hidden = starting || stopping || !hasResult;
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
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: (width, height) => ({
          width: Math.max(180, Math.floor(Math.min(width * 0.94, 600))),
          height: Math.max(70, Math.floor(Math.min(height * 0.18, 120))),
        }),
        aspectRatio: 16 / 9,
        disableFlip: true,
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

elements.start.addEventListener("click", () => void startCamera());
elements.stop.addEventListener("click", () => void stopCamera());
elements.again.addEventListener("click", scanAgain);
window.addEventListener("pagehide", () => void stopCamera(null));

setControls();
