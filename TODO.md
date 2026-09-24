# Verified gaps and next changes

Reviewed against the checkout on 2026-09-24, after the code and test check.
This is a prioritized plan, not an instruction to implement every deferred idea.

## Check results and completed changes

- `npm run check`: lint, strict-null type checking, and all 63 tests pass.
- `npm run test:e2e`: all eleven Chromium scenarios pass with isolated servers
  and browser profiles. Coverage includes discovery, chat both ways, direct and
  forced-relay file transfers, accept/decline, zero-byte and multi-chunk files,
  byte-for-byte downloads, reload/history/file recovery, offline app shell,
  worker share handoff/expiry, forged identity/signature rejection, cancel/resume,
  and room recovery after disconnect.
- `npm run test:e2e:platform`: the engine smoke test (identity, relay chat,
  verified file download) passes on Chromium, Firefox and WebKit locally. WebKit
  is the engine Safari uses, not Safari itself, and this is still loopback.
- Playwright is development-only. CI runs Chromium before container publishing
  and retains failure traces. `README.md` documents local setup.
- `public/frames.js` now owns pure decrypted-frame parsing; regression and seeded
  fuzz tests cover truncation, oversized lengths/payloads, invalid JSON shapes,
  invalid chunk indices/counts, unknown kinds, and nonzero buffer offsets.
  Rejected frames return before conversation lookup or mutation. The service
  worker precaches the new module and its cache version is bumped.
- `strictNullChecks` is enabled. Nullable state has explicit types, identity and
  registration-dependent operations check readiness, and server/test null
  findings are resolved. This does not eliminate existing implicit `any` types.
- `npm audit --audit-level=high`: zero reported vulnerabilities.
- Docker and remote CI/PR status were not checked. Browser checks ran locally
  in Chromium on Windows; hosted Linux CI still needs its first run.

- PWA shares are handed over once and refused at the ten-minute boundary even
  if cleanup timers were suspended. A timer provides best-effort memory cleanup;
  worker termination can lose shares earlier. Unit and browser tests cover this.
- Relay access expires independently of disk cleanup: pending listings, claims,
  uploads, and new downloads refuse expired items, including earlier tokens.
  Uploads crossing the boundary fail. Downloads started before expiry may finish
  later; the periodic sweep removes ciphertext afterward. Boundary tests and
  README/SECURITY/deployment documentation describe this distinction.

- **Shared data shapes.** `public/types.d.ts` defines `Link`, `SecureLink`,
  `Conversation`, `FileRecord`, `FileMeta`, `Message`, `Device` and `Room`, used
  from `public/app.js`. This cut the `noImplicitAny` baseline from 580 to 309;
  the flag itself is still off.
- **Sparse-chunk completion fix.** Completion used
  `chunks.some(chunk => !chunk)`, and `.some()` skips holes in a sparse array,
  so a file missing chunks could pass as complete and then be hashed and
  offered. It now compares `countReceived(chunks)` against the expected length.
- **Share admission limits.** `public/sw.js` caps one share at 16 MiB, the whole
  queue at 32 MiB, eight queued entries and 32 files, counting in-flight request
  bodies against the same budget so concurrent POSTs cannot bypass it.
  Rejections redirect to `?shared=too-large|queue-full|too-many-files` and the
  app explains each. `tests/shares.test.js` covers the entry, file-count and
  byte budgets including in-flight bodies and recovery after rejection.
- **Cross-engine browser run.** `e2e/helpers.js` holds the shared fixture;
  `e2e/platform.spec.js` plus `playwright.platform.config.js` run an engine
  smoke test on Chromium, Firefox and WebKit.

## Next set of changes, in order

1. **Cover the sparse-chunk regression.** The completion fix above has no test.
   It lives in `public/app.js`, which the unit tests do not import, and no
   browser test constructs a gap, so a regression would go unnoticed. A browser
   test that drops one chunk on the receiver is the smallest way to pin it.
2. **Finish the type ratchet.** `noImplicitAny` reports 309 findings: 91 in
   `server.js`, 56 in `public/app.js`, 34 in `blobstore.js` and 128 across
   `tests/`. 266 are TS7006 (untyped parameters), the rest mostly
   TS7053/TS7005/TS7031. Annotate per file, then enable the flag in
   `tsconfig.json`; do not enable strict wholesale or suppress findings.
3. **Document the share limits.** Add the 16 MiB / 32 MiB / eight-entry budget
   and its rejection messages to `README.md`, and the memory-bound rationale to
   `SECURITY.md`. `npm run test:e2e:platform` is also missing from the README's
   local-development section. No browser test yet asserts that a rejected share
   reaches the user as a message.
4. **Validate on real devices and networks.** Cross-engine desktop coverage now
   exists, but WebKit on loopback is not Safari on iOS. Still unvalidated, and
   not reachable from this environment: real Safari, the Android share sheet,
   and routed LAN, VPN and TURN paths. Large rooms crossing the mesh limit are
   covered by unit tests but never by a browser test.

## Reliability follow-ups
- **Large files:** measure peak browser memory first. Both relay and direct
  receive assemble a whole file; relay upload constructs a complete encrypted
  Blob. Investigate incremental disk receive where supported, with the existing
  browser fallback. Do not promise universal mobile large-file support.
- **Relay resume:** interrupted downloads retry from the start; incomplete
  uploads require the sender. Range requests alone are insufficient: define
  authenticated chunk boundaries, retry state, and integrity behavior first.
- **Room transport churn:** measure switching around six/seven occupied seats
  before adding hysteresis. Away members hold seats too.
- **Negotiation/acknowledgements:** keep designated-offerer negotiation and
  receiver-driven resume unless real-network tests demonstrate a need to change
  them. Test routed LAN, VPN, and TURN paths before redesigning the protocol.

## Security work requiring a design

- **Signed history:** direct live messages are bound to the authenticated link;
  server-relay envelopes are already signed. Peer-synced third-party history
  still lacks portable authorship proof. Design a versioned, unambiguous signed
  envelope covering author, conversation identity, message ID, timestamp, and
  content, with key/fingerprint validation, replay rules, and legacy handling.
  The old pipe-delimited sketch is not an implementation spec. Measure encoded
  overhead and verification time on phones rather than assuming 176 bytes or
  seconds of work; bound verification batches and UI blocking.
- **Device authorization:** a server-enforced allowlist can restrict access to
  an honest server; it cannot stop a compromised server changing membership.
  That needs client-enforced recipient approval or authenticated membership,
  plus a clear trust model for the server-delivered code. AUTH_TOKEN can be
  rotated by changing configuration/restarting (invalidating existing cookies),
  but has no per-device revocation or in-app rotation flow.
- **Pairing:** reviewing and forgetting remembered devices already exists.
  Forgetting is not revocation. A verified pairing state and out-of-band flow
  remain separate work; first sighting is still TOFU.
- **Independent protocol/security review:** commission before making stronger
  security claims. Existing signaling fuzz tests and automated scanners are
  useful but do not constitute that review.

## Deferred product ideas

- QR codes: use a maintained encoder or reviewed vendored implementation and
  decoder round-trip tests; there is no need to write an encoder from scratch.
- Streaming hash/send optimization: benchmark the current pre-hash pass first;
  preserve the receiver's integrity guarantee if the protocol changes.

## Already implemented

MIT license and package metadata; lint/checkJs tooling; sealed and signed server
relay for files/messages; offline delivery and away seats; incoming-file consent;
file/text share target; remembered-device management; rename dialog; drag/drop
and paste; themes and accessibility work; path/throughput display; larger rooms
using relay above six seats. Keep these out of the open backlog.

CODEX_HANDOFF.md contains historical architecture and test descriptions, some
predating relay/away-seat support. Use the source and current tests to resolve
conflicts; rewriting that historical handoff is separate documentation work.
