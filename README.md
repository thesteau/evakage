# Evakage

A Docker-first, browser-first experiment for ephemeral local peer communication. It combines the parts that feel good in LAN drop tools—opt-in peer discovery and click-a-device actions—with encrypted text chat, links, and browser-to-browser file transfer, one-to-one or in a small room.

The name combines **Eva-**, evoking evanescence — fading or disappearing — with
**kage (影)**, Japanese for shadow.

## What it does

- Keeps devices private by default; advertising in Settings is opt-in. Paired devices and fellow room members can still see one another.
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
- Falls back to a **server relay** for messages and files when a direct connection cannot be made — sealed so the server cannot read them, deleted once delivered, and otherwise living only as long as the conversation they belong to.
- Asks before receiving files from a device you have not met (configurable).
- Chat, files and joining rooms work without accounts. An account is required to create rooms and can also connect your online devices privately and sync selected preferences.
- Verifies every device's long-lived identity key and shows a stable safety code.
- Works as an ordinary browser page too — installing is optional.

## Ephemeral semantics

The signaling server knows who is currently online, tracks room membership, and routes WebRTC negotiation messages. It receives a message or a file only when that item goes through the relay (below), and then only as ciphertext sealed to the recipient.

Conversation/file state is held in browser memory. Device keys live in IndexedDB; trust records and preferences live in localStorage. Optional account storage contains password hashes and selected preferences, never device keys or content.

If browser A disappears and browser B stays open, B retains the session. When A returns with the same device ID, B can reconnect and send chat/file metadata back over the peer channel. Completed file blobs held by B remain requestable.

If **all participating browser instances lose their in-memory state** (closed/reloaded/crashed), direct-only content cannot be recovered. Self-chat copies remain recoverable from the server within their expiry window.

## Message yourself

Open the first **Devices** entry, marked **This is you**, even with no other devices online, to send notes or upload files to your own device identity. Items are encrypted and signed in the browser before upload. Reading your items keeps the encrypted server copy available after a reload. Reconnect within 24 hours of disconnecting; each item has a hard 3-day limit from creation. Use the same browser profile: clearing its identity or switching browsers prevents decryption. Server restarts still erase buffered items early. These lifetimes apply only to self-chat.

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
  about who sent it. Chat also carries a portable author signature, verified
  on live delivery, relay delivery and recovery through another peer. Altered
  or unsigned history is discarded rather than attributed to the claimed author.
- **Verified.** A relayed file's SHA-256 is checked after decrypting, exactly as
  for a direct transfer.

**Lifetime.** Each conversation gets its own directory on the server: the same
two devices, or the same room, always share one; a new pairing or room gets a
new one.

An item lives with its conversation rather than on a fixed clock. It is deleted
at the first of:

- every recipient has received it;
- **everyone party to it has been gone for 15 minutes** — long enough to survive
  a locked phone, a reload or a wifi drop, so a device that comes back still
  receives what was left for it;
- a **one-to-one conversation has had only one device present for 3 hours**. One
  device waiting on a peer that is not coming back is a stalled session, not a
  live one. Rooms are exempt: a room with one member connected is still a room;
- **3 days**, whatever else is true. A conversation held open that long has
  outlived its usefulness — start a new one rather than leaning on this.

Expiry is about access, not just disk: an expired item stops appearing in
pending delivery and cannot be claimed, uploaded or newly downloaded, even with
a token issued earlier. Uploads that cross the deadline are rejected; a download
opened before expiry may finish afterward, and delivered copies cannot be
recalled. Physical cleanup follows on the sweep (every minute by default), so
there is no exact physical-deletion deadline.

The app shows the countdown next to anything the server is holding, and marks it
when the deadline is close or when the session itself is at its 3-day limit.
- A server restart or a recreated container erases everything immediately. Item
  records live only in the server's memory, so a restart ends items early,
  never late.

It lives inside the container with no volume, so it is never exposed on the
host. See `deploy/README.md` for an optional host cron.

## Ephemeral rooms

Rooms extend the same model to a small group. Create one from the rooms table, then share its `ABCD-EFGH` code with the other devices. Only joined members receive room details, codes, names, membership and transport state. Outsiders see an empty room list. Joining requires the invitation code; a room ID alone does not authorize a new member. All unsuccessful invitation attempts return the same generic response.

Creating a room requires login. Each account can own two active rooms across
all its devices; creating a third destroys the oldest room and its buffered
content. The Create button stays visible and explains login requirements and
replacement through toasts. Joining by code never requires an account.
An ended room cannot be recreated by reconnecting or reusing its invitation.

- **Up to six members, transport is a full mesh.** Every member holds one DataChannel per other member, each with its own ECDH/AES-GCM key and its own safety code (hover a member chip to read it). Nothing is relayed through other peers; a member a direct link cannot reach gets its copy through the server relay instead, sealed to it.
- **Past six, a room runs through the server.** A mesh costs O(n²) connections and a sender uploads each file once per recipient, so a bigger room opens no direct links at all: every message and file goes through the relay, sealed separately to each member, and a file is uploaded once however many members there are. The room says `Large room · sealed to each member via server`. There are no per-link safety codes in this mode — authenticity rests on each item's signature. The cap is `ROOM_MAX_MEMBERS` (default 20, at most 64).
- **Dropping off does not lose your seat.** A member whose connection drops shows as *away*: it keeps its seat, is still sent to through the relay, and catches up when it rejoins. Leaving on purpose gives the seat up; so does reloading without rejoining, or staying away past the relay window (3 hours by default).
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

Keep the app open and the screen unlocked on both devices until transfers finish.
Switching apps or locking your phone can interrupt a transfer. Background transfers
are not guaranteed, even when wake lock is available.

- **Layout.** Below 700px the device and room tables become labelled cards instead of a seven-column table in a horizontal scroller, and controls meet the 44px touch-target minimum.
- **Backgrounding.** iOS tears down WebSockets and peer connections when you lock the screen or switch apps. Returning to the foreground re-checks signaling and rebuilds any dead links rather than waiting on a timer that was suspended too.
- **Screen lock during transfers.** A screen wake lock is requested only while a transfer or hash is actually in flight, and released as soon as nothing is. Browser support and permission vary; keep the screen unlocked yourself if needed.
- **Share target.** Once installed, Evakage appears in the share sheet of other apps. Shared text or a link is prefilled in the composer; shared files wait behind a banner until you pick a device or room — including a device that is offline, which gets them through the relay. The files are caught by the service worker and never reach the server unencrypted. (Android and desktop Chrome/Edge; iOS does not support web share targets.)
- **Updates.** A new build never reloads the page underneath you; a banner offers the reload, so an in-flight transfer is not interrupted.

Large files remain the weak spot on phones. Relayed files are verified and then streamed to disk on Save without being held in memory, when the service worker is in control. Files received directly, and relayed files without the worker, are held in memory until saved, and a memory-constrained browser may evict the tab. Physical-phone memory has not been measured.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `MAX_FILE_BYTES` | `536870912` | Browser-side per-file admission limit advertised to clients |
| `ICE_SERVERS_JSON` | `[]` | JSON array of standard `RTCIceServer` objects for STUN/TURN |
| `AUTH_TOKEN` | *(unset)* | When set, the whole server needs this token. Open `https://host/?token=THE_TOKEN` once and the server trades it for an `HttpOnly; SameSite=Strict` session cookie that also authorises the WebSocket upgrade. `/healthz` stays open for the container healthcheck. |
| `DEVICE_ALLOWLIST` | *(unset)* | Comma-separated full device fingerprints permitted to register. Each must prove possession of its signing key using a fresh socket challenge. Remove a fingerprint and restart to revoke its server access. |
| `ALLOWED_ORIGINS` | *(same host)* | Comma-separated exact origins permitted to open the WebSocket. Unset means "must match the request's own host", which is what you want behind a normal reverse proxy. |
| `TRUST_PROXY` | `0` | Set to `1` only when a proxy you control sits in front. It makes the server believe `X-Forwarded-Host` (for origin checks) and `X-Forwarded-For` (for per-address limits). Leave it off if clients can reach the port directly, or they can spoof both. |
| `ACCOUNTS_DB` | `/home/node/evakage-accounts/accounts.sqlite` in Docker; unset for Node | Optional SQLite account database path. Use a separate persistent account volume; no text or files are stored here. |
| `BLOB_DIR` | `/tmp/evakage-blobs` in the image | Where relayed messages and files wait, one subdirectory per conversation. Keep it inside the container; do not mount a volume here. |
| `BLOB_IDLE_GRACE_MS` | `900000` (15 min) | How long an item outlives the moment every device party to it disconnected. |
| `BLOB_SOLO_MAX_MS` | `10800000` (3h) | How long a one-to-one conversation may sit with only one device present before its items expire. Rooms are exempt. Also how long an offline device stays listed as reachable, and how long an away member keeps its room seat. |
| `BLOB_MAX_AGE_MS` | `259200000` (3 days) | Absolute ceiling from offer creation, however alive the session is. |
| `BLOB_SWEEP_MS` | `60000` (1 min) | How often the sweep runs. It also removes any empty conversation directory. |
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

Device keys, local trust records and preferences are persisted; optional accounts also store password hashes and selected preferences. No message or file content is written to the account database. Direct content stays in browser memory; relayed ciphertext is buffered temporarily under the relay expiry policy.

## Device verification and access

Device names are fixed by the server from device codes; custom names and rename
requests are ignored/rejected. Message/file author labels use local device
records rather than sender-supplied display names.

Unknown devices first require their private pairing code: ask the owner for
the code shown at the top of their app, or scan their device QR. Public advertised
codes do not grant pairing. Private codes expire after three days; successful
pairing is remembered by fingerprint and survives code rotation. Codes expire
at the three-day boundary even if cleanup timers stall. A server restart also
replaces invitation codes; existing local pairings survive.

Open **Known devices**, choose **Verify**, and contact the owner outside the app.
Compare the pairwise code shown for each other's fingerprint and enter the code
the other owner reads to you. Successful comparison is remembered locally;
**Block** stops exchanges with that fingerprint in this browser. Unblocking
requires a fresh verification when verified-only mode is enabled. Forgetting
clears pairing on both sides and requires another code pairing; it does not
revoke access to the server itself.

Enable **Only exchange with verified devices** in Settings to require this
approval for all recipients and incoming authors. Sending to a room refuses the
whole send until every current recipient is verified, rather than silently
including a newly added member. This policy is local to each browser.

For server access controls, collect full fingerprints from **QR codes** (your own)
or **Known devices** (peers), configure `DEVICE_ALLOWLIST`, and restart. An allowed
ID alone is insufficient: the server checks a P-256 signature over its fresh
socket challenge. Removing an ID and restarting disconnects/revokes that device.
This complements `AUTH_TOKEN`; configuration/restart is the administrator flow.
It does not protect against a server serving compromised application code.

**QR codes** shows the server URL and a device invitation URL whose fragment
contains its private pairing code and expected fingerprint, plus your full
fingerprint for allowlist setup. Authentication tokens and existing URL query
parameters are excluded. Pairing invitations are bearer credentials; safety-code
comparison provides the additional out-of-band ownership check.

## Interrupted relay transfers and memory

Relayed uploads encrypt and PUT one ciphertext chunk at a time. An interrupted
upload stops and abandons its server item. **Restart upload** creates a new item
with a fresh encryption key and sends the whole file again from byte zero.

Interrupted downloads discard partial plaintext and wait for an explicit restart,
including after reconnect. **Restart download** fetches
the whole ciphertext again from byte zero using a recipient download token.
AES-GCM binds every chunk to its file ID, index and total; SHA-256 still must match
before Save is offered. Relay transfers do not resume. A server restart or expiry
removes the buffered item.

When the service worker controls the page, a relayed file is received in two
passes. The first verifies it and keeps only a digest per chunk. **Save** fetches
it again and streams it straight to disk, passing on only chunks identical to the
verified ones; any difference fails the download. The server copy is kept until
that save completes, so Save shows the expiry countdown and a file that expires
first shows **Gone**. Without the worker, the verified file is kept in memory
until Save, as before. See [design and measurements](docs/relay-memory.md).

## Peer protocol versioning

Browsers negotiate an application protocol version in the same handshake that exchanges their public keys. Protocol v3 requires portable chat signatures; v2 peers need to reload, and unsigned legacy history is discarded. A peer whose supported range does not overlap this build's is refused before any key is derived, with a message naming both ranges, and is not retried until you press **Retry**. Reconnection uses bounded exponential backoff — after eight failed attempts a peer is marked `Unreachable` rather than retried forever.

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
- **Rooms** — create one and share its `ABCD-EFGH` code; join with **Join by code**.
  Dropping a file on a joined room sends it to every member.
- **Theme** — the header toggle cycles system → light → dark and remembers the
  choice.
- **Known devices** — review the devices this browser remembers, and delete any
  of them, from **Known devices** in the header.
- **Incoming files** — **Settings** in the header chooses what happens when a
  device sends you a file: *ask for new devices* (the default), *always ask*, or
  *accept automatically*. When asked, nothing is received until you press
  **Accept**; the sender sees that it is waiting. **Decline** tells the sender,
  and a file waiting on the server is deleted there. Messages are never gated.
- **Keyboard** — everything is reachable by Tab; <kbd>Esc</kbd> closes the
  session panel and dialogs, and focus is returned to wherever it came from.
  The device and room tables re-render constantly, and focus survives that.

Hovering a device's **Status** shows the actual ICE candidate pair (`host↔host`,
`srflx↔host`, or `relay`) and the round-trip time, so a slow transfer can be
diagnosed as "this is going through TURN" rather than guessed at; a TURN-relayed
link is highlighted. **Rate** is live throughput, not a lifetime average.

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
no per-device authorisation or authenticated room membership, peer-synced file
metadata lacks portable author signatures, large files still live in RAM
on the receiving side, and browser coverage still needs real-device Safari/Android
and larger-room scenarios.

## License

MIT — see `LICENSE`.

## Threat model in one paragraph

The server is designed not to be able to read chat or files. Anything that reaches it through the relay arrives as ciphertext sealed to the recipient and signed by the sender; access expires with the conversation it belongs to — and in no case later than 3 days — with disk cleanup following on the sweep. WebRTC provides DTLS-encrypted DataChannels and the app additionally encrypts payload frames using an ephemeral ECDH-derived AES-GCM key. The displayed safety code can be compared out-of-band if you want to detect active interception. This MVP has **not** undergone a security audit; see `SECURITY.md` and `CODEX_HANDOFF.md` before exposing it beyond a trusted environment.

## Networking privacy and optional accounts

Each browser profile has one persistent key fingerprint. Concurrent tabs use the
same identity; the newest tab owns the connection and the replaced tab stops
reconnecting. Different browsers and devices have different identities, even
when signed into the same account. Self-messaging stores encrypted notes for this
browser identity; pair another browser or sign into the same account to message it. Offline code-paired peers receive
sealed relay items when they return, within the relay expiry window. A disconnected
signaling server means peer status is unknown, not proof that another device is offline.

Advertising controls public discovery. Devices whose full fingerprints are already
known can still be looked up directly, including after server restarts. Payload
exchange continues to require locally approved pairing.

**Hide** removes a device from the list and **Show** restores it in Known devices.
**Block** prevents exchanges. **Delete** on a conversation removes its local memory
and disconnects unused links; it keeps the pairing and cannot recall delivered or
server-buffered content. **Delete** in Known devices removes the stored relationship.
**Leave room** gives up membership without deleting the room for other members.
**Delete** on an unjoined room removes its remaining local conversation history.

**Scan QR** uses the camera inside the app, including the installed PWA, and
stops the camera when scanning completes, is cancelled, or the page is hidden.
HTTPS or localhost and camera permission are required. **My pairing QR** beside
Pair by code shows your current invitation. Scanned invitations must belong to
this server; arbitrary URLs are never opened. QR decoding is bundled locally.

External QR scans use ordinary in-scope HTTPS links. Opening the installed PWA
is controlled by browser/OS support and the user's link preferences; installation
alone cannot guarantee it. The app handles Launch Queue invitations when supported.
See [Chrome navigation management](https://developer.chrome.com/docs/capabilities/pwa-navigation-management).
Scanning inside the installed app is the dependable way to remain in it.

Docker enables accounts by default with a SQLite database at
`/home/node/evakage-accounts/accounts.sqlite`. Both Compose configurations mount
an `account-data` volume so accounts and preferences survive container replacement.
Signing up is optional for chat, files and joining rooms; creating rooms requires an account.

When running Node locally, set `ACCOUNTS_DB=./data/accounts.sqlite` to enable
accounts. Without that setting, local Node accounts are disabled. Set
`ACCOUNTS_DB` to an empty value to disable accounts in Docker or Compose.
The database stores only usernames, salted password hashes and selected preferences;
text, files, private device keys and login sessions are never stored in it. The
database schema is created automatically on first startup.

SQLite uses Node's built-in `node:sqlite` module (Node 22.13.0 or newer), with
prepared statements, a unique username constraint and atomic revision checks
for preference updates. See [Node SQLite documentation](https://nodejs.org/api/sqlite.html).
WAL mode and full synchronous commits protect account writes. Keep the database
and its `-wal`/`-shm` files together in the account volume. Use SQLite's backup API
for a live backup, or stop the server before copying the database file.
Passwords use salted scrypt hashes, sessions use HttpOnly/SameSite cookies,
and account changes require same-origin requests. Sessions end on server
restart; accounts and preferences survive. There is no password recovery flow.
Choose Login (or Account when signed in), then Delete account, and confirm with your current
password to remove the account and saved preferences and revoke all its sessions.
Connected devices clear their in-memory chats, received files and drafts.
Files saved outside the app and copies held by other people remain.

For Docker, the default configuration already includes the account volume:

```bash
docker compose up -d --build
```

For a published image, run `docker compose up -d` from `deploy/`.
The account volume is separate from ephemeral relay storage; never mount BLOB_DIR.
Behind an HTTPS reverse proxy set `TRUST_PROXY=1` for Secure account cookies.

Use **Account (optional)** to create an account or sign in. **Save preferences**
uploads theme, incoming-file policy, verified-only mode and relay preference.
On another browser, sign in and choose **Load preferences and reload** to apply
that configuration (reloading clears local in-memory conversations). Concurrent
updates require loading the newer version before saving. Advertising consent,
pairings, verification/block/hide records, private device keys, messages and files
remain local. The app stays fully usable without an account.

Online browsers signed into the same account discover each other privately,
connect automatically, and open a chat when there is one other visible device.
With several devices, choose one from the device list. Public advertising remains
off unless enabled separately. Blocking and verified-only restrictions still apply.
Account connections require both devices to be online; they do not queue messages
for offline delivery.

Signing out clears all chats, received files and drafts in that browser, revokes
its connections and room memberships, and reloads the app. Other devices keep
their local history. The signed-out browser needs a code/QR pairing or a new login
to reconnect. Account chats do not restore history from another device after
signing back in. Previously downloaded files outside the app are unaffected.
