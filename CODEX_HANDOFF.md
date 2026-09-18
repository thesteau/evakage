# Codex handoff: build context, tests, and improvements

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

The current MVP implements one-to-one sessions. Treat small multi-party rooms as the most obvious next product increment, not as an implicit promise in v0.1.

## Architecture

- **Node 22, dependency-free WebSocket server:** static HTTP server, health/config endpoints, WebSocket presence/signaling.
- **Vanilla browser client:** no compile step/framework.
- **Presence:** every registered browser is advertised to every other browser connected to the server.
- **Identity:** random device UUID + user-visible name in localStorage. Payload state is never placed in localStorage/IndexedDB.
- **Fallback code:** deterministic short code from device UUID while registered; code lookup returns an online peer.
- **WebRTC:** one `RTCPeerConnection`/ordered DataChannel per active peer session.
- **Offer glare avoidance:** lexicographically smaller device ID is the designated offerer. The other side sends a signaling `knock` when it needs a connection.
- **Application crypto:** ephemeral P-256 ECDH per DataChannel connection -> AES-256-GCM. Public keys are exchanged after the WebRTC DataChannel opens. The UI displays a short safety code.
- **State recovery:** both peers exchange full chat history + file metadata after encryption becomes ready. Missing file blobs can be requested from a surviving peer.
- **Files:** encrypted 64 KiB chunks with DataChannel buffered-amount backpressure. Received blobs remain in memory until the page loses state.

## What was tested here

These checks were executed successfully in the build environment:

```bash
npm ci
npm test
node --check server.js
node --check public/app.js
```

The automated Node test covers the health/config endpoints, two WebSocket registrations, presence, deterministic code assignment, and code lookup. It does **not** exercise real browser WebRTC.

**Docker itself is not installed in this build environment, so the image was not actually built or run here.** Codex should run the following first on a Docker-capable machine:

```bash
docker build -t drop-pak:test .
docker run --rm -d --name drop-pak-test -p 3300:3000 drop-pak:test
curl -fsS http://127.0.0.1:3300/healthz
docker stop drop-pak-test
```

## High-priority browser testing

1. **iOS Safari:** two-device discovery, opening a session, sending text/link, foreground/background transitions, app switch, screen lock, re-open, PWA mode.
2. **Safari ↔ Chrome/Firefox:** ICE negotiation and DataChannel binary message behavior.
3. **Reconnect race:** kill Wi-Fi on one device for 10–30 seconds, restore it, confirm the surviving peer re-establishes a channel and history re-syncs without duplicate messages.
4. **Reload recovery:** send chat + file A→B; reload A only; verify B causes reconnection and A receives chat/file metadata; request the old file from B.
5. **Deletion boundary:** close/reload both participants; verify no chat/file payload reappears. Device names/IDs may remain by design.
6. **Large files:** 100 MB, 500 MB, and configured-limit boundary. Watch heap growth, mobile tab eviction, backpressure, and transfer cancellation behavior.
7. **Filename edge cases:** Unicode, very long names, same-name files, zero-byte files.
8. **Network topology:** same Wi-Fi, wired↔Wi-Fi, VLAN routing, Tailscale/WireGuard, TURN-only.

## Recommended improvements before public release

### Protocol / reliability

- Add explicit protocol version negotiation and reject incompatible peers cleanly.
- Add transfer IDs with pause/cancel/resume and chunk acknowledgements/checkpointing.
- Hash files incrementally (SHA-256 or BLAKE3 via audited implementation) and verify after receive.
- Move large-file receive to File System Access API where supported to avoid retaining whole blobs in RAM; keep a fallback for Safari.
- Add per-peer rate limits and defensive caps for message count/history sync size, queued ICE, concurrent transfers, and chunk sizes.
- Test perfect-negotiation instead of the simple designated-offerer scheme if group rooms or renegotiation are added.
- Add bounded reconnect attempt state rather than simple retry timers.

### Ephemeral rooms / multi-party

- Introduce explicit room/session IDs and membership for 3–6 peers.
- Start with full-mesh DataChannels for small trusted groups; document practical room-size limits.
- Define deletion precisely: a room survives while at least one live participant holds its RAM state; the final participant leaving destroys it.
- Re-sync via one elected surviving peer or merge CRDT-like message/file manifests by immutable IDs.
- Avoid automatic retransmission of all file bytes during rejoin; keep metadata sync + on-demand retrieval.

### Security

- Replace/manual-augment the safety code with optional long-lived browser identity keys and TOFU/verified-device fingerprints.
- Authenticate access to the signaling server if it can be reached by untrusted clients.
- Add origin checks and reverse-proxy-aware allowlists for WebSocket upgrades.
- Add WebSocket rate limiting and message schema validation.
- Audit WebRTC signaling for malicious SDP/ICE inputs and resource exhaustion.
- Add dependency scanning (`npm audit`, Dependabot/Renovate, CodeQL) and container scanning (Trivy/Grype).
- Commission protocol/security review before making strong security claims.

### UX

- Replace `prompt()` rename with an in-app dialog.
- Add drag-and-drop files directly onto peer rows.
- Add paste-to-send: when the page is focused and clipboard text exists, make target selection one click.
- Add Share Target/PWA integration where browser support makes sense.
- Show candidate path (host/srflx/relay) and current transfer throughput in the table.
- Add incoming transfer accept/reject mode as an option for less-trusted LANs.
- Add QR representation of the short device code/server URL.
- Add dark/light theme and accessibility pass.

### Name / release housekeeping

`drop-pak` is a working codename only. Rename before public release because of existing similar branding/trademark use. Keep the package/app name in a small number of obvious files so this is easy.

## Deliberate non-goals in v0.1

- No cloud/file database.
- No account system.
- No durable chat history.
- No server-side payload relay fallback.
- No guarantee of huge-file support on memory-constrained mobile browsers.
- No claim of audited secure-messenger-grade E2EE.
