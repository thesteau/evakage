# Relay memory and hashing measurement — 2026-10-04

Run `node --expose-gc benchmarks/relay.mjs buffered 64` and repeat with
`chunked 64`, `buffered 128`, `chunked 128`. Each command uses an isolated Node
process, a resident source Blob, WebCrypto AES-GCM and 256 KiB chunks. The buffered
mode collects ciphertext parts; chunked mode consumes only the current part.
Samples force GC equally in both encryption modes to measure retained buffers.
Timings include this measurement overhead and are not production throughput.
Hash timing uses the unchanged 64 KiB pre-hash pass without forced GC per chunk.

Local environment: Node v24.14.0, Windows x64. Source memory is excluded from the
post-hash encryption baseline; RSS includes allocator behavior, not just live
payloads. Buffer counters are sampled/rounded and are not mobile-browser bounds.

| Source | Mode | Pre-hash | Encryption with measurement overhead | Peak additional array buffers | Peak additional RSS |
| --- | --- | --- | --- | --- | --- |
| 64 MiB | Buffered | 389 ms | 326 ms | 39 MiB | 41 MiB |
| 64 MiB | Chunked | 394 ms | 672 ms | rounded 0 MiB | rounded 0 MiB |
| 128 MiB | Buffered | 778 ms | 765 ms | 116 MiB | 119 MiB |
| 128 MiB | Chunked | 804 ms | 1425 ms | rounded 0 MiB | rounded 0 MiB |

Both modes produced identical plaintext digests and ciphertext lengths. The
chunked generator retains no full ciphertext body and each HTTP request is at
most 256 KiB + 28 bytes. Restart retains the in-memory source but creates a
fresh server item and key, then sends from byte zero. The user-selected source itself remains
resident/managed by the browser; this is not a guarantee that total phone RAM is
flat or that huge files are supported.

The pre-hash pass costs about 0.8 seconds for 128 MiB in this local sample.
Retain it: the digest must accompany signed metadata before delivery, and removing
it would require a finalize protocol or change the receiver's integrity gate.
No transport redesign is justified by this desktop sample alone.

Receivers verify the final hash before offering Save. Where the browser can
stream a save, they no longer retain the plaintext to do so; see below.

## Two-pass receiving

A relayed file is received in two passes when a service worker controls the page:

1. **Verify pass** (on receipt). Fetch, authenticate and decrypt every chunk, check
   the signed whole-file SHA-256, and keep only a SHA-256 per 256 KiB chunk
   (32 bytes each, 1/8192 of the file size). The plaintext is discarded and the
   server item is *not* released. Save is offered only after this pass succeeds.
2. **Save pass** (on Save). Claim the item again and fetch the same body. Each
   decrypted chunk must match its verify-pass digest before it is handed on, and
   the last chunk is held until the whole-file digest matches again. Chunks go
   to a service-worker response with `Content-Disposition: attachment`, pulled
   one at a time as the browser writes them (`public/savestream.js`, `public/sw.js`).
   Any mismatch, truncation, extra bytes or sender revocation errors that
   response, so the browser fails the download instead of completing it. The
   server item is released only after a completed save.

Nothing touches Cache Storage, IndexedDB or other staging storage; the only disk
write is the browser's own download. The trade-offs are deliberate: the body is
downloaded twice; Save needs the server copy, so an item that expires between
the passes shows **Gone** and cannot be saved; and a saved relayed file is not
kept for a second Save or for serving to peers. Without a controlling service
worker, the earlier single-pass path is used: plaintext stays in memory until
Save and the item is released at once. If the worker cannot take a save, Save
falls back to the same verified second pass collected in memory.

The browser engines differ in how a failed streamed download ends. Measured with
Playwright 1.63: Chromium cancels it, WebKit fails it, and Firefox never completes
it (its driver reports neither a file nor a failure). None produces a completed
file. A Firefox download stalled this way may remain listed in its downloads panel;
that UI is not observable in these tests.

## Receiving measurement

Run `node --expose-gc benchmarks/receive.mjs 64 single` and `two-pass`, then
repeat with `128`. Both modes run the production decryptor over authenticated
256 KiB chunks and check the final digest. The save pass consumes and discards
verified chunks as a disk write would. Encryption supplies a chunk at a time;
source Blob memory is excluded from the baseline. Per-chunk GC is used only for
measurement. Node v24.14.0, Windows x64, measured 2026-10-04:

| File | Mode | Retained after verify | Peak additional RSS | Verify pass | Save pass |
| --- | --- | ---: | ---: | ---: | ---: |
| 64 MiB | Single pass | 64 MiB | 69 MiB | 783 ms | — |
| 128 MiB | Single pass | 128 MiB | 133 MiB | 1423 ms | — |
| 64 MiB | Two-pass | 8 KiB digests | 6 MiB | 897 ms | 886 ms |
| 128 MiB | Two-pass | 16 KiB digests | 7 MiB | 1741 ms | 1472 ms |

All runs verified the expected complete SHA-256 and byte count. Node's
`arrayBuffers` counter does not account for all live WebCrypto plaintext, so
RSS is the meaningful column. Two-pass peak RSS stays flat as the file doubles,
apart from the digest list. These are Node measurements of the decrypt/verify
code, not phone bounds. Browser memory, including the service worker and the
download pipeline, was not measured.
