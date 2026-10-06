# Evakage

Self-hosted, browser-first encrypted chat and file sharing for trusted networks.
Connect devices by private code or QR, send text and files directly, or invite a
small group into an ephemeral room. Install it as a PWA or use it in your browser.

[Documentation](https://evakage.docs.thesteau.com) ·
[Buy me a coffee](https://buymeacoffee.com/thesteau)

![Evakage device list and private rooms](docs/images/devices-and-rooms.png)

## Quick start

To host your own instance with a published image:

```bash
git clone https://github.com/thesteau/evakage.git
cd evakage/deploy
cp .env.example .env
docker compose pull
docker compose up -d
```

Open `http://localhost:3712`. See [the deployment guide](deploy/README.md) for
configuration, updates and account backups. `latest` tracks tested `main`
builds; pin an available `vX.Y.Z` tag when you need a stable version.

To build from this checkout instead:

```bash
cp app/.env.example app/.env
docker compose -f app/compose.yaml up -d --build
```

Open `http://localhost:3712`. To use other devices, put the app behind an HTTPS
reverse proxy with a trusted certificate. Set `TRUST_PROXY=1` only behind a proxy
you control, configuring it in `app/.env`. HTTPS or localhost is required for
browser crypto and PWA features.

## Using Evakage

If someone already hosts an instance for you, open its URL in both browsers.
Show the private pairing code or **QR code** on one device. On the other, choose
**Connect**, then scan the QR or enter the private code and choose **Join**.
Open the paired device to send
text or files. Create an account to create rooms or connect your signed-in devices;
chatting, transferring files and joining a room by invitation work without one.

Save files you want to keep before closing the browser. See the
[device guide](docs/guides/devices.mdx) and [transfer guide](docs/guides/transfers.mdx)
for more details.

## What to expect

- Devices stay private until you opt into advertising. Private code/QR invitations authorize pairing.
- Direct transfers use encrypted WebRTC channels; encrypted server relay covers unreachable peers.
- Chat, files and joining rooms work without accounts. Creating rooms requires an account.
- Optional accounts connect online devices privately and save selected preferences.
- Device verification, incoming-file approval and SHA-256 checks help control exchanges.

Messages and direct file copies live in browser memory. Relay ciphertext is
temporary and disappears on expiry or server restart. Only the separate account
database persists in Docker; never mount relay storage. Browser identity keys,
trust records and preferences persist locally. Evakage has not undergone an
independent security audit; see [SECURITY.md](SECURITY.md).

## Documentation

Read the [hosted documentation](https://evakage.docs.thesteau.com).
The [documentation source](https://github.com/thesteau/evakage/tree/main/docs)
is also available in this repository:

- [Quick start](docs/quickstart.mdx)
- [Pairing devices](docs/guides/devices.mdx), [rooms](docs/guides/rooms.mdx), and [transfers](docs/guides/transfers.mdx)
- [Accounts and preferences](docs/guides/accounts.mdx) and [mobile use](docs/guides/mobile.mdx)
- [Deployment](docs/hosting/deployment.mdx), [configuration](docs/hosting/configuration.mdx), and [privacy](docs/hosting/privacy.mdx)
- [Development](docs/development.mdx) and [releases](docs/releases.mdx)

Maintainer measurements and security review material are in [maintainer/](maintainer/README.md).

## Development

These instructions are for contributors working on the source. To run an instance
for everyday use, follow the deployment instructions above.

Use Node 24+ for development and release tooling; Docker uses Node 26.

```bash
npm ci
npm run check
npx playwright install chromium firefox webkit
npm run test:e2e
npm run test:e2e:platform
npm run dev
```

Open `http://localhost:3000`. TypeScript server code lives in `app/server/`.
Browser sources live in `app/client/`; tests live in `tests/`.

`npm run build` type checks and compiles sources into `dist/`, assembling browser
assets in `dist/app/public/`. Start and test commands build automatically.
`npm run dev` watches the client and server sources, rebuilds, and restarts the
server after successful compilation. Build before running the standalone scripts
in `scripts/benchmarks/`.

See [the development guide](docs/development.mdx) for more details and
[RELEASING.md](RELEASING.md) for the maintainer's release workflow. You do not
need to reproduce that workflow to use or self-host Evakage.

## Author

Created and maintained by [thesteau](https://github.com/thesteau).

## Support

If Evakage is useful to you, you can [buy me a coffee](https://buymeacoffee.com/thesteau)
to support its development.

## Usage and responsibility

Evakage is provided "as is", without warranty. You are responsible for how you
use it and the content you send or share. If you host an instance, you are also
responsible for its configuration, access controls, updates and security.
Use it only where you have permission and comply with applicable laws.
Other people's deployments, modifications and uses are their own responsibility;
they are not operated or endorsed by the author merely because they use this code.
The author and contributors are not responsible for misuse, data loss, security
incidents, or other damage arising from its use, to the extent permitted by law.

Evakage is MIT licensed. See [LICENSE](LICENSE) for the full terms, including
the warranty disclaimer and limitation of liability.
