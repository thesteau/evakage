# drop-pak (working codename)

> **Naming note:** `drop-pak` is intentionally only a working codename. A similarly named mark already exists, so rename before a public release. The UI/app name is kept easy to search-and-replace.

A Docker-first, browser-first experiment for ephemeral local peer communication. It combines the parts that feel good in LAN drop tools—automatic peer discovery and click-a-device actions—with encrypted text chat, links, and browser-to-browser file transfer.

## What it does

- Automatically advertises connected browser peers in a table.
- Shows device name, short code, platform/browser, connection state, RTT, and WebRTC bytes sent/received.
- Opens a direct peer session from the table with **Chat**, **Text**, or **File** actions.
- Provides **connect by code** as a fallback if presence UI is stale or awkward.
- Uses WebRTC DataChannels for peer payload transport.
- Adds an application-layer ephemeral ECDH/AES-GCM encryption layer on top of WebRTC transport encryption.
- Displays a short session safety code derived from both ephemeral public keys.
- Keeps messages and completed file blobs **only in browser memory**.
- Re-syncs chat/file metadata from a surviving peer when the other browser reconnects with the same local device identity.
- Allows a returned peer to request an in-memory file again from the surviving peer.
- Contains no server-side chat/file database.
- Includes a PWA manifest/service worker, but works as a normal browser page.

## Ephemeral semantics

The signaling server knows who is currently online and routes WebRTC negotiation messages. It does **not** receive application chat/file payloads.

Conversation/file state is held in browser memory. A stable device ID and display name are the only values kept in `localStorage`.

If browser A disappears and browser B stays open, B retains the session. When A returns with the same device ID, B can reconnect and send chat/file metadata back over the peer channel. Completed file blobs held by B remain requestable.

If **all participating browser instances lose their in-memory state** (closed/reloaded/crashed), there is intentionally nothing to recover. That is the deletion boundary.

## Run with Docker Compose

```bash
docker compose up -d --build
```

Open `http://SERVER-IP:3000` on two devices. For a homelab deployment, put it behind your reverse proxy at something like `https://drop.home.arpa`.

HTTPS is strongly recommended for normal deployment because browser secure-context APIs and PWA behavior are more reliable there.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `MAX_FILE_BYTES` | `536870912` | Browser-side per-file admission limit advertised to clients |
| `ICE_SERVERS_JSON` | `[]` | JSON array of standard `RTCIceServer` objects for STUN/TURN |

On the same LAN, host ICE candidates are usually sufficient. If peers are separated by routed networks, restrictive firewalls, or VPN topology, configure TURN.

## GHCR publishing

`.github/workflows/ghcr.yml`:

- runs tests on PRs and pushes;
- builds `linux/amd64` + `linux/arm64` images;
- logs into GHCR with `GITHUB_TOKEN` on non-PR events;
- publishes `latest` from the default branch plus branch/tag/SHA tags.

After the first successful publish, set package visibility/permissions in GitHub to match how you want to distribute it.

## Local development

```bash
npm install
npm test
npm run dev
```

Then open `http://localhost:3000`.

## Threat model in one paragraph

The server is designed not to see chat/file payloads. WebRTC provides DTLS-encrypted DataChannels and the app additionally encrypts payload frames using an ephemeral ECDH-derived AES-GCM key. The displayed safety code can be compared out-of-band if you want to detect active interception. This MVP has **not** undergone a security audit; see `SECURITY.md` and `CODEX_HANDOFF.md` before exposing it beyond a trusted environment.
