# Deploying aria-drop

This folder runs a **published image**. It never builds from source; for that,
use `docker-compose.yml` at the repository root.

```bash
cd deploy
cp .env.example .env        # optional
docker compose pull
docker compose up -d
```

Then open `http://SERVER-IP:3712`. Put it behind a reverse proxy with TLS for
anything beyond `localhost` — phones need a secure context for WebCrypto,
service workers, and installing the app.

## The image

`ghcr.io/thesteau/aria-drop:latest` is a placeholder default: it is what the
GHCR workflow publishes from `main`. To pin a build, set `ARIA_DROP_IMAGE` in
`.env` to a `sha-…` or version tag.

## Relayed messages and files

Messages and files that cannot go directly between devices are held by the
server, sealed so it cannot read them. They are stored **inside the container**
(`/tmp/aria-drop-blobs`), one directory per conversation, and there is
intentionally no volume, so they are never exposed on the host and cannot
outlive the container.

A relayed item is removed at the first of:

1. every recipient has received it;
2. the sweep finds it at or past 24 hours — the sweep leaves anything younger alone, even if
   every device in the conversation has disconnected, so a device that comes
   back within the window still gets it;
3. the server restarts;
4. the container is recreated.

When a conversation's directory is left empty it is removed too, so a
conversation with nothing waiting leaves nothing behind.

Access expires at 24 hours regardless of the sweep: expired items cannot be
listed, claimed, uploaded, or newly downloaded. Downloads opened before the
deadline may finish afterward. Physical deletion waits for the next sweep,
which normally runs every 15 minutes but can be delayed; no cron is needed.
If you also want one driven from the host — say, nightly — the server has a
one-shot mode that removes items past the maximum age, then any directory left
empty, and exits:

```cron
# m h  dom mon dow  command
0 3 * * * docker exec aria-drop node server.js --sweep-blobs
```

Pass an age in milliseconds to override the 24h default for that run, e.g.
`node server.js --sweep-blobs 3600000` for anything over an hour.

## Checking on it

```bash
curl -fsS http://SERVER-IP:3712/healthz
# {"ok":true,"peers":2,"rooms":0,"bufferedTransfers":1,"bufferedMessages":3,"bufferedBytes":211904}
```
