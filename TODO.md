# Verified gaps and next changes

Reviewed against the checkout on 2026-09-24, after the code and test check.
This is a prioritized plan, not an instruction to implement every deferred idea.

## Check results and completed changes

- `npm run check`: lint, strict-null type checking, and all 61 tests pass.
- `npm run test:e2e`: all ten Chromium scenarios pass with isolated servers
  and browser profiles. Coverage includes discovery, chat both ways, direct and
  forced-relay file transfers, accept/decline, zero-byte and multi-chunk files,
  byte-for-byte downloads, reload/history/file recovery, offline app shell,
  worker share handoff/expiry, forged identity/signature rejection, cancel/resume,
  and room recovery after disconnect.
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

## Next set of changes, in order

1. **Continue the type ratchet separately.** Define shared Link, Conversation,
   and file-record shapes, then enable noImplicitAny. Remeasure findings after
   adding shared types; do not enable strict wholesale or suppress findings.
2. **Broaden platform/network validation.** Exercise real Safari and Android
   share sheets, routed LAN/VPN/TURN, and larger rooms crossing the mesh limit.
   Current automated browser coverage is Chromium on loopback.
3. **Bound shared-file queue memory.** Measure practical file sizes and choose
   admission limits for total queued bytes and entries, with clear rejection UX.
   Expiry prevents stale retrieval but does not limit simultaneous shares.

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
