# Evakage

Self-hosted, browser-first encrypted chat and file sharing for trusted networks.
Connect devices by private code or QR, send text and files directly, or invite a
small group into an ephemeral room. Install it as a PWA or use it in your browser.

## Try it

Build from this checkout:

```bash
cp app/.env.example app/.env
docker compose -f app/compose.yaml up -d --build
```

Open `http://localhost:3712`. To use other devices, put the app behind an HTTPS
reverse proxy with a trusted certificate. Set `TRUST_PROXY=1` only behind a proxy
you control, configuring it in `app/.env`. HTTPS or localhost is required for
browser crypto and PWA features.

For a published image, see [deploy/](deploy/README.md). `latest` tracks tested
`main` builds; stable images use `vX.Y.Z` tags.

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

Documentation lives in [docs/](docs/index.mdx):

- [Quick start](docs/quickstart.mdx)
- [Pairing devices](docs/guides/devices.mdx), [rooms](docs/guides/rooms.mdx), and [transfers](docs/guides/transfers.mdx)
- [Deployment](docs/hosting/deployment.mdx), [configuration](docs/hosting/configuration.mdx), and [privacy](docs/hosting/privacy.mdx)
- [Development](docs/development.mdx) and [releases](docs/releases.mdx)

Maintainer measurements and security review material are in [maintainer/](maintainer/README.md).

## Development

Use Node 24+ for development and release tooling; Docker uses Node 26.

```bash
npm ci
npm run check
npx playwright install chromium firefox webkit
npm run test:e2e
npm run test:e2e:platform
npm run dev
```

Open `http://localhost:3000`. Server code lives in `app/server/`; browser assets
live in `app/public/`. The app uses plain ES modules with no frontend build step.

The Dockerfile, source-build Compose setup, environment example and app check
configs also live in `app/`. Application tests are in `app/tests/` and `app/e2e/`;
release automation tests remain in `scripts/tests/`.

See [RELEASING.md](RELEASING.md) for release operations.

MIT licensed — see [LICENSE](LICENSE).
