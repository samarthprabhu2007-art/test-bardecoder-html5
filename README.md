# html5-qrcode Code 128 test

An isolated scanner comparison page using [`html5-qrcode`](https://github.com/mebjas/html5-qrcode). It only enables Code 128 decoding, prefers the rear camera, and shows a green scan frame and result panel. Scanning runs in the browser; barcode images are not sent to a server.

## Run locally

```sh
npm install
npm run dev
```

Open the localhost URL printed by Vite. On a phone, camera access requires an HTTPS address; a plain HTTP LAN address does not satisfy the browser's secure-context requirement. Deploy this folder as a separate Vercel project to test from a phone over HTTPS.

Press **Start camera** and allow camera access. The page requests a rear camera, prefers 1080p when supported, and asks for continuous autofocus when the active camera reports support. Use **Camera lens** to choose another listed device if the automatic rear camera is blurry; hardware names and focus controls vary by phone. A successful read pauses the preview and displays the decoded text in the green panel and a popup. Use **Scan another** to resume the same camera session without reopening camera permission. Press **Stop** to fully release the camera.

Scanning is center-only. html5-qrcode repeatedly decodes a crop of the fixed green center frame. A separate local pattern check watches for barcode-like lines near the center; when it sees them, the app gradually increases the camera's actual zoom, if the device supports camera zoom. It keeps scanning at maximum zoom until a barcode is read. **Scan another** resets zoom to the camera's minimum before resuming. The full frame is not passed to a barcode decoder, and no image is uploaded.

## Notes

- This is a scanner library comparison only; it does not verify membership.
- The repository says html5-qrcode is in maintenance mode and its supported barcode decoding uses ZXing-js. This test intentionally replaces the camera/scanning loop from the other test folder without changing that project.
- Camera focus, scan speed, and decode reliability still need testing on the actual ID card and phone. `npm run build` checks compilation but cannot test physical camera behavior.
