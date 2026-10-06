import qrcode from '../assets/vendor/qrcode.mjs';

export function qrMatrix(text: string) {
  if (!text || text.length > 2048) throw new Error('QR content is too long.');
  const qr = qrcode(0, 'M');
  // QR payloads are ASCII URLs/codes; percent encoding makes non-ASCII paths safe.
  qr.addData(text, 'Byte');
  qr.make();
  return Array.from({ length: qr.getModuleCount() }, (_, row) =>
    Array.from({ length: qr.getModuleCount() }, (_, col) => qr.isDark(row, col)),
  );
}

export function drawQr(canvas: HTMLCanvasElement, text: string) {
  const matrix = qrMatrix(text);
  const scale = 6;
  const margin = 4;
  const size = (matrix.length + margin * 2) * scale;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
    }),
  );
}
