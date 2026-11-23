import jsQR from 'jsqr';
import QRCode from 'qrcode';

export interface RgbaImage {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** Electron bitmaps are BGRA; jsQR expects RGBA. */
export function bgraToRgba(bitmap: Uint8Array, width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(bitmap.length);
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
    data[offset] = bitmap[offset + 2] ?? 0;
    data[offset + 1] = bitmap[offset + 1] ?? 0;
    data[offset + 2] = bitmap[offset] ?? 0;
    data[offset + 3] = bitmap[offset + 3] ?? 255;
  }
  return { data, width, height };
}

export function decodeQr(image: RgbaImage): string | null {
  if (image.width === 0 || image.height === 0) return null;
  return jsQR(image.data, image.width, image.height)?.data ?? null;
}

/** Renders text as a QR code (`pass show --qrcode`), as a PNG data URL. */
export function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 280 });
}

/** Module matrix of a QR code, used by tests to rasterise codes without a canvas. */
export function qrMatrix(text: string): { size: number; dark: (x: number, y: number) => boolean } {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  return { size: modules.size, dark: (x, y) => modules.get(y, x) !== 0 };
}
