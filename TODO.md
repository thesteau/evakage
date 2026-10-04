# Validated task list — 2026-10-04

This replaces historical backlog entries that no longer matched the checkout.

## Completed

- [x] Renamed the app to Evakage: interface, PWA titles, package, server messages
  and deployment service names. Existing identities, settings and pairings stay
  compatible; published repository/image URLs are retained.
- [x] Device-to-device transfers, including smartphones: user confirmed.
- [x] Self-chat is always the first advertised device, emphasized **This is you**.
  Retention details appear in the encryption hover hint; the verbose server label is removed.
- [x] Device renaming removed from the UI and rejected by the server, including
  re-registration attempts to supply a different name.
- [x] Bounded-memory relay sending: one encrypted 256 KiB chunk per upload,
  without assembling the entire ciphertext. See [measurements](docs/relay-memory.md).
- [x] Interrupted relay transfers stop. Restart upload creates a fresh server item
  and sends from byte zero; Restart download discards partial plaintext and fetches
  the whole file again. Chunk resume is outside the product scope; interruption
  coverage verifies the restart boundaries and exact final bytes.
- [x] Signed peer-synced message history: portable author proofs, conversation
  binding, immutable author-scoped IDs, bounded frames and adversarial tests.
  Protocol v2 is refused. This authenticates message authorship, not room
  membership or peer-synced file manifests.
- [x] Private pairing codes: owner-only rotating three-day invitations, separate
  from public discovery codes, with expiry, guess limiting and identity proofs.
  Established pairs survive code rotation. Forgetting revokes the server pair
  association and prevents automatic reconnect approval.
- [x] Verified pairing, local blocking and verified-only recipient/author checks.
- [x] Optional server DEVICE_ALLOWLIST with fresh socket-bound possession proofs;
  removing a fingerprint and restarting revokes server access.
- [x] QR server/device invitations using a vendored encoder, with decoder and
  rendered-canvas tests. Authentication query tokens are excluded; invitation
  fragments are consumed and removed. Own fingerprint is displayed.
- [x] DOM types, strict null checks, noImplicitAny and strictFunctionTypes.
- [x] Frame parser regression tests and seeded fuzzing; sparse file-chunk
  completion regression; worker admission, handoff and exact expiry checks.
- [x] Actual browser share-rejection coverage for size, file count and queue limits.
- [x] Local room boundary churn measurement. Six/seven-seat transitions close
  and recreate 30 endpoints without missing or duplicate tested messages.
  See [scope, measurements and reproduction](docs/room-churn.md).
- [x] Hash/send measurement: retain pre-hashing and verification before Save.
  See [memory and timing measurements](docs/relay-memory.md).
- [x] Cross-engine smoke validation and CI configuration for all three engines.
- [x] Local container build and smoke validation.
- [x] Authenticated hosted CI for commit `99bea4d`: test, Chromium browser,
  container smoke and vulnerability-scan gates succeeded. The CodeQL run also
  succeeded. See [hosted evidence and revision scope](docs/hosted-ci.md).
  This does not validate later uncommitted changes or the expanded browser workflow.
- [x] Room churn validation on desktop and simulated phones: TURN-only and
  in-flight file transition coverage, including
  three mobile-emulation repeats. Actual selected relay candidates are checked;
  all five incumbent recipients verify each file and sampled saved bytes match.
  Fixed a stale direct-transfer ID that hid Save after relay fallback.
  Phone simulation is accepted for the current foreground-use scope; physical
  devices and WAN/CPU/battery measurements are not completion requirements.
  The six-seat mesh boundary remains. See [measurements](docs/room-churn.md).
- [x] Receiving memory measured at 64/128 MiB; whole-file verification before Save
  remains. See [constraints and alternatives](docs/relay-memory.md).
- [x] Receiving/security validation: simulated-phone 32 MiB transfer verifies
  exact saved bytes; altered ciphertext cannot be saved. Blocking or forgetting
  during receipt aborts the download and prevents completion. Fixed the original
  authorization check applying only at download start. See [internal findings](docs/security-validation.md).
- [x] Basic phone usage: keep the app open and screen unlocked during transfers.
  The session shows a brief interruption warning. Existing wake lock and foreground
  reconnect are best effort; guaranteed background transfers are outside the current
  scope. Physical-phone lifecycle, share-sheet and resource measurements
  remain deferred, with no manual evidence claimed.

## Final local checks

- `npm run check`: lint, strict type checking and **92/92 unit tests pass**.
- `npm run test:e2e`: **33/33 Chromium scenarios pass**, including receiving
  revocation, ciphertext tampering and the simulated-phone 32 MiB transfer.
- `npm run test:e2e:platform -- --repeat-each=3 --output=test-results/platform`:
  previous **9/9 pass** across Chromium, Firefox and WebKit; the current transfer
  fixes also pass a fresh **3/3** engine smoke run.
- `npm audit --audit-level=high`: zero reported vulnerabilities.
- Docker image `aria-drop-review:20261004` builds. The isolated non-root container
  returns healthy status, protocol 3 configuration and correct module MIME;
  it was stopped afterward. Nothing was published or deployed.
- Service-worker cache evakage-v18 includes signed-message, vendored QR modules, the foreground
  notice and transfer fixes. Local browser tests are not physical Safari/phones.
- Authenticated GitHub Actions results are recorded separately for the exact
  hosted revision; they do not cover this uncommitted working tree.

## Remaining work

- [ ] Bounded-memory receiving implementation. Measurements confirm plaintext
  retention scales with file size. The single-pass design cannot retain the whole
  verified file for later Save with constant memory and no staging storage.
  No streaming-before-verification tradeoff is approved; browser storage remains
  outside the design. A two-pass design is a possible future alternative, with
  availability, tamper, expiry and download validation still required.
- [ ] Independent protocol/security review. Automated tests and fuzzing are not
  an independent review. Local recipient approval does not create signed group
  membership and cannot protect against a server serving compromised app code.
  A [review handoff](docs/security-review.md) is ready; an external reviewer must
  supply findings against an identified revision.

## Standing decisions

Desktop and simulated-phone checks are sufficient for current phone validation.
Actual WAN, mobile-radio, CPU and battery costs remain unmeasured and outside the
required scope. Revisit them if reported behavior justifies changing the six-seat
mesh boundary.

Keep designated-offerer negotiation and direct receiver-driven resume unless a real path
shows a failure. Keep direct file transfers alongside relay; changing that product
policy is not required by the current evidence. Administrative access/revocation
uses configuration and restart rather than an in-app administrator API.

Historical architecture in CODEX_HANDOFF.md may predate relay and away seats;
current source, tests, README and SECURITY take precedence.
