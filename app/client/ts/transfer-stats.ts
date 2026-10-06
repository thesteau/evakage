// Runtime measurements only: no persistence or conversation content.
export class TransferStats {
  total: number;
  at: number;
  bytes: number;
  rate: number;
  samples: number;

  constructor(total: number, now: number = performance.now()) {
    this.total = total;
    this.at = now;
    this.bytes = 0;
    this.rate = 0;
    this.samples = 0;
  }

  update(bytes: number, now: number = performance.now()) {
    const elapsed = now - this.at;
    if (!Number.isFinite(bytes) || elapsed < 250) return;
    if (bytes < this.bytes) {
      this.at = now;
      this.bytes = bytes;
      this.rate = 0;
      this.samples = 0;
      return;
    }
    const rate = ((bytes - this.bytes) * 1000) / elapsed;
    this.rate = this.samples ? 0.3 * rate + 0.7 * this.rate : rate;
    this.samples++;
    this.at = now;
    this.bytes = bytes;
  }

  estimate(now: number = performance.now()) {
    if (this.samples < 2 || this.rate <= 0 || this.bytes >= this.total || now - this.at > 3000)
      {return null;}
    return { bytesPerSecond: this.rate, secondsRemaining: (this.total - this.bytes) / this.rate };
  }
}

/** Aim for half a second queued, bounded to avoid memory spikes. */
export function bufferLimit(bytesPerSecond: number) {
  return Math.round(
    Math.max(
      256 * 1024,
      Math.min(
        8 * 1024 * 1024,
        Number.isFinite(bytesPerSecond) && bytesPerSecond > 0 ? bytesPerSecond * 0.5 : 1024 * 1024,
      ),
    ),
  );
}
