# html5-qrcode Code 128 test

An isolated Code 128 scanner using three local decoders on the same camera crop: [`html5-qrcode`](https://github.com/mebjas/html5-qrcode), [ZBar WASM](https://github.com/undecaf/zbar-wasm), and the browser's native `BarcodeDetector` when available. It prefers the rear camera and shows a green scan frame and result panel. Scanning runs in the browser; barcode images are not sent to a server.

## Run locally

```sh
npm install
npm run dev
```

Open the localhost URL printed by Vite. On a phone, camera access requires an HTTPS address; a plain HTTP LAN address does not satisfy the browser's secure-context requirement. Deploy this folder as a separate Vercel project to test from a phone over HTTPS.

Press **Start camera** and allow camera access. The page requests a rear camera, prefers 1080p when supported, and asks for continuous autofocus when the active camera reports support. Use **Camera lens** to choose another listed device if the automatic rear camera is blurry; hardware names and focus controls vary by phone. A successful read pauses the preview and displays the decoded text in the green panel and a popup. Use **Scan another** to resume the same camera session without reopening camera permission. Press **Stop** to fully release the camera.

Scanning is center-only. Each captured crop is sent concurrently to html5-qrcode, ZBar WASM, and native BarcodeDetector when supported by the browser. A result is accepted when two engines agree on the same Code 128 value in one frame, or one engine returns the same value in three consecutive frames. If the native API is unavailable, html5-qrcode and ZBar still run. A separate local pattern check watches for barcode-like lines near the center; when it sees them, the app gradually increases the camera's actual zoom, if the device supports camera zoom. It keeps scanning at maximum zoom until a barcode is read. **Scan another** resets zoom to the camera's minimum before resuming. The full frame is not passed to a barcode decoder, and no image is uploaded.

## Notes

- This is a scanner library comparison only; it does not verify membership.
- html5-qrcode uses ZXing-js internally, so ZBar and native detection provide the additional decoder engines.
- Native `BarcodeDetector` support varies by browser. It is checked at runtime and skipped when Code 128 is unavailable.
- ZBar WASM is licensed LGPL-2.1+; review the license before reusing this prototype in a distributed product.
- Camera focus, scan speed, and decode reliability still need testing on the actual ID card and phone. `npm run build` checks compilation but cannot test physical camera behavior.
