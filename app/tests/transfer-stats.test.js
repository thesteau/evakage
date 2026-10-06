import test from 'node:test';
import assert from 'node:assert/strict';
import { TransferStats, bufferLimit } from '../public/transfer-stats.js';

test('transfer estimates wait for samples, smooth changes, and expire when stalled', () => {
  const stats = new TransferStats(10000, 0);
  stats.update(1000, 1000);
  assert.equal(stats.estimate(1000), null);
  stats.update(2000, 2000);
  assert.deepEqual(stats.estimate(2000), { bytesPerSecond: 1000, secondsRemaining: 8 });
  stats.update(4000, 3000);
  assert.equal(stats.estimate(3000)?.bytesPerSecond, 1300);
  assert.equal(stats.estimate(6100), null);
  stats.update(10000, 7000);
  assert.equal(stats.estimate(7000), null);
});

test('restarted and zero-byte transfers do not reuse an old estimate', () => {
  const stats = new TransferStats(10000, 0);
  stats.update(1000, 1000); stats.update(2000, 2000);
  stats.update(0, 3000);
  assert.equal(stats.estimate(3000), null);
  stats.update(1000, 4000); stats.update(2000, 5000);
  assert.equal(stats.estimate(5000)?.secondsRemaining, 8);
  assert.equal(new TransferStats(0, 0).estimate(1000), null);
});

test('buffer limits follow measured throughput and remain bounded', () => {
  assert.equal(bufferLimit(0), 1024 * 1024);
  assert.equal(bufferLimit(NaN), 1024 * 1024);
  assert.equal(bufferLimit(1000), 256 * 1024);
  assert.equal(bufferLimit(4 * 1024 * 1024), 2 * 1024 * 1024);
  assert.equal(bufferLimit(100 * 1024 * 1024), 8 * 1024 * 1024);
});
