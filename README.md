# aria-drop

A Docker-first, browser-first experiment for ephemeral local peer communication. It combines the parts that feel good in LAN drop tools—automatic peer discovery and click-a-device actions—with encrypted text chat, links, and browser-to-browser file transfer, one-to-one or in a small room.

## What it does

- Automatically advertises connected browser peers in a table.
- Shows device name, short code, platform/browser, connection state, RTT, and WebRTC bytes sent/received.
- Opens a direct peer session from the table with **Chat**, **Text**, or **File** actions.
- Provides **connect by code** as a fallback if presence UI is stale or awkward.
- Hosts **ephemeral rooms** (up to 20 devices by default), joined from the room table or by room code.
- Uses WebRTC DataChannels for peer payload transport.
- Adds an application-layer ephemeral ECDH/AES-GCM encryption layer on top of WebRTC transport encryption.
- Displays a short safety code derived from both devices' long-lived identity keys, stable across sessions.
- Installs as a PWA on phones, tablets, and desktops, with an offline app shell, and appears in the phone's share sheet for files, text and links.
- Keeps messages and completed file blobs **only in browser memory**.
- Re-syncs chat/file metadata from any surviving peer when a browser reconnects with the same local device identity.
- Allows a returned peer to request an in-memory file again from whichever peer still holds the bytes.
- Falls back to a **server relay** for messages and files when a direct connection cannot be made — sealed so the server cannot read them, deleted once delivered, with access expiring after 24 hours by default.
- Asks before receiving files from a device you have not met (configurable).
- Contains no server-side database.
- Verifies every device's long-lived identity key and shows a stable safety code.
- Works as an ordinary browser page too — installing is optional.

## Ephemeral semantics

The signaling server knows who is currently online, tracks room membership, and routes WebRTC negotiation messages. It receives a message or a file only when that item goes through the relay (below), and then only as ciphertext sealed to the recipient.

Conversation/file state is held in browser memory. A stable device ID and display name are the only values kept in `localStorage`.

If browser A disappears and browser B stays open, B retains the session. When A returns with the same device ID, B can reconnect and send chat/file metadata back over the peer channel. Completed file blobs held by B remain requestable.

If **all participating browser instances lose their in-memory state** (closed/reloaded/crashed), there is intentionally nothing to recover. That is the deletion boundary.

## Server relay

Direct browser-to-browser transfer needs ICE to succeed. On a routed LAN, behind
a VPN, or with a restrictive firewall it can fail outright, and then nothing gets
through. So messages and files have a second path through the server that works
regardless:

- **Automatic.** An item goes direct when a direct link is available, and through
  the server for any recipient it cannot reach — including one whose link drops
  part-way through a file. Each recipient gets each item exactly once, by one
  path. Files wait up to 5s for a direct link, messages 2.5s; once a direct link
  has failed for a device, later messages to it go straight to the server for
  30s while the link keeps retrying. Anything that went this way is marked
  `via server`.
- **Or forced.** Tick **Via server** in the session toolbar to skip the direct
  attempt entirely, for a network where you know it never works.
- **Sealed.** Each device has a long-lived key for this, signed by its identity
  key and verified by the sender before use. A message is sealed to each
  recipient directly. A file is encrypted with a random key, and that key — with
  the file's name, type and SHA-256 — is sealed separately to each recipient.
  The server stores ciphertext and opaque envelopes. It learns sizes and who is
  sending to whom, never content.
- **Signed.** Every envelope is also signed by the sender's identity key, so a
  recipient knows the item really came from that device even if the server lies
  about who sent it. A relayed message is therefore verified authorship, unlike
  history recovered from another peer during a sync.
- **Verified.** A relayed file's SHA-256 is checked after decrypting, exactly as
  for a direct transfer.

**Lifetime.** Each conversation gets its own directory on the server: the same
two devices, or the same room, always share one; a new pairing or room gets a
new one.

- An item is deleted as soon as every recipient has received it.
- If a recipient has not taken it yet, it **stays** — including after both
  devices have disconnected — so a device that comes back within the window
  still receives what was sent to it.
- At **24 hours** (configurable), items stop appearing in pending delivery and
  cannot be claimed, uploaded, or newly downloaded, even with an earlier token.
  Uploads that cross the deadline are rejected. A download opened before expiry
  may finish afterward; already delivered copies cannot be recalled.
- Disk cleanup is separate: the default 15-minute sweep removes expired
  ciphertext and empty directories. Scheduling delays can postpone cleanup;
  there is no exact physical-deletion deadline.
- A server restart or a recreated container erases everything immediately. Item
  records live only in the server's memory, so a restart ends items early,
  never late.

It lives inside the container with no volume, so it is never exposed on the
host. See `deploy/README.md` for an optional host cron.

## Ephemeral rooms

Rooms extend the same model to a small group. Create one from the rooms table, then share its `ABCD-EFGH` code with the other devices — or let them join from the table, since rooms are advertised to everyone connected to the server.

- **Up to six members, transport is a full mesh.** Every member holds one DataChannel per other member, each with its own ECDH/AES-GCM key and its own safety code (hover a member chip to read it). Nothing is relayed through other peers; a member a direct link cannot reach gets its copy through the server relay instead, sealed to it.
- **Past six, a room runs through the server.** A mesh costs O(n²) connections and a sender uploads each file once per recipient, so a bigger room opens no direct links at all: every message and file goes through the relay, sealed separately to each member, and a file is uploaded once however many members there are. The room says `Large room · sealed to each member via server`. There are no per-link safety codes in this mode — authenticity rests on each item's signature. The cap is `ROOM_MAX_MEMBERS` (default 20, at most 64).
- **Dropping off does not lose your seat.** A member whose connection drops shows as *away*: it keeps its seat, is still sent to through the relay, and catches up when it rejoins. Leaving on purpose gives the seat up; so does reloading without rejoining, or 24 hours away.
- **A room survives while at least one member is still connected.** The last participant leaving destroys the server-side record, and the payloads only ever existed in the participants' browsers. If signaling blips while your browser is still open, it restores the room on reconnect rather than losing it.
- **History heals itself.** Messages and file manifests carry immutable IDs, so every pair of peers exchanges its full manifest when their link comes up and merges by ID. A device that rejoins after a reload recovers what the survivors still hold, with no elected leader and no duplicates.
- **File bytes are never re-broadcast on rejoin.** A returning member sees the file metadata and pulls the bytes on demand from a peer that still has them; if nobody online holds them any more, the entry reads `Gone`.

Rooms and direct sessions share the same pairwise links — being in a room with someone and DMing them uses one connection, not two.

## Run with Docker Compose

To run a published image, use the `deploy/` folder — it pulls from GHCR and never
builds; see `deploy/README.md`:

```bash
cd deploy && docker compose up -d
```

To build from this checkout instead, use the root compose file:

```bash
docker compose up -d --build
```

Open `http://SERVER-IP:3712` on two devices. For a homelab deployment, put it behind your reverse proxy at something like `https://drop.home.arpa`.

The container listens on 3000 and Compose publishes it on **3712**; change the left-hand side of the `ports` mapping to move it.

HTTPS is effectively required for anything but `localhost`: WebCrypto, IndexedDB-backed identity, service workers, and installability all need a secure context. Put it behind your reverse proxy with a certificate and set `TRUST_PROXY=1`.

## Phones and tablets

Open the server URL and install it:

- **Android / Chrome / Edge** — an **Install app** button appears in the header; the browser's own install prompt also works.
- **iOS / Safari** — Share → *Add to Home Screen*. There is no install API on iOS, so the header button explains this instead of pretending to install.

Once installed it runs full-screen with no browser chrome, respects display cutouts and home indicators, and the app shell opens offline (it will simply report signaling as disconnected until it can reach the server).

Mobile-specific behaviour:

- **Layout.** Below 700px the device and room tables become labelled cards instead of a seven-column table in a horizontal scroller, and controls meet the 44px touch-target minimum.
- **Backgrounding.** iOS tears down WebSockets and peer connections when you lock the screen or switch apps. Returning to the foreground re-checks signaling and rebuilds any dead links rather than waiting on a timer that was suspended too.
- **Screen lock during transfers.** A screen wake lock is held only while a transfer or hash is actually in flight, and released as soon as nothing is, so a long transfer is not killed by the display sleeping.
- **Share target.** Once installed, aria-drop appears in the share sheet of other apps. Shared text or a link is prefilled in the composer; shared files wait behind a banner until you pick a device or room — including a device that is offline, which gets them through the relay. The files are caught by the service worker and never reach the server unencrypted. (Android and desktop Chrome/Edge; iOS does not support web share targets.)
- **Updates.** A new build never reloads the page underneath you; a banner offers the reload, so an in-flight transfer is not interrupted.

Large files remain the weak spot on phones: received blobs are held in memory until saved, and a memory-constrained browser may evict the tab. That is a known limitation, not a solved problem.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `MAX_FILE_BYTES` | `536870912` | Browser-side per-file admission limit advertised to clients |
| `ICE_SERVERS_JSON` | `[]` | JSON array of standard `RTCIceServer` objects for STUN/TURN |
| `AUTH_TOKEN` | *(unset)* | When set, the whole server needs this token. Open `https://host/?token=THE_TOKEN` once and the server trades it for an `HttpOnly; SameSite=Strict` session cookie that also authorises the WebSocket upgrade. `/healthz` stays open for the container healthcheck. |
| `ALLOWED_ORIGINS` | *(same host)* | Comma-separated exact origins permitted to open the WebSocket. Unset means "must match the request's own host", which is what you want behind a normal reverse proxy. |
| `TRUST_PROXY` | `0` | Set to `1` only when a proxy you control sits in front. It makes the server believe `X-Forwarded-Host` (for origin checks) and `X-Forwarded-For` (for per-address limits). Leave it off if clients can reach the port directly, or they can spoof both. |
| `BLOB_DIR` | `/tmp/aria-drop-blobs` in the image | Where relayed messages and files wait, one subdirectory per conversation. Keep it inside the container; do not mount a volume here. |
| `BLOB_MAX_AGE_MS` | `86400000` (24h) | Age from offer creation at which relay access expires. Disk removal follows on the sweep. |
| `BLOB_SWEEP_MS` | `900000` (15 min) | How often the age sweep runs. It also removes any empty conversation directory. |
| `BLOB_STORE_BYTES` | `4294967296` (4 GiB) | Total space all buffered transfers may use together. |
| `BLOB_PER_DEVICE` | `32` | Files one device may have waiting on the server at once. |
| `BLOB_MESSAGES_PER_DEVICE` | `2000` | Messages one device may have waiting on the server at once. |
| `ROOM_MAX_MEMBERS` | `20` | Seats per room, clamped to 2–64. Rooms of up to six use the direct mesh; larger ones run entirely through the relay. |

On the same LAN, host ICE candidates are usually sufficient. If peers are separated by routed networks, restrictive firewalls, or VPN topology, configure TURN.

The mesh size (6) and the per-server room cap (64) are constants in `server.js`, not environment variables — the mesh cost grows quadratically, so changing it is deliberately a code change. The rate limits and defensive budgets live next to them in the `LIMITS` object.

## Transfer integrity

Every file is hashed with SHA-256 before the first byte leaves the sender, and the digest travels with the metadata. The receiver hashes what it assembled and compares: a mismatch is discarded rather than saved, and the row offers a retry. Verified files show `SHA-256 ✓` with the digest on hover, so it can be checked against a known value out of band.

Hashing is incremental (`public/sha256.js`, checked against `node:crypto` in the test suite) because WebCrypto's `digest()` is one-shot and would need the whole file resident at once.

Transfers carry an ID and can be cancelled from either end. A cancelled or interrupted transfer keeps the chunks that already arrived, and **Resume** tells the sender which ranges to skip, so it picks up where it stopped instead of starting over.

## Device identity

Each browser generates a long-lived, non-extractable ECDSA P-256 key on first run and keeps it in IndexedDB. **The device ID other browsers see is the SHA-256 fingerprint of that key's public half**, and every peer signs a handshake transcript — its own ephemeral key, yours, and both nonces — to prove it holds the matching private key.

That closes the gap where the signaling server was trusted for identity. If a server routes you to a device whose key does not hash to the ID it advertised, or whose signature does not verify, the link is refused before any payload key is used and the reason is shown. Impersonating a peer now requires forging an ECDSA signature rather than editing a presence list.

Because the ID is the fingerprint, the **safety code is stable**: it is derived from both devices' long-lived fingerprints, so it stays the same across reloads, reconnects, and restarts. Compare it out of band once. Devices are also remembered on first use — a peer shows `new` the first time you connect and `known` afterwards; a re-keyed browser appears as a new device rather than silently inheriting the old one's trust.

The key, the display name, and the fingerprints of devices you have seen are the only things persisted. No message or file content is ever written to storage.

## Peer protocol versioning

Browsers negotiate an application protocol version in the same handshake that exchanges their public keys. A peer whose supported range does not overlap this build's is refused before any key is derived, with a message naming both ranges, and is not retried until you press **Retry**. Reconnection uses bounded exponential backoff — after eight failed attempts a peer is marked `Unreachable` rather than retried forever.

## GHCR publishing

`.github/workflows/ghcr.yml`:

- runs lint, type checking, tests, and `npm audit --audit-level=high` on PRs and pushes;
- builds a single-arch image and fails on HIGH/CRITICAL Trivy findings **before** anything is pushed;
- builds `linux/amd64` + `linux/arm64` images;
- logs into GHCR with `GITHUB_TOKEN` on non-PR events;
- publishes `latest` from the default branch plus branch/tag/SHA tags.

`.github/workflows/codeql.yml` runs CodeQL on pushes, PRs, and weekly. `.github/dependabot.yml` watches npm, GitHub Actions, and the Docker base image.

After the first successful publish, set package visibility/permissions in GitHub to match how you want to distribute it.

## Using it

- **Send a file** — drag it onto any device or room row, drop it on an open
  session, or use **Send file** in the session toolbar. Paste works too:
  <kbd>Ctrl/Cmd+V</kbd> anywhere on the page sends clipboard files or text, and
  asks where to send if no session is open.
- **Send text or a link** — open a session and type, or paste and press Enter.
- **Rooms** — create one and share its `ABCD-EFGH` code, or join from the table.
  Dropping a file on a joined room sends it to every member.
- **Theme** — the header toggle cycles system → light → dark and remembers the
  choice.
- **Known devices** — review the devices this browser remembers, and forget any
  of them, from **Known devices** in the header.
- **Incoming files** — **Settings** in the header chooses what happens when a
  device sends you a file: *ask for new devices* (the default), *always ask*, or
  *accept automatically*. When asked, nothing is received until you press
  **Accept**; the sender sees that it is waiting. **Decline** tells the sender,
  and a file waiting on the server is deleted there. Messages are never gated.
- **Keyboard** — everything is reachable by Tab; <kbd>Esc</kbd> closes the
  session panel and dialogs, and focus is returned to wherever it came from.
  The device and room tables re-render constantly, and focus survives that.

The **Path** column shows the actual ICE candidate pair (`host↔host`, `srflx↔host`,
or a highlighted `relay`), so a slow transfer can be diagnosed as "this is going
through TURN" rather than guessed at. **Rate** is live throughput, not a lifetime
average.

## Local development

```bash
npm install
npm run check     # lint + typecheck + tests
npx playwright install chromium  # once, for browser tests
npm run test:e2e  # isolated Chromium peers and server; no running app needed
npm run dev
```

Then open `http://localhost:3000`.

`npm run lint` is ESLint (flat config). `npm run typecheck` is `tsc --noEmit`
with `checkJs`: **the project stays plain ES modules with no build step** —
TypeScript is a dev-only dependency that type-checks the JavaScript in place, so
the browser loads exactly the files in `public/`. The strictness settings in
`tsconfig.json` are a deliberate ratchet; see `TODO.md` for the next step.

`strictNullChecks` is enabled. The browser suite in `e2e/` covers discovery,
bidirectional chat, direct and forced-relay file transfers, accept/decline,
zero-byte files, reload recovery of history and file bytes, offline app shell,
worker file/text sharing and expiry, forged identity/signature rejection,
cancel/resume, and room recovery after disconnect. Each test owns its server, temporary relay directory, and browser
contexts. Chromium runs in CI before container publishing; failure traces are
kept in `test-results/` and uploaded as CI artifacts. Inspect one with
`npx playwright show-trace <path-to-trace.zip>`.

## Known gaps

`TODO.md` tracks what is missing, why, and what it would cost. The short version:
history recovered from another peer during a sync is not signed (it is marked as
unverified rather than trusted — messages that came through the server relay are
signed), no per-device authorisation, large files still live in RAM
on the receiving side, and browser coverage still needs real-device Safari/Android
and larger-room scenarios.

## License

MIT — see `LICENSE`.

## Threat model in one paragraph

The server is designed not to be able to read chat or files. Anything that reaches it through the relay arrives as ciphertext sealed to the recipient and signed by the sender; access expires after 24 hours by default and disk cleanup follows on the sweep. WebRTC provides DTLS-encrypted DataChannels and the app additionally encrypts payload frames using an ephemeral ECDH-derived AES-GCM key. The displayed safety code can be compared out-of-band if you want to detect active interception. This MVP has **not** undergone a security audit; see `SECURITY.md` and `CODEX_HANDOFF.md` before exposing it beyond a trusted environment.
