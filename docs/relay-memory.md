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

Receivers still retain authenticated plaintext chunks and verify the final hash
before offering Save. Streaming to disk before the final hash has not been enabled;
that behavior changes the integrity guarantee and has not been approved.

## Receiving measurement

Run `node --expose-gc benchmarks/receive.mjs 64` and repeat with `128`.
The production relay decryptor receives authenticated 256 KiB chunks, checks the
final digest and keeps plaintext until Save. Encryption supplies a chunk at a
time; source Blob memory is excluded from the baseline. Per-chunk GC is used only
for measurement. Node v24.14.0, Windows x64, measured 2026-10-04:

| File | Retained plaintext | Peak additional RSS | Encrypt/receive with measurement overhead |
| --- | ---: | ---: | ---: |
| 64 MiB | 64 MiB | 68 MiB | 792 ms |
| 128 MiB | 128 MiB | 133 MiB | 1488 ms |

Both runs verified the expected complete SHA-256 and byte count. Node's
`arrayBuffers` counter increased only 2 MiB despite live WebCrypto plaintext;
it does not account for all of these allocations. The retained-byte count and
RSS demonstrate file-sized storage. These are Node measurements, not phone bounds.

The existing single-pass architecture cannot retain a whole verified file for
later Save with constant memory and no disk/browser storage. The current task
therefore remains open. Alternatives require a design change: staging storage,
streaming before the final check, or a two-pass fetch that first verifies and
discards plaintext, then binds every saved chunk to that verified pass. A two-pass
design would also need source availability, expiry, second-pass tamper checks,
interruption handling and physical-browser download validation. None is enabled
by this measurement; whole-file verification before Save is preserved.
