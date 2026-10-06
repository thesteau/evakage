# Independent security review handoff

Prepared 2026-10-04. This is a review scope and reproduction guide, not an
independent review or a security certification. The independent-review task stays
open until an external reviewer records findings against an identified revision.

## Scope

Review `app/server/server.js`, `app/server/blobstore.js` and the browser protocol in `app/public/app.js`,
`identity.js`, `messages.js`, `relay.js`, `frames.js`, `sha256.js` and `sw.js`.
Use [SECURITY.md](../SECURITY.md) for the trust boundaries and deployment assumptions.
Record the reviewed commit and any uncommitted patch; the local checkout currently
contains changes beyond hosted commit `99bea4dffa9136c25a5d676cfb52b6085259cf6b`.

Verify these properties independently:

- Device registration proves possession of the fingerprint key with a fresh
  socket challenge. Codes are private, expire after three days and are bound to
  the selected fingerprint. QR invitations use the same authorization path.
- Unknown, blocked or revoked devices cannot exchange content through direct,
  relay or synchronized-history paths. Offline revocation is reconciled on return.
- Portable author signatures bind exact message content, author and conversation.
  Relayers cannot substitute an author; replay identifiers are scoped by author.
- Relay envelope signatures bind sender, recipient, conversation and file digest.
  AES-GCM binds file ID, chunk index and count. Truncated or altered files cannot
  be saved, and interrupted HTTP transfers restart from byte zero.
- Signaling, HTTP and worker inputs have byte/count limits, token checks, origin
  checks, expiry and resource cleanup. Check adversarial concurrency as well as
  ordinary failures and unavailable peers.
- Identify any differences between local pairing approval and server room
  membership. Room membership is not cryptographically signed group membership.
  A server that serves compromised JavaScript can compromise the browser endpoint.

## Reproduce and report

Run `npm ci`, `npm run check`, `npm run test:e2e` and
`npm run test:e2e:platform`. Adversarial browser tests are in `tests/e2e/history.spec.js`,
`pairing.spec.js`, `security-controls.spec.js`, `relay-restart.spec.js` and
`receiving-validation.spec.js`, plus `transfer.spec.js`. Unit tests exercise parser fuzzing, signatures, expiration,
quotas and wrong credentials. Passing them is supporting evidence only.

See the [internal validation findings](security-validation.md) for the corrected
mid-download revocation gap and simulated-phone receiving evidence. This does
not satisfy the requirement for an independent reviewer.

For each finding, record impact, affected revision and path, a reproducible attack,
expected versus observed behavior, mitigation and a retest result. Completion
requires the reviewer's identity/date, coverage and explicit unresolved findings;
do not infer an independent review from CI, CodeQL or this handoff.
