# Security notes

This is an MVP, not an audited secure messenger.

## Current design

1. The Node server serves static assets, publishes presence, resolves short device codes, and relays WebRTC signaling JSON.
2. Chat/file payloads are sent over browser-to-browser WebRTC DataChannels, not WebSocket signaling.
3. Each DataChannel session generates fresh P-256 ECDH keys in the browsers. The derived AES-256-GCM key encrypts application control messages and file chunks.
4. A short safety code is derived from the two ephemeral public keys. Users can compare it out-of-band when authentication matters.
5. Message text and completed file blobs are kept only in JS memory. Device ID/name are persisted locally; payloads are not.

## Important caveats

- A malicious/compromised signaling service can attempt active interception. The safety code is the current manual authentication mechanism; there is no durable identity key or TOFU database yet.
- No formal protocol review, fuzzing, penetration test, CSP audit, or dependency audit has been performed.
- A peer can consume memory by sending data. The configured file-size limit is useful but not a complete resource-abuse defense.
- Browser memory can be paged/swapped by the OS. "Memory only" does not mean forensic impossibility.
- File names/types are untrusted. Downloads are offered as blobs and are never executed by the app.
- TURN relays, if configured, can observe traffic metadata and encrypted packet sizes/timing but should not receive plaintext application payloads.
- Presence is intentionally visible to all clients connected to this signaling server. Put the service behind trusted-network access controls if that is not acceptable.

Do not expose this MVP directly to the public Internet without authentication/rate limiting and a review of the items in `CODEX_HANDOFF.md`.
