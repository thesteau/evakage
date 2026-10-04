import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { qrMatrix } from '../public/qr.js';

for (const text of ['ABCD-EFGH', 'https://drop.example.test/', 'https://drop.example.test/%E2%9C%93']) {
  test(`QR decoder round trip: ${text}`, () => {
    const matrix = qrMatrix(text);
    const scale = 6;
    const size = (matrix.length + 8) * scale;
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
    matrix.forEach((row, y) => row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) {for (let dx = 0; dx < scale; dx++) {
        const at = (((y + 4) * scale + dy) * size + (x + 4) * scale + dx) * 4;
        pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
      }}
    }));
    assert.equal(jsQR(pixels, size, size)?.data, text);
  });
}
