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

const scanner = new Html5Qrcode("reader", {
  formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128],
  verbose: false,
});
let starting = false;
let running = false;
let stopping = false;
let stopRequested = false;
let hasResult = false;

function setStatus(message, kind = "idle") {
  elements.status.textContent = message;
  elements.statusRow.className = `status-row status-${kind}`;
}

function setControls() {
  elements.start.disabled = starting || running;
  elements.stop.disabled = !starting && !running;
  elements.again.hidden = running || starting || !hasResult;
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
  if (stopping) return;
  stopRequested = true;
  stopping = true;
  const shouldStop = running || scanner.getState() === 2;
  running = false;
  starting = false;
  setControls();
  try {
    if (shouldStop) await scanner.stop();
  } catch (error) {
    // The scan may have ended during a simultaneous camera or page lifecycle event.
    console.debug("Scanner stop cleanup:", error);
  } finally {
    stopping = false;
    setControls();
    if (message) setStatus(message, hasResult ? "success" : "idle");
  }
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

  try {
    await scanner.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: (width, height) => ({
          width: Math.max(180, Math.floor(Math.min(width * 0.9, 560))),
          height: Math.max(90, Math.floor(Math.min(height * 0.36, 190))),
        }),
        aspectRatio: 16 / 9,
        disableFlip: true,
      },
      async (decodedText) => {
        if (!running || hasResult) return;
        hasResult = true;
        elements.result.textContent = decodedText;
        elements.resultCard.hidden = false;
        setStatus("Code 128 detected. Camera stopped.", "success");
        await stopCamera(null);
      },
      () => {
        // No barcode in this frame is normal while scanning.
      },
    );
    if (stopRequested) {
      await scanner.stop();
      starting = false;
      running = false;
      setControls();
      return;
    }
    starting = false;
    running = true;
    setControls();
    setStatus("Scanning. Hold the barcode inside the green frame.", "scanning");
  } catch (error) {
    starting = false;
    running = false;
    setControls();
    setStatus(cameraErrorMessage(error), "error");
  }
}

elements.start.addEventListener("click", () => void startCamera());
elements.stop.addEventListener("click", () => void stopCamera());
elements.again.addEventListener("click", () => void startCamera());
window.addEventListener("pagehide", () => void stopCamera(null));

setControls();
