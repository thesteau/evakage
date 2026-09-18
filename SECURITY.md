# Security notes

This is an MVP, not an audited secure messenger.

## Current design

1. The Node server serves static assets, publishes presence, tracks room membership, resolves short device/room codes, and relays WebRTC signaling JSON.
2. Chat/file payloads are sent over browser-to-browser WebRTC DataChannels, not WebSocket signaling.
3. Each DataChannel session generates fresh P-256 ECDH keys in the browsers. The derived AES-256-GCM key encrypts application control messages and file chunks.
4. A short safety code is derived from the two ephemeral public keys. Users can compare it out-of-band when authentication matters.
5. Message text and completed file blobs are kept only in JS memory. Device ID/name are persisted locally; payloads are not.
6. Rooms are a full mesh of those same pairwise sessions. There is no group key: each link is encrypted separately and has its own safety code, so a room of six has fifteen independently keyed links.
7. Peers negotiate an application protocol version during the key handshake and refuse a non-overlapping peer before deriving a key.
9. Each browser holds a long-lived, non-extractable ECDSA P-256 key in IndexedDB. The device ID is the SHA-256 fingerprint of its public half, and each peer signs a transcript binding both ephemeral ECDH keys and both nonces. A peer whose key does not hash to its advertised ID, or whose signature does not verify, is refused before the derived key is used for anything. The displayed safety code is derived from the two long-lived fingerprints, so it is stable and worth comparing once out of band. Devices are remembered on first use and shown as `new` or `known`.
8. Files carry a SHA-256 computed by the sender. The receiver verifies the assembled bytes and discards a mismatch instead of offering it for saving. This detects corruption and tampering by a relay; it is not a defence against a peer that lies about both the bytes and the digest, which is what the per-link safety codes are for.

## Server-side controls

- **Schema validation.** Every WebSocket message is matched against an explicit shape before any handler sees it. Signaling is re-serialised from validated fields only, so unknown keys never reach the other peer. SDP is size-capped and its inner type must match its envelope; ICE candidates are length- and range-checked.
- **Rate limiting.** Per-connection token buckets for messages and (more strictly) for signaling, a per-address cap on concurrent connections, and a per-address registration budget. Repeated schema violations close the socket.
- **Origin checks.** WebSocket upgrades must carry an `Origin` matching the request's own host, or one listed in `ALLOWED_ORIGINS`. Requests with no `Origin` (non-browser clients) are still allowed.
- **Optional authentication.** `AUTH_TOKEN` gates the page and the upgrade; the token is exchanged once for an `HttpOnly; SameSite=Strict` cookie holding an HMAC, so the token itself stops travelling in URLs. `/healthz` stays open.
- **Proxy awareness.** `X-Forwarded-Host` and `X-Forwarded-For` are honoured only when `TRUST_PROXY` is set.

These bound resource abuse and casual cross-site access. They are **not** a substitute for keeping the service on a trusted network.

## Important caveats

- A malicious/compromised signaling service can no longer impersonate a peer, because device IDs are key fingerprints and possession is proved by signature. It can still **deny** service, observe who is online and who talks to whom, add a device it controls to a room's member list, and serve a modified `app.js` on next load — serving the code means it is trusted for the code. The per-device `known`/`new` marker and the stable safety code are what expose an unexpected device.
- Trust-on-first-use is exactly that: the first sighting of a device is accepted without verification. Compare the safety code out of band the first time a device shows as `new` if it matters.
- The identity key lives in IndexedDB, unencrypted at rest and readable by anything with access to the browser profile. It is non-extractable, so it cannot be exported by script, but a compromised device is a compromised identity.
- Clearing site data, or a browser evicting storage, destroys the identity. The device then reappears as a new device with a new ID and a new safety code.
- No formal protocol review, fuzzing, or penetration test has been performed. `npm audit`, CodeQL, and Trivy run in CI, but automated scanning is not a review.
- A peer can consume memory by sending data. The configured file-size limit and the client-side caps (messages and files per conversation, sync-state size, chunk size, queued ICE candidates, concurrent transfers) bound this but are not a complete resource-abuse defence.
- `public/sha256.js` is a hand-written hash used for integrity only, never for secrecy or authentication. It is checked against `node:crypto` across sizes, block boundaries, and streaming splits, but it has not been independently audited.
- Installing the PWA caches the app shell. A cached build keeps running until the user accepts the update banner, so a security fix is not guaranteed to be live immediately after deploy.
- Browser memory can be paged/swapped by the OS. "Memory only" does not mean forensic impossibility.
- File names/types are untrusted. Downloads are offered as blobs and are never executed by the app.
- TURN relays, if configured, can observe traffic metadata and encrypted packet sizes/timing but should not receive plaintext application payloads.
- Presence is intentionally visible to all clients connected to this signaling server. Put the service behind trusted-network access controls if that is not acceptable.
- Rooms and their codes/membership are advertised to every client connected to the signaling server, and any of them can join a room that is under its size cap. Room codes are discovery aids, not access control; a room is exactly as private as the network the server sits on.
- Room membership is asserted by the server. A client only accepts room traffic for rooms it joined itself, but a malicious signaling server could still add a device it controls to a room's membership list — the per-link safety codes are what would expose that.
- Room history is replicated to every member and merged by message ID. Any member can therefore rebroadcast what it holds; leaving a room does not retract what others already received.
- **Messages are not individually signed.** A live chat frame is only accepted if its declared author matches the authenticated peer that sent it, so a room member cannot post as another member in real time. History recovered through a sync, however, legitimately carries third-party authorship — that is how a rejoining peer catches up — and a member could inject fabricated history attributed to someone else. Such messages are marked `relayed` in the UI with the relaying device named, and are only as trustworthy as that device. Per-message signatures with the author's identity key would close this; they are not implemented.

Do not expose this MVP directly to the public Internet without authentication/rate limiting and a review of the items in `CODEX_HANDOFF.md`.
