// Pure parsing boundary for decrypted peer frames. No conversation mutation.
export const CONTROL_KIND = 1;
export const FILE_CHUNK_KIND = 2;
const decoder = new TextDecoder();

export function parseFrame(
  frame: Uint8Array<ArrayBuffer>,
  limits: { controlBytes: number; chunkBytes: number; fileChunks: number },
) {
  if (!frame.length) return null;
  if (frame[0] === CONTROL_KIND) {
    if (frame.length > limits.controlBytes) return null;
    const message = parseObject(frame.subarray(1));
    return message ? { kind: 'control', message } : null;
  }
  if (frame[0] !== FILE_CHUNK_KIND || frame.length < 5) return null;
  const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1);
  if (headerLength < 2 || headerLength > limits.controlBytes || headerLength > frame.length - 5)
    {return null;}
  const header = parseObject(frame.subarray(5, 5 + headerLength));
  if (
    !header ||
    typeof header.id !== 'string' ||
    !header.id ||
    typeof header.conv !== 'string' ||
    !Number.isInteger(header.seq) ||
    !Number.isInteger(header.total) ||
    header.total < 1 ||
    header.total > limits.fileChunks ||
    header.seq < 0 ||
    header.seq >= header.total
  )
    {return null;}
  const bytes = frame.subarray(5 + headerLength);
  if (bytes.length > limits.chunkBytes) return null;
  return { kind: 'chunk', header, bytes };
}

function parseObject(bytes: Uint8Array) {
  try {
    const value = JSON.parse(decoder.decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
