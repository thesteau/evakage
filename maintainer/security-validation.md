# Local security and receiving validation — 2026-10-04

This records an internal code inspection and executable checks of the current
working tree. It is not an independent protocol/security review. The reference
commit is `99bea4dffa9136c25a5d676cfb52b6085259cf6b`; local changes extend that commit.

## Finding and fix

**Authorization revoked during relay receipt.** `downloadRelayed` checked the
sender's authorization before claiming the item, then received and committed the
file without checking again. A regression test held the HTTP response, blocked
the sender through Known devices, and released the response. Before the fix the
file was accepted and reported SHA-256 verified despite the block.

Active downloads now have an AbortController. Forgetting, blocking or a received
pairing revocation aborts downloads from newly unauthorized senders. The receiver
also checks authorization before/after reading and decrypting each network block,
and before final completion. Failure clears progress, cancels the reader and
never installs a saved Blob. Unblocking or pairing again permits an explicit
restart from byte zero. Completed files already received are not retroactively
erased. Live chat also rechecks authorization after asynchronous signature work.

`tests/e2e/receiving-validation.spec.js` covers blocking and forgetting while the HTTP
response is held. Both prevent completion and Save. A separate case changes
ciphertext after the first authenticated chunk: decryption fails and Save remains
unavailable. Existing tests cover truncated files, hash checks, restart boundaries,
unknown-device refusal, author forgery, wrong conversations and revoked pairing
after reconnect.

## Simulated-phone receiving

Two Chromium contexts with the Pixel 7 profile transfer a 32 MiB file by HTTP
relay. Save is unavailable before receipt; final SHA-256 verification and saved
bytes match the input, with no page error. This is a foreground browser test,
matching the accepted phone-simulation scope. It does not establish actual phone
RAM limits or battery behavior.

## Two-pass receiving (added after the record below)

Relayed files are now received in two passes, as described in
[relay memory](relay-memory.md). The 32 MiB phone simulation now uses this
path: one body fetch for verification, a second for a Save streamed through
the service worker. `tests/e2e/two-pass.spec.js` covers these cases:

- exact bytes and release after a streamed save;
- a tampered or truncated second pass (altered on the server's disk) failing
  the download, retaining the server copy and allowing a successful retry;
- expiry between the passes, which shows Gone without a download;
- a sender blocked between the passes, which refuses Save;
- revocation during a throttled save pass, which fails the download (Chromium only);
- the single-pass and in-memory fallbacks.

Except for the Chromium-only throttled case, these pass three times each in
Chromium, Firefox and WebKit. `tests/unit/relay.test.js` covers digest binding,
substitution with a validly encrypted different file, truncation and trailing
bytes. `tests/unit/savestream.test.js` covers the worker route. Node measurements show
flat peak RSS for the two-pass decrypt/verify code at 64 and 128 MiB. Browser
memory and physical phones were not measured.

## Limits of this validation

Validation passed: lint, strict type checking, 92 unit tests, all 33 Chromium
scenarios, Chromium/Firefox/WebKit smoke tests and dependency auditing with zero
reported vulnerabilities. The [revision and results record](validation/security-validation-20261004.json)
includes hashes of the inspected source files; it predates the two-pass change,
so those hashes no longer match `app/public/app.js`, `app/public/relay.js` or `app/public/sw.js`.
Hosted CI still applies only to its committed revision, not this working tree.

The inspection checked direct, relayed and synchronized-message acceptance,
signed relay envelopes, parser/resource bounds, pairing/revocation and receiving
completion. Automated regressions and dependency auditing provide supporting
evidence, not a claim that all attacks were reviewed or that no vulnerability
remains. Signed group membership is not implemented, peer-synced file manifests
do not have portable author proofs, and a server serving compromised JavaScript
can compromise its browser clients. An external reviewer must still perform the
[independent review](security-review.md) against an identified revision.
