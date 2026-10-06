// Runtime measurements only: no persistence or conversation content.
export class TransferStats {
  /** @param {number} total @param {number} [now] */
  constructor(total, now = performance.now()) {
    this.total = total;
    this.at = now;
    this.bytes = 0;
    this.rate = 0;
    this.samples = 0;
  }
  /** @param {number} bytes @param {number} [now] */
  update(bytes, now = performance.now()) {
    const elapsed = now - this.at;
    if (!Number.isFinite(bytes) || elapsed < 250) return;
    if (bytes < this.bytes) { this.at = now; this.bytes = bytes; this.rate = 0; this.samples = 0; return; }
    const rate = (bytes - this.bytes) * 1000 / elapsed;
    this.rate = this.samples ? .3 * rate + .7 * this.rate : rate;
    this.samples++;
    this.at = now;
    this.bytes = bytes;
  }
  /** @param {number} [now] */
  estimate(now = performance.now()) {
    if (this.samples < 2 || this.rate <= 0 || this.bytes >= this.total || now - this.at > 3000) return null;
    return { bytesPerSecond: this.rate, secondsRemaining: (this.total - this.bytes) / this.rate };
  }
}

/** Aim for half a second queued, bounded to avoid memory spikes.
 * @param {number} bytesPerSecond */
export function bufferLimit(bytesPerSecond) {
  return Math.round(Math.max(256 * 1024, Math.min(8 * 1024 * 1024,
    Number.isFinite(bytesPerSecond) && bytesPerSecond > 0 ? bytesPerSecond * .5 : 1024 * 1024)));
}
