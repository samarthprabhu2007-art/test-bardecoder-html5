import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from "@zxing/library";

const reader = new MultiFormatReader();
reader.setHints(new Map([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128]],
]));

self.addEventListener("message", (event) => {
  const { id, width, height, pixels } = event.data;
  let text = null;
  try {
    const luminance = new RGBLuminanceSource(new Uint8ClampedArray(pixels), width, height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(luminance));
    text = reader.decodeWithState(bitmap).getText();
  } catch {
    // No Code 128 barcode in this zoom variant is a normal result.
  }
  self.postMessage({ id, text });
});
