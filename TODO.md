# Known gaps and planned work

Tracked from the audit passes over `CODEX_HANDOFF.md`. Items marked **done**
stay here only until the handoff is next rewritten.

## Current priority

**The core works and that is the bar for now.** One-to-one transfer in both
directions, small rooms, identity verification, and integrity checking are all
implemented and covered by tests. Nothing below is urgent; it is a list of what
is known to be missing, kept honest so it does not get rediscovered later.

Do not treat the rest of this file as a queue to burn down.

## When publishing (not before)

- [x] **License.** MIT, `LICENSE` + `package.json` `license` field.
      Copyright holder is `thesteau` from the git identity — change it if that
      should be a different name or legal entity.
- [x] **`package.json` metadata.** `repository`, `author`, `bugs`, `homepage`
      point at `github.com/thesteau/aria-drop` now that the repo has a remote.
- [ ] **Commission a protocol/security review.** `npm audit`, CodeQL, Trivy and
      the fuzzer all run in CI, but automated scanning is not a review, and the
      README/SECURITY wording should not imply otherwise until one happens.

## Security

- [ ] **Per-message signatures.** *Deferred deliberately — see below.*
      Live chat frames are author-checked (a room member cannot post as another
      member in real time), but history relayed during a sync legitimately
      carries third-party authorship, so a member can inject fabricated history
      attributed to someone else. Such messages are marked `relayed` in the UI
      and the residual is documented in `SECURITY.md`.

      Design when picked up: sign `aria-drop/msg|<scope>|<id>|<at>|<text>` with
      the author's identity key and carry the author's public key in the
      envelope, so verification is self-contained even for an offline author
      (its fingerprint must equal `from`). Costs roughly +176 bytes per message
      and one ECDSA verify per newly merged message — a 2,000-message catch-up
      is seconds of crypto on a phone, so verification wants to be lazy or
      batched rather than inline in the merge loop.

- [ ] **Per-device authorisation.** `AUTH_TOKEN` is a single shared secret with
      no rotation or revocation. Now that devices have identity keys, an
      allowlist of fingerprints is the natural next step, and it would also
      close the hole where a compromised signaling server adds a device it
      controls to a room's member list.
- [ ] **Out-of-band pairing.** Trust-on-first-use accepts the first sighting
      unverified. There is no pairing flow and no way to review or revoke
      remembered devices (see the UX item below).
- [ ] **Property-test the frame decoder.** `handlePlainFrame` is currently
      exercised only indirectly, through the patched-peer browser tests.
      `tests/fuzz.test.js` covers the signaling parser but not this.
- [ ] The signaling server is still trusted for **membership** and for
      **serving the code**. Identity is proven; those two are not fixable
      without moving trust somewhere else.

## Tooling

- [x] **Type checking.** `tsc --noEmit` with `checkJs`, TypeScript as a
      devDependency only. Chosen over a real `.ts` migration to keep the "no
      compile step" property: the browser still loads the same hand-written ES
      modules and the Dockerfile is unchanged. `npm run typecheck`.
- [ ] **Raise the type-checking ratchet.** The current config is the strictest
      level that is green today. In order:
      1. `strictNullChecks` — **52 findings**. Do this one first; it is where
         actual bugs hide (the codebase leans on `?.` and nullable state like
         `state.self`, `link.pc`, `file.chunks`).
      2. `noImplicitAny` — **388 findings**, almost all mechanical `@param`
         annotations. Worth defining shared `@typedef`s for `Link`,
         `Conversation`, and the file record first, since those three shapes
         account for most of it.

      Raise one flag, fix everything it reports, commit, then raise the next.
      Do not enable `strict` wholesale and suppress the fallout.
- [x] **Linter.** ESLint flat config over `server.js`, `public/*.js`, `tests/`.
      `npm run lint`. Also `npm run check` to run lint + typecheck + tests.
- [ ] **Browser suites are not in the repo.** The mesh, direct, integrity and
      PWA suites live outside version control because they need Playwright and
      the project is otherwise dependency-free. (There are now also relay,
      offline, large-room, accept and share suites.) CI therefore covers none of the
      WebRTC, PWA or identity behaviour — only what `node --test` reaches.
      Adding Playwright as a dev-only dependency and an `npm run test:e2e`
      would fix that; it is the largest remaining hole in the test story.

## Server relay

- [x] Sealed, signed server relay for **files and messages**, with direct-first
      fallback per recipient and a forced "Via server" mode. One directory per
      conversation; an item is deleted once every recipient has it, otherwise it
      stays — even after both devices disconnect — until the 24h sweep, which
      also removes empty directories. `blobstore.js`, `public/relay.js`.

- [x] **Sending to an offline device.** The server keeps the signed key record
      of every device seen in the last 24h, so a known device that is offline is
      still listed and can be sent to; clients verify the record exactly as a
      live one, so the server cannot substitute a key.
- [x] **Room members who drop off stay "away"** instead of leaving: they keep
      their seat, are still sent to through the relay, and catch up on rejoin.
- [x] **A failed relayed download retries by itself** when the device reconnects.

To keep in mind — deliberately not being worked on:

- [ ] **Relay transfers restart rather than resume.** Delivery already
      survives an interruption (the item stays until taken, and a failed
      download retries on reconnect); what is missing is continuing from the
      middle. HTTP `Range` on download and chunked PUTs on upload would do it.
      An upload interrupted before it finishes cannot be recovered by the
      server at all: the bytes only ever existed on the sender.
- [ ] **Sender pays 2× the file in memory while uploading** — the encrypted
      body is built as one Blob before the PUT, because streaming request bodies
      are not supported in Safari. Browsers may spill large Blobs to disk, but it
      is not guaranteed.

## Protocol / reliability

- [ ] **File System Access API** for large-file receive where supported, so a
      completed transfer is not retained as a blob in RAM. Keep the current
      path as the Safari fallback. This is the main reason large files are still
      unreliable on memory-constrained phones.
- [ ] **Explicit chunk acknowledgements.** Resume checkpoints on what the
      receiver holds when it next asks, which avoids re-sending but gives the
      sender no live delivery signal.
- [ ] **Perfect negotiation** instead of the designated-offerer scheme. The
      current scheme holds because each link is exactly two devices and is torn
      down rather than renegotiated, but it has only been exercised on loopback
      and on a LAN.
- [ ] The sender hashes a file in a pass before transmitting, so a large file is
      read twice. Fine on a desktop; worth measuring on a phone.

## UX

- [x] In-app dialog replacing `prompt()` for renaming.
- [x] Drag-and-drop files onto a peer row, a room row, or the open session.
- [x] Paste-to-send, including pasted images and files.
- [x] Light/dark/system theme with a persisted choice.
- [x] Accessibility pass: focus management and trapping, keyboard paths for
      every action, visible focus rings, `prefers-reduced-motion`, labelled
      landmarks and live regions, `scope` on table headers.
- [x] Known-device management: review and forget remembered devices.
- [x] Candidate path (host / srflx / relay) and live throughput in the table.
- [x] **Incoming files can be accepted or declined.** Settings → Incoming
      files: ask for new devices (default), always ask, or
      accept automatically. Nothing is kept before accepting; a relayed file
      waits on the server, and declining releases it there. Chat is not gated.
- [ ] **QR code** for the server URL and device code. Deliberately not shipped:
      it needs a QR encoder written from scratch, and there is no QR decoder
      available here to verify the output actually scans. Shipping an unverified
      encoder is worse than not shipping one. Either add a decoder as a dev
      dependency for the test, or vendor an audited encoder.
- [x] **Share target for files.** The installed app appears in the share
      sheet for files as well as text. The service worker catches the POST, so
      the server never sees the plaintext; the files wait behind a banner until a
      device or room is picked, and offline devices are offered via the server.
      Not verifiable here on a real Android share sheet — only the request it
      makes — and iOS does not support web share targets at all.

## Product

- [x] **Larger rooms.** Up to six members use the direct mesh; beyond that a
      room runs entirely through the server relay (one sealed upload per file,
      no direct links, no per-link safety codes). `ROOM_MAX_MEMBERS`, default
      20, clamped to 2–64.
- [ ] The mesh/relay switch has no hysteresis: a room hovering at six/seven
      seats changes transport (and opens or drops its direct links) every time
      someone joins or leaves. Harmless so far, but noisy.
