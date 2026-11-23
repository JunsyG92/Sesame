import { describe, expect, it } from 'vitest';
import { bgraToRgba, decodeQr, qrDataUrl, qrMatrix, type RgbaImage } from '../../../src/main/qr';

/** Rasterises a QR code into an RGBA image (4 px per module, quiet zone). */
export function renderQr(text: string, scale = 4, margin = 4): RgbaImage {
  const { size, dark } = qrMatrix(text);
  const width = (size + margin * 2) * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!dark(x, y)) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const offset = (((y + margin) * scale + dy) * width + (x + margin) * scale + dx) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
        }
      }
    }
  }
  return { data, width, height: width };
}

describe('qr', () => {
  const uri = 'otpauth://totp/Example:alice?secret=GEZDGNBVGY3TQOJQ&issuer=Example';

  it('round-trips a QR code', () => {
    expect(decodeQr(renderQr(uri))).toBe(uri);
    expect(decodeQr({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toBeNull();
    expect(
      decodeQr({ data: new Uint8ClampedArray(400).fill(255), width: 10, height: 10 }),
    ).toBeNull();
  });

  it('converts BGRA bitmaps', () => {
    const image = bgraToRgba(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 2, 1);
    expect([...image.data]).toEqual([3, 2, 1, 4, 7, 6, 5, 8]);
    expect(image.width).toBe(2);
  });

  it('renders PNG data URLs', async () => {
    expect(await qrDataUrl(uri)).toMatch(/^data:image\/png;base64,/);
  });
});
