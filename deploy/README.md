# Deploying Evakage

The Compose file in this directory runs a **published Docker image**. To build
your own image from source, follow the [local container instructions](../docs/development.mdx#build-a-local-container).

From the repository root:

```bash
cd deploy
cp .env.example .env        # required
docker compose pull
docker compose up -d
```

Open `http://localhost:3712` on the host. To connect other devices, put Evakage
behind an HTTPS reverse proxy with a certificate those devices trust. Browser
encryption, service workers, and app installation require HTTPS or localhost.

## The image

The Compose file runs `ghcr.io/thesteau/evakage:latest`, published after the
checks for a `main` commit pass. To pin a stable release, replace `latest` with
an available `vX.Y.Z` tag in `docker-compose.yml`.

## Accounts and preferences

SQLite accounts are enabled by default. The Docker-managed `account-data` volume
stores the database at `/home/node/evakage-accounts/accounts.sqlite`, preserving
accounts and preferences across container replacement. This path is preserved
for compatibility with existing account volumes. An account is required
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

Messages and files that cannot go directly between devices are encrypted by
the sender and held by the server for delivery. They are stored **inside the container**
(`/tmp/evakage-blobs`), one directory per conversation, and there is
no persistent relay volume. Recreating the container removes this storage;
restarting the server also clears it.

A server copy becomes unavailable as soon as any of these conditions applies:

1. Every recipient has finished receiving or saving it.
2. All participants have been offline for 15 minutes. A device that returns
   within this grace period can still receive it.
3. A direct chat has had only one device online for 3 hours. Rooms are exempt.
4. The item reaches its maximum age of 3 days.
5. The server restarts or the container is recreated.
6. Relay capacity is needed and the item is evicted after its upload completes.

These are the default limits. Set the relay variables in `.env` to change them.
Active uploads and downloads are protected from capacity cleanup.

Self-chat is an exception: reading an item keeps its server copy available.
It expires after 24 hours offline or at its maximum age (at most three days from
creation), whichever comes first. For streamed relay files, the recipient
releases its copy after Save completes.

Empty conversation directories are removed too.

Access expires on those rules regardless of the sweep: expired items cannot be
listed, claimed, uploaded, or newly downloaded. Downloads opened before the
deadline may finish afterward. Physical deletion waits for the next sweep,
which normally runs every minute but can be delayed. Cleanup runs automatically.
For optional maintenance from the host, the server also has a command that
removes files past the maximum age, removes empty directories, and exits:

```cron
# m h  dom mon dow  command
0 3 * * * docker exec evakage evakage --sweep-blobs
```

This command checks each file's modification time. It runs in a separate process
and cannot see which conversations are active. It uses `BLOB_MAX_AGE_MS`
(3 days by default), unless you pass an age in milliseconds. For example,
`evakage --sweep-blobs 600000` removes files older than ten minutes.

## Updates and account backups

From `deploy/`, pull the image and recreate the container:

```bash
docker compose pull
docker compose up -d
```

Updates clear relay content and end login sessions. Accounts and saved settings
survive in the `account-data` volume.

For an account backup, stop the app and copy the SQLite database together with
any `-wal` and `-shm` files, then start it again. For a live backup, use SQLite's
backup API. See the [deployment guide](../docs/hosting/deployment.mdx#updates-and-backups).

**Do not run `docker compose down -v` if you want to keep accounts.**

## Check server health

```bash
curl -fsS http://SERVER-IP:3712/healthz
# {"ok":true,"peers":2,"bufferedTransfers":1,"bufferedMessages":3,"bufferedBytes":211904}
```
