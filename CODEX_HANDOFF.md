# Codex handoff: build context, tests, and improvements

> Branding update (2026-10-04): the app is now **Evakage**. Historical names below
> describe older revisions. Browser identity/settings keys, cryptographic context
> strings, auth cookies and existing repository/image URLs intentionally retain
> their original identifiers for compatibility. See README.md and TODO.md.

> Current update (2026-09-24): this handoff includes historical claims that
> predate relay and away-seat support. Reproducible Chromium tests now live in
> `e2e/` (`npm run test:e2e`) and run in CI. The frame parser is independently
> tested in `tests/frames.test.js`, and `strictNullChecks` is enabled. See
> `TODO.md` for current verification and remaining work.

## Product intent

Build a browser-first homelab tool that feels as immediate as a local drop utility but handles the whole small-transfer workflow:

- automatic discovery/advertising is the primary interaction;
- a table gives more explicit selection and connection statistics;
- users can choose Chat, Text, or File for a target;
- connect-by-code is a fallback, not the main discovery path;
- peer payloads are ephemeral and peer-to-peer;
- if one browser temporarily leaves while the other remains, the surviving browser keeps the session in RAM and can re-sync it on return;
- once every participant holding the session state is gone, the data is gone;
- deployment is a single Docker container and images publish to GHCR.

The MVP implements one-to-one sessions **and** small full-mesh rooms (up to six devices). See "Resolved since this handoff" below for what has been closed out and what is still open.

## Architecture

- **Node 22.13+ (the image ships node:26-alpine), dependency-free WebSocket server:** static HTTP server, health/config endpoints, WebSocket presence/signaling.
- **Vanilla browser client:** no compile step/framework.
- **Presence:** every registered browser is advertised to every other browser connected to the server. Rooms are advertised the same way.
- **Identity:** long-lived non-extractable ECDSA P-256 key in IndexedDB; the device ID is the base64url SHA-256 fingerprint of its public half. Display name and remembered-device fingerprints live in localStorage. Direct payload state stays in browser memory; encrypted relay payloads are temporarily buffered on disk. Optional SQLite account storage contains credentials and selected preferences only.
- **PWA:** installable on phones/tablets/desktop, offline app shell via a precaching service worker, a POST share target for files, text and links (caught by the service worker), foreground reconnection and a transfer-scoped screen wake lock for mobile.
- **Fallback code:** deterministic short code from device UUID while registered; code lookup returns an online peer. Rooms get a separate random `ABCD-EFGH` code.
- **Links vs. conversations:** the client keeps one *link* per peer device (`RTCPeerConnection` + ordered DataChannel + crypto) and separate *conversation* state per direct session or room. A single link carries every conversation shared with that device; frames name their scope (`direct` or `room:<id>`), and `direct` is resolved relative to the sender.
- **Offer glare avoidance:** lexicographically smaller device ID is the designated offerer. The other side sends a signaling `knock` when it needs a connection.
- **Application crypto:** ephemeral P-256 ECDH per link -> AES-256-GCM. Public keys are exchanged after the DataChannel opens, alongside the supported protocol range. The UI displays a short safety code per link; rooms have no group key.
- **Integrity:** the sender hashes each file with a streaming SHA-256 before transmitting; the receiver hashes what it assembled and refuses a mismatch. `crypto.subtle.digest` is one-shot, so the hash is hand-rolled in `public/sha256.js` and tested against `node:crypto`.
- **Server controls:** per-message schema validation, per-connection and per-address rate limiting, WebSocket origin checks, and an optional `AUTH_TOKEN` cookie gate. Configured per server instance rather than at module import, so several differently configured servers can run in one process.
- **Rooms:** server-side membership registry, capped at six devices per room and 64 rooms per server. A room exists while at least one member is connected; a reconnecting browser that still holds the room's RAM state can restore the same room id/code.
- **State recovery:** peers exchange full chat history + file manifests for every shared conversation once a link's encryption is ready. Merging is by immutable message/file ID, so it is idempotent and needs no elected survivor. Missing file blobs are pulled on demand from a peer listed as still holding them.
- **Files:** encrypted 64 KiB chunks with DataChannel buffered-amount backpressure. In a room the sender uploads once per recipient, chunk-by-chunk across live links. Received blobs remain in memory until the page loses state.

## What was tested here

These checks were executed successfully:

```bash
npm ci
npm run lint
npm run typecheck
npm test

docker build -t aria-drop:test .
docker run --rm -d --name aria-drop-test -p 3712:3000 aria-drop:test
curl -fsS http://127.0.0.1:3712/healthz   # {"ok":true,"peers":0,"rooms":0}
docker stop aria-drop-test
```

The `node --test` suite covers:

- health/config endpoints, WebSocket registration, presence, deterministic device codes, code lookup;
- the room lifecycle: create, advertise, join by code and by id, the six-device cap, leave, membership loss on disconnect, destruction when the last member goes, and room restoration on reconnect;
- hardening: origin allow/deny, `ALLOWED_ORIGINS`, schema rejection and socket closure after repeated violations, oversized SDP and malformed ICE being dropped rather than forwarded, signaling re-serialisation stripping undeclared fields, message flooding tripping the limiter, the per-address connection cap and its release, the `AUTH_TOKEN` flow end to end, and `X-Forwarded-*` being ignored unless `TRUST_PROXY` is set;
- `public/sha256.js` against `node:crypto` across sizes, block boundaries, streaming splits, and non-zero `byteOffset` views;
- fuzzing: structured garbage and mutated-but-valid signals against a live server, asserting only well-formed shapes are forwarded, extra keys are stripped, the server stays healthy, and prototype-shaped keys cannot poison lookups.

It does not exercise WebRTC. That was verified separately by driving real Chromium browsers against a live server (Playwright, loopback host candidates), in three scripts:

1. **Mesh** — three browsers: full-mesh link-up with pairwise encryption, chat broadcast both ways, a multi-chunk file reaching both recipients, a reloaded member recovering history from survivors without duplicates, on-demand byte retrieval after reload, and the room disappearing when the last member leaves.
2. **Direct** — connect-by-code, matching safety codes, both-direction chat, a 200 KB and a 0-byte file, and reload recovery from the surviving peer.
3. **Integrity and identity** — SHA-256 verified against the file's real digest; a peer served a patched `app.js` that flips a byte in one chunk, whose file the receiver rejects instead of saving; cancel mid-transfer then resume, skipping the chunks already held and still matching the original digest; a peer advertising protocol 99 refused with an explanation and a Retry affordance; device IDs confirmed to be 43-char key fingerprints; the safety code identical on both sides and unchanged across a reload, with the peer flipping from `new` to `known`; a peer presenting an identity key that does not hash to its device ID refused; and a peer sending a forged signature refused.
4. **PWA** — manifest and every icon it references served with the right type and real PNG magic bytes, the 192/512/maskable set Android needs, the iOS meta tags and `apple-touch-icon`, the card layout at 390px with no horizontal scroll and 44px touch targets, a verified file transfer between an emulated phone and a desktop browser, the app shell rendering after `setOffline(true)`, and `/config.json` staying network-only.

5. **UX** — theme cycling with genuinely distinct palettes and persistence; the rename dialog (with `prompt()` stubbed to throw, so a regression to it fails the test) including focus entry, restoration, and Escape-cancels-without-saving; a file dropped on a peer row arriving verified; the path column reading `host↔host` on loopback; paste-to-send with the target picker and a linkified anchor carrying `rel=noopener`; listing and forgetting a known device; a keyboard-only path to a session with focus restored on Escape; and transitions neutralised under `prefers-reduced-motion`.

Scenarios needing a *misbehaving* peer are staged by intercepting `/app.js` for one browser. That is deliberate: no test hooks ship in the product code.

The PWA script's "iPhone" contexts are Chromium with iOS metrics and user agent, because Playwright's WebKit build is not installed here. Layout, manifest, and service-worker behaviour are exercised faithfully; real Safari WebRTC and Add-to-Home-Screen still need a device.

Those browser scripts are **not** in the repo: they need Playwright, and the project is deliberately dependency-free. Re-create them, or add Playwright as a dev-only dependency, if this should run in CI.

## High-priority browser testing

1. **iOS Safari:** two-device discovery, opening a session, sending text/link, foreground/background transitions, app switch, screen lock, re-open, PWA mode.
2. **Safari ↔ Chrome/Firefox:** ICE negotiation and DataChannel binary message behavior.
3. **Reconnect race:** kill Wi-Fi on one device for 10–30 seconds, restore it, confirm the surviving peer re-establishes a channel and history re-syncs without duplicate messages.
4. **Reload recovery:** send chat + file A→B; reload A only; verify B causes reconnection and A receives chat/file metadata; request the old file from B.
5. **Deletion boundary:** close/reload both participants; verify no chat/file payload reappears. Device names/IDs may remain by design.
6. **Large files:** 100 MB, 500 MB, and configured-limit boundary. Watch heap growth, mobile tab eviction, backpressure, and transfer cancellation behavior.
7. **Filename edge cases:** Unicode, very long names, same-name files, zero-byte files.
8. **Network topology:** same Wi-Fi, wired↔Wi-Fi, VLAN routing, Tailscale/WireGuard, TURN-only.
9. **Rooms on real devices:** six-device mesh on mixed platforms, a member leaving mid-transfer, two members joining simultaneously, and upload saturation when one sender fans a large file out to five recipients.
10. **Installed PWA on a real phone:** Add to Home Screen on iOS and install on Android; confirm the identity key in IndexedDB survives an app relaunch and an OS restart (so the safety code and `known` marker persist); confirm the wake lock actually keeps a long transfer alive through a screen timeout; confirm the update banner appears after a redeploy and that accepting it does not interrupt a transfer; confirm sharing text and a link from another app prefills the composer, and that sharing a photo from the gallery shows the share banner and sends it.
11. **Storage eviction:** let iOS evict the site's storage (or clear it manually) and confirm the device reappears as a new identity with a new safety code rather than failing in a confusing way.

Items 3, 4 and 5, and the zero-byte case in 7, were reproduced headlessly on loopback (see above); they still need real devices and real radios.

## Resolved since this handoff

- **Docker build/run verified**, including `/healthz` and `/config.json` from inside the container.
- **Multi-party rooms implemented** — room IDs and server-side membership, full-mesh DataChannels for up to six devices, the room-survives-while-one-member-remains deletion rule (including restoring a room after a signaling blip), CRDT-style merge of message/file manifests by immutable ID instead of an elected survivor, and metadata-only rejoin with on-demand byte retrieval.
- **Renamed to `aria-drop`.** The name now appears in `package.json`, `docker-compose.yml`, the manifest, the service-worker cache key, the `localStorage` keys, the DataChannel label (`aria-drop-v1`), and `createAriaDropServer`. Existing browsers will mint a new device identity once, because the `localStorage` keys changed.
- **Server hardening done** — message schema validation, per-connection and per-address rate limiting, WebSocket origin checks with a proxy-aware allowlist, optional `AUTH_TOKEN` access control, and validated re-serialisation of signaling payloads. Dependency and container scanning wired into CI.
- **Protocol and integrity done** — version negotiation, SHA-256 verification of every transfer, transfer IDs with cancel and chunk-level resume, bounded reconnect, and client-side memory caps.
- **Signed device identity (protocol v2).** Device IDs are now SHA-256 fingerprints of a long-lived, non-extractable ECDSA P-256 key held in IndexedDB, and peers sign a transcript binding both ephemeral keys and both nonces. The signaling server is no longer trusted for identity. Safety codes are derived from the long-lived fingerprints, so they are stable across sessions; devices are remembered on first use and marked `new`/`known`.
- **PWA / mobile.** Real PNG icons at 192/512 plus a maskable variant and an iOS `apple-touch-icon`; a full manifest with scope, display override, launch handler, and a share target; a service worker that precaches the app shell, serves it offline, keeps `/config.json` and `/healthz` network-only, and offers updates instead of applying them mid-transfer; a card layout replacing the seven-column tables below 700px; safe-area insets; 44px touch targets; foreground reconnection for iOS backgrounding; and a screen wake lock held only while a transfer is in flight.
- **Audit pass after the above, five more gaps closed:**
  - **`MAX_FILE_BYTES` was enforced only on send.** A peer could declare any size and make the receiver allocate against it. The limit now holds on receive, chunk count and declared size must agree, no chunk may exceed `CHUNK_SIZE`, and the running total may not exceed the declared size.
  - **Room message spoofing.** `from`/`fromName` came straight from the envelope, so one room member could post as another. A live chat frame is now accepted only if its author matches the authenticated sender. Relayed history still carries third-party authorship by necessity and is marked `relayed` in the UI; see `SECURITY.md`.
  - **Weak path containment.** The static handler used `filePath.startsWith(PUBLIC_DIR)`, which would also accept a sibling directory whose name merely begins with it. Now `path.resolve` plus a `PUBLIC_DIR + sep` comparison, with traversal attempts covered in the tests.
  - Security headers were only on static files; `/config.json`, `/healthz`, 401s, 404s and 400s missed them. All responses now share one header set, with `X-Robots-Tag: noindex` added.
  - `.env.example` never documented `AUTH_TOKEN`, `ALLOWED_ORIGINS`, or `TRUST_PROXY`, so the security knobs were undiscoverable there.
- **Four bugs found and fixed while testing this work:**
  - **Unauthenticated remote crash.** `VALIDATORS[msg.type]` walked the prototype chain: `type: "__proto__"` resolved to a non-function and threw out of the socket `data` handler, taking the process down, while `type: "constructor"` resolved to `Object` — callable and truthy — so it *passed* schema validation. The table is now null-prototype and looked up with `Object.hasOwn`, and every message handler runs inside a try/catch so no future bug can cost more than one connection. Found by `tests/fuzz.test.js`.
  - **Type coercion in validation.** `DEVICE_ID_PATTERN.test(undefined)` stringifies to `"undefined"`, which satisfies the device-id character class, so a `register` with no device ID passed validation and then threw downstream. All pattern checks now confirm the type first. Also found by the fuzzer.
  - `stop()` never resolved when an upgraded socket did not complete the closing handshake, so `SIGTERM` hung until the container runtime sent `SIGKILL`. Shutdown now force-terminates after a short grace period.
  - `renderSession()` rebuilt the entire timeline on every 64 KiB chunk, which made controls inside an active transfer effectively unclickable and did O(messages) DOM work per chunk. Progress ticks now update only the progress bar, and full renders are coalesced.

- **Licensed MIT**, with `LICENSE` and the `package.json` field.
- **Tooling.** ESLint flat config and `tsc --noEmit` with `checkJs`, both wired
  into CI. TypeScript is a dev-only dependency and the browser still loads the
  same plain ES modules — the "no compile step" property is intact. Strictness is
  a documented ratchet: `strictNullChecks` (52 findings) then `noImplicitAny`
  (388) are the next two steps, tracked in `TODO.md`.
- **UX pass.** In-app rename dialog replacing `prompt()`; drag-and-drop onto a
  device row, a room row, or the open session; paste-to-send for text and files
  with a target picker when nothing is open; light/dark/system theme; a
  known-devices screen for reviewing and forgetting remembered fingerprints;
  candidate path and live throughput columns; and an accessibility pass (skip
  link, focus management and restoration, keyboard paths, `prefers-reduced-motion`,
  forced-colors, labelled landmarks, `scope` on headers).
- **One more bug found while testing the UX work:** the device and room tables
  are rebuilt wholesale on every presence update and every 3-second stats tick,
  which detached whatever the user had focused — so a keyboard user lost focus
  every few seconds, and focus could not be restored when the session panel
  closed. Row controls now carry stable `data-focus-key`s and focus is preserved
  across re-renders.

- **Server relay for messages and files.** Reverses the "no server-side payload relay" non-goal, because direct transfer depends on ICE succeeding and can simply fail on routed, VPN or firewalled networks. Both go direct when possible and fall back per recipient — including a file whose link dies mid-transfer — to the server: messages over the WebSocket, file bodies over HTTP. Everything is sealed to each recipient's signed seal key and signed by the sender, with the item kind inside the signature, so the server stores ciphertext it can neither read nor forge, and a relayed message carries verified authorship. Items live in the container's own layer with no volume, one directory per conversation (the same two devices or the same room always share one). An item is unlinked once every recipient has it; otherwise it deliberately stays — through every device disconnecting — until its conversation ends — 15 minutes after every device party to it disconnects, 3 hours for a one-to-one session left with a single device, 3 days absolute — and the sweep removes it, along with any emptied directory. A device that returns within the window receives what it missed. `blobstore.js`, `public/relay.js`, `deploy/`.
- **Offline devices and away members.** The server remembers the signed key record of every device seen within the half-open session window (3 hours by default), so a known device that is offline is still listed and can be sent to through the relay; a room member whose connection drops stays *away* in its seat instead of leaving. A failed relayed download retries by itself on reconnect.
- **Larger rooms.** `ROOM_MAX_MEMBERS` (default 20, clamped to 2–64). Up to six members keep the direct mesh; past that a room is relay-only — no links, one sealed upload per file, relayed messages batched under the WebSocket frame limit. No per-link safety codes in that mode (see `SECURITY.md`).
- **Accept / decline incoming files.** Settings: ask for new devices (default), always ask, or accept automatically. A pending direct transfer is paused per recipient (`transfer-cancel` with reason `awaiting-consent`, so other room members keep receiving); a pending relayed file stays on the server until accepted, and declining releases it.
- **Share target for files.** Manifest `share_target` is now a multipart POST to `/share`. The service worker catches it, holds the files in memory, and redirects to `/?shared=<id>`; the page collects them and shows a banner with a target picker that includes offline devices. The server's `/share` only ever discards the body and redirects to `/?shared=failed`.
- **CI and release fixes.** The pushed commit could not start: `server.js` imported `blobstore.js`, which the Dockerfile never copied, and nothing ran the image to notice. The Dockerfile now copies it and CI smoke-tests the built image before pushing. Trivy was pinned to a tag that does not exist (`0.28.0`; the project uses `v`-prefixed tags), CodeQL lacked `actions: read`, and every action was moved to a Node 24 major.

**See `TODO.md`** for the tracked backlog; the sections below are the original
handoff's recommendations with their current status.

## Recommended improvements before public release

The protocol, room, and security sections below are done; UX is still open.

### Protocol / reliability — done

- Explicit protocol version negotiation, refusing a non-overlapping peer before key derivation and not retrying it until the user asks.
- Transfer IDs, cancel from either end, and resume from the chunk ranges the receiver already holds.
- Incremental SHA-256 (`public/sha256.js`) over each chunk, verified on receive; a mismatch is discarded rather than saved.
- Defensive caps for messages and files per conversation, sync-state size, control-frame and chunk sizes, queued ICE candidates, and concurrent outbound transfers.
- Bounded reconnect: exponential backoff with jitter, eight attempts, then `Unreachable` plus a manual Retry.

Still open here:

- Move large-file receive to the File System Access API where supported, to avoid retaining whole blobs in RAM; keep a fallback for Safari.
- Explicit chunk acknowledgements. Resume currently checkpoints on what the receiver holds when it next asks, which is enough to avoid re-sending but gives the sender no live delivery signal.
- Test perfect-negotiation instead of the designated-offerer scheme. The scheme holds because each link is still exactly two devices and is torn down rather than renegotiated, but it has only been exercised on loopback and on a LAN.
- Cap the per-peer count of simultaneously negotiating links. A device joining a full room opens five at once with no throttling.
- The sender hashes the file in a pass before transmitting, so a large file is read twice. Fine on a desktop, worth measuring on mobile.

### Ephemeral rooms / multi-party — done

Shipped as described above. What the implementation deliberately left open:

- No group key: a room of six is fifteen independently keyed links with fifteen safety codes, which does not scale as a verification story.
- No relay between members, so a pair that cannot reach each other directly only converges through a third member's manifest sync.
- Fan-out is naive — a sender uploads each file once per recipient with no coordination between recipients.
- Room membership is whatever the signaling server says; a hostile server can add a device to a room's member list.

### Security — mostly done

- Optional `AUTH_TOKEN` gate over the page and the WebSocket upgrade, exchanged once for an `HttpOnly; SameSite=Strict` HMAC cookie so the token stops travelling in URLs. `/healthz` stays open for the container healthcheck.
- Origin checks on the upgrade, defaulting to the request's own host, overridable with `ALLOWED_ORIGINS`, and proxy-aware only when `TRUST_PROXY` is set.
- Per-connection message and signaling token buckets, a per-address concurrent-connection cap, a per-address registration budget, and socket closure after repeated schema violations.
- Strict schema validation of every inbound message, including SDP size/type-consistency and ICE candidate length and range checks. Forwarded signaling is re-serialised from validated fields only.
- `npm audit --audit-level=high` and a Trivy scan that gates the image **before** it is pushed; CodeQL on push/PR/weekly; Dependabot on npm, Actions, and the Docker base image.

- Long-lived signed device identities with fingerprint-derived IDs and TOFU, replacing server-asserted identity. See "Signed device identity" above.
- Fuzzing of the signaling parser: `tests/fuzz.test.js` throws structured garbage and mutated-but-valid signals at a live server and asserts nothing invalid is forwarded, nothing crashes it, and extra keys are stripped. Run other seeds with `FUZZ_SEED=<n>`.

Still open here:

- Commission a protocol/security review before making strong security claims. The scanners and the fuzzer in CI are not a review.
- `AUTH_TOKEN` is a single shared secret with no rotation or revocation. Now that devices have real identity keys, per-device authorisation (an allowlist of fingerprints) is the obvious next step and would also fix the "hostile server adds a device to a room" hole.
- The signaling server is still trusted for **membership** and for **serving the code**. Identity is now proven, but a compromised server can still add a device it controls to a room's member list, and it serves `app.js` in the first place.
- TOFU accepts the first sighting unverified. There is no out-of-band pairing flow, and no UI to review or revoke remembered devices.
- The frame decoder (`handlePlainFrame`) is fuzzed only indirectly, via the patched-peer browser tests. It has no property-based test of its own.
- **Per-message signatures.** Live chat frames are author-checked, but relayed history is not verifiable. Signing each message with the author's identity key and carrying the author's public key in the envelope would make history self-verifying, at roughly +176 bytes per message and one ECDSA verify per newly merged message (a 2000-message catch-up would be seconds of crypto on a phone, so it would want lazy or batched verification).

### UX

Mostly done now:

- In-app rename dialog replacing `prompt()`.
- Drag-and-drop onto a device row, a room row, or the open session.
- Paste-to-send for text and files, with a target picker when no session is open.
- Accept/decline for incoming files, and a share target for files.
- A screen for reviewing and forgetting remembered devices.
- Candidate path (host/srflx/relay, with relay highlighted) and live throughput in the table.
- Light/dark/system theme with a persisted choice, plus an accessibility pass.

Still open:

- **QR code** for the server URL and device code. Deliberately skipped: it needs a QR encoder written from scratch, and there is no QR decoder available here to verify the output actually scans, so it would ship unverified. Add a decoder as a dev dependency for the test, or vendor an audited encoder.

### Name / release housekeeping — done

Renamed from the `drop-pak` working codename to `aria-drop`. The name is still confined to a small number of obvious files if it ever has to change again.

## Deliberate non-goals in v0.1

- No cloud/file database.
- Optional SQLite accounts provide preference sync and private automatic connections between online devices. Account trust is temporary; sign-out clears local chats and revokes relationships and room seats. Account direct chats do not restore peer history.
- No durable chat history.
- ~~No server-side payload relay fallback.~~ **Reversed:** messages and files now fall back to a sealed, signed server relay when a direct link cannot be made, and wait there, for as long as their conversation lives, for a recipient who has not collected them.
- No guarantee of huge-file support on memory-constrained mobile browsers.
- No claim of audited secure-messenger-grade E2EE.
