# Deploying Evakage

This folder runs a **published image**. It never builds from source; for that,
use `app/compose.yaml` from the repository root.

```bash
cd deploy
cp .env.example .env        # required
docker compose pull
docker compose up -d
```

Then open `http://SERVER-IP:3712`. Put it behind a reverse proxy with TLS for
anything beyond `localhost` — phones need a secure context for WebCrypto,
service workers, and installing the app.

## The image

The compose file runs `ghcr.io/thesteau/evakage:latest`, which is what the
GHCR workflow publishes from `main`.

## Accounts and preferences

SQLite accounts are enabled by default. The Docker-managed `account-data` volume
stores the database at `/home/node/evakage-accounts/accounts.sqlite`, preserving
accounts and preferences across container replacement. An account is required
to create rooms; chat, files and joining by code work without one. Text, files
and device private keys never enter this database.

If you previously used the `./account-data` bind mount, stop the app and copy
that directory's contents into the named volume before starting it again to
keep existing accounts. Switching mounts does not migrate the database.

Set `ACCOUNTS_DB=` in `.env` to disable accounts. Behind an HTTPS reverse proxy,
set `TRUST_PROXY=1` so account session cookies are Secure.
Preserve the public `Host` header or send it as `X-Forwarded-Host`, including
a non-default port if used. Account requests require an HTTPS Origin matching
that host; `ALLOWED_ORIGINS` only controls WebSocket access.

## Relayed messages and files

Messages and files that cannot go directly between devices are held by the
server, sealed so it cannot read them. They are stored **inside the container**
(`/tmp/evakage-blobs`), one directory per conversation, and there is
intentionally no relay volume, so they are never exposed on the host and cannot
outlive the container.

A relayed item is removed at the first of:

1. every recipient has received it;
2. every device party to it has been gone for the grace period (15 minutes by
   default), so a device that comes back sooner still gets it;
3. a one-to-one conversation has sat with only one device present for 3 hours;
   rooms are exempt from this one;
4. it reaches the absolute cap of 3 days;
5. the server restarts;
6. the container is recreated.

Self-chat is an exception: reading an item keeps its server copy available.
It expires after 24 hours offline or at its age limit (at most three days from
creation), whichever comes first. For streamed relay files, the recipient
releases its copy after Save completes.

When a conversation's directory is left empty it is removed too, so a
conversation with nothing waiting leaves nothing behind.

Access expires on those rules regardless of the sweep: expired items cannot be
listed, claimed, uploaded, or newly downloaded. Downloads opened before the
deadline may finish afterward. Physical deletion waits for the next sweep,
which normally runs every minute but can be delayed; no cron is needed.
If you also want one driven from the host — say, nightly — the server has a
one-shot mode that removes items past the maximum age, then any directory left
empty, and exits:

```cron
# m h  dom mon dow  command
0 3 * * * docker exec evakage evakage --sweep-blobs
```

The one-shot mode judges age by file mtime, since it runs in a separate process
with no knowledge of which sessions are alive; it uses the 3-day cap unless you
pass an age in milliseconds, e.g. `evakage --sweep-blobs 600000` for
anything over ten minutes.

## Checking on it

```bash
curl -fsS http://SERVER-IP:3712/healthz
# {"ok":true,"peers":2,"rooms":0,"bufferedTransfers":1,"bufferedMessages":3,"bufferedBytes":211904}
```
