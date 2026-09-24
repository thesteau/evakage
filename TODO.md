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
  from `public/app.js`. This cut the `noImplicitAny` baseline from 580 to 309
  before the rest of the pass closed it.
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

- **Sparse-chunk regression test.** `e2e/transfer.spec.js` plays a peer that
  drops a chunk and declares no hash; the receiver must refuse the file as
  incomplete. Verified to fail against the old `.some()` check, which accepted
  the truncated bytes. The fixture in `e2e/helpers.js` gained an `appPatch`
  option for serving one device a rewritten `app.js`.
- **`noImplicitAny` is on.** 309 findings annotated to zero and the flag enabled
  in `tsconfig.json`: record typedefs for the blob store, client and room; shared
  `Inbound` for validated wire messages; contextually typed test helpers (typing
  `waitFor`'s predicate alone cleared 64). Two latent issues surfaced and were
  fixed rather than suppressed: `openForDownload`/`claim` returned unions the
  callers dereferenced without narrowing, and the upgrade handler used a socket
  that could be null in hoisted handlers.

## Hardening, in order

The features work. What is left is making them hold up: under memory pressure,
on interrupted transfers, and on networks that are not loopback. Each item says
what to measure first, because none of them should be redesigned on a guess.

1. **Large files.** Measure peak browser memory first. Both relay and direct
   receive assemble a whole file in RAM; relay upload builds a complete
   encrypted Blob before sending, so the sender pays roughly twice the file.
   This is the most likely way the app fails on a phone today. Investigate
   incremental disk receive (File System Access) where supported, keeping the
   current path as the fallback. Do not promise universal mobile large-file
   support.
2. **Use it on a phone over real wifi.** One afternoon of actually sending
   things between a phone and a desktop across the LAN finds more than any
   amount of loopback testing. It is also the only way to learn whether item 1
   is a real failure or a theoretical one, and whether iOS backgrounding, the
   wake lock and the Android share sheet behave. Cross-engine desktop coverage
   exists now, but WebKit on loopback is not Safari on iOS, and loopback ICE
   proves nothing about routed paths. Everything below is easier to judge after
   this, so it is deliberately ahead of the code items.
3. **Relay resume.** The same story as item 1: it only bites on a big file over
   a flaky link. An interrupted download restarts from the beginning, and an
   upload interrupted before it completes cannot be recovered by the server at
   all, because the bytes only ever existed on the sender. Range requests alone
   are not enough — define authenticated chunk boundaries, retry state and
   integrity behaviour first, or resume becomes a way to assemble a file from
   pieces nothing vouches for.
4. **Give the DOM handles real types.** `public/app.js` gets every element
   through `$`, which is now explicitly `(sel: string) => any` — a deliberate
   `any`, and the largest remaining hole in the type story. This is above the
   remaining transport items because it is the one task here that finds existing
   bugs rather than guarding against hypothetical ones: typing each handle
   concretely surfaces every place `.value` or `.checked` is read off something
   that does not have it. Do it before raising another compiler flag;
   `strictFunctionTypes` is next after that.
5. **Room transport churn.** The mesh/relay switch at six/seven occupied seats
   has no hysteresis, so a room at the boundary re-opens or drops its direct
   links whenever someone joins or leaves. Away members hold seats too. Measure
   how bad it actually is before adding state to smooth it — and note that a
   room that size is unlikely in the use this was built for, which is why it is
   last.

## Standing decisions — not work

- **Negotiation and acknowledgements stay as they are.** Designated-offerer
  negotiation and receiver-driven resume hold because each link is exactly two
  devices and is torn down rather than renegotiated. They have only been
  exercised on loopback and a LAN, but that is a reason to test (item 2), not to
  redesign. Revisit only if a real path demonstrates a failure.
- **Documentation is not a priority while this is a private tool.** The share
  limits and `npm run test:e2e:platform` are undocumented in `README.md`, and
  `SECURITY.md` does not carry the memory-bound rationale. None of that changes
  behaviour or catches a bug, and the code says it plainly enough. Worth a few
  minutes only when publishing the repo, or when editing those files anyway.
  The one gap with real value is a browser test asserting that a rejected share
  reaches the user as a message — that is a test, not a document.

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
