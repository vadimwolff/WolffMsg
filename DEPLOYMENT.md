# Deployment

Running WolffMsg for real. For what each setting does, see
[ENVIRONMENT.md](ENVIRONMENT.md); for the security properties you are signing
up for, [SECURITY.md](SECURITY.md).

---

## Before you start

**There is no hosted WolffMsg, and that is the point.** A server run by someone
else cannot read your messages, but it does hold your account, your contact
graph and your delivery metadata. Self-hosting is what makes the privacy claim
mean something.

You will need:

- A host with **2 GB RAM** or more. Argon2id is configured to use 64 MiB per
  password verification, deliberately.
- **PostgreSQL 14+**. Not SQLite — the schema relies on `FOR UPDATE SKIP
  LOCKED`, `jsonb` and `BigInt` sequences.
- **Redis**, unless you will only ever run a single instance.
- **A domain and a TLS certificate.** Browsers do not expose the Web Crypto API
  on an insecure origin, so the client will refuse to run over plain HTTP
  anywhere but `localhost`. This is not a policy WolffMsg chose.

---

## Option 1 — Docker Compose (recommended)

```bash
git clone <your-fork> wolffmsg && cd wolffmsg
cp .env.example .env
```

Edit `.env`. At minimum:

```dotenv
NODE_ENV=production
WEB_ORIGIN=https://chat.example.com
PUBLIC_URL=https://chat.example.com
COOKIE_SECURE=true

POSTGRES_PASSWORD=<openssl rand -base64 32>
SESSION_SECRET=<openssl rand -base64 48>
```

Then:

```bash
docker compose up -d --build
docker compose logs -f server
```

The server applies database migrations on start; if a migration fails the
container stops rather than serving against a schema it does not understand.

**Only nginx is published** (port 8080 by default). PostgreSQL and Redis are
reachable only on the compose network, so the database is never one
misconfigured firewall rule away from the internet.

### Put TLS in front

The `web` container speaks plain HTTP on 8080 on purpose: certificate issuance
and renewal belong to your deployment, not to an image. Terminate TLS in
whatever you already run. With Caddy, the whole configuration is:

```caddyfile
chat.example.com {
    reverse_proxy localhost:8080
}
```

With nginx in front, forward WebSocket upgrades:

```nginx
server {
    listen 443 ssl http2;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # The server checks Origin on every unsafe request; it must arrive
        # unaltered or that check has nothing to work with.
        proxy_set_header Origin $http_origin;
        proxy_read_timeout 3600s;
    }
}
```

Once TLS is live, confirm `COOKIE_SECURE=true` and that `WEB_ORIGIN` is the
**exact** `https://` origin, then `docker compose up -d`.

### Verifying it works

```bash
curl -fsS https://chat.example.com/api/health   # process is up
curl -fsS https://chat.example.com/api/ready    # database and Redis reachable
```

Then open the site, create two accounts in two browsers, and send a message
between them. Finally, confirm the claim this whole project rests on:

```bash
docker compose exec postgres \
  psql -U wolff -d wolffmsg -c "SELECT ciphertext FROM messages LIMIT 1;"
```

You should see bytes, not words. There is no column that would hold words.

---

## Option 2 — Without Docker

```bash
npm ci
npm run build

createdb wolffmsg
export DATABASE_URL=postgresql://wolff:...@localhost:5432/wolffmsg
npm run db:deploy          # applies migrations; never resets

npm start                  # serves the API on PORT
```

`npm run build` produces `packages/web/dist`. Serve those files with any static
web server and proxy `/api` and `/ws` to the Node process, using
`docker/nginx.conf` as a starting point — it has the WebSocket and streaming
settings already worked out.

Run the server under a process supervisor (systemd, pm2) so it restarts on
failure, and as a **non-root user** with write access only to `STORAGE_PATH`.

A minimal systemd unit:

```ini
[Unit]
Description=WolffMsg
After=network.target postgresql.service redis.service

[Service]
Type=simple
User=wolffmsg
WorkingDirectory=/srv/wolffmsg
EnvironmentFile=/srv/wolffmsg/.env
ExecStart=/usr/bin/node packages/server/dist/index.js
Restart=on-failure
RestartSec=5

# The server needs the network, its storage directory, and nothing else.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/wolffmsg/storage

[Install]
WantedBy=multi-user.target
```

---

## Option 3 — Static client, self-hosted server

The client can be published to a static host (GitHub Pages, a CDN, an S3
bucket) and pointed at a WolffMsg server elsewhere. This is a **real**
deployment, not a demo: the client is the security-critical half, and it does
all the encrypting either way.

It is also **weaker**, and the weakness is worth understanding before you
choose it. A cross-site cookie cannot be `SameSite=strict`, so the browser
stops refusing cross-site requests on your behalf and CSRF defence falls back
to the Origin allow-list and the double-submit token alone. Prefer Option 1
unless you have a specific reason not to.

**On the server:**

```dotenv
COOKIE_SAMESITE=none
COOKIE_SECURE=true
WEB_ORIGIN=https://you.github.io      # exact origin of the published client
```

The server refuses to boot with `COOKIE_SAMESITE=none` and
`COOKIE_SECURE=false`, because browsers discard such a cookie silently.

**Building the client:**

```bash
BASE_PATH=/wolffmsg/ VITE_API_ORIGIN=https://chat.example.com \
  npm run build -w @wolffmsg/web
```

Leaving `VITE_API_ORIGIN` unset is also fine — the published app then asks each
visitor for their server address and remembers it.

### GitHub Pages

`.github/workflows/pages.yml` does all of this on a push to `main`:

1. In the repository, **Settings → Pages → Source → GitHub Actions**.
2. Optionally set a repository variable `API_ORIGIN` (Settings → Secrets and
   variables → Actions → Variables) to pre-fill the server address.
3. Push to `main`, or run the workflow manually.

The workflow resolves the base path from the repository name, adds
`.nojekyll` (Pages otherwise drops files beginning with an underscore) and
copies `index.html` to `404.html` so deep links load the app.

---

## Operating it

### Backups

Two things must be backed up **together**, because each is useless without the
other:

1. The PostgreSQL database.
2. `STORAGE_PATH` — the encrypted attachment blobs.

```bash
docker compose exec -T postgres pg_dump -U wolff wolffmsg | gzip > db.sql.gz
docker run --rm -v wolffmsg_blob-storage:/data -v "$PWD":/backup alpine \
  tar czf /backup/blobs.tar.gz -C /data .
```

A backup contains no message plaintext and no private key. **That also means a
backup cannot recover a user's lost keys** — if someone clears their browser
storage on their only device, their message history is gone. This is what
end-to-end encryption costs, and it should be said to users plainly rather than
discovered by them.

### Upgrades

```bash
git pull
docker compose up -d --build
```

Migrations run automatically at start. Take a database backup first; Prisma
migrations are not automatically reversible.

### Monitoring

- `GET /api/health` — the process is up. Use for liveness.
- `GET /api/ready` — PostgreSQL and Redis are reachable. Use for readiness.

Logs are structured JSON (pino) with passwords, tokens, cookies, keys and
message content redacted at the logger. Ship them wherever you ship logs.

Worth alerting on: repeated `rate_limited` responses on `/api/auth/login`
(credential stuffing), a rising 5xx rate, and disk usage on `STORAGE_PATH` —
orphaned attachments are swept hourly, but 100 MiB uploads add up.

### Closing registration

For a private instance:

```dotenv
ALLOW_REGISTRATION=false
```

Existing accounts keep working; new sign-ups are refused. Set it before you
announce the URL, not after.

---

## A pre-flight checklist

- [ ] `SESSION_SECRET` is 32+ bytes from `openssl rand`, not the example value.
- [ ] `POSTGRES_PASSWORD` is not the example value.
- [ ] `NODE_ENV=production`.
- [ ] `COOKIE_SECURE=true`, and TLS actually terminates in front.
- [ ] `WEB_ORIGIN` is the exact origin, including scheme and port.
- [ ] `COOKIE_SAMESITE=strict` unless Option 3 genuinely applies.
- [ ] `REDIS_URL` is set if more than one instance will run.
- [ ] PostgreSQL is not reachable from the internet.
- [ ] The server process does not run as root.
- [ ] Backups cover both the database and `STORAGE_PATH`, and a restore has
      been tested.
- [ ] `ALLOW_REGISTRATION` reflects what you actually want.
- [ ] TURN is configured, or you have accepted that callers reveal their IP
      addresses to each other.
- [ ] You have read SECURITY.md §14 and are comfortable with every item on it.

---

## Scaling, briefly

The server is stateless apart from blob storage, so it scales horizontally:

- **Redis is mandatory** beyond one instance. Without it, rate limits are
  per-node and realtime events never cross nodes.
- **Blob storage must be shared** between instances — a network filesystem, or
  a new storage driver. Only `local` exists today.
- **Sticky sessions are not required.** The WebSocket authenticates from the
  session cookie on every connection, and fan-out goes through Redis.
- PostgreSQL is the first thing that will need attention. The hot paths are
  indexed on `(chatId, seq)` and `(userId, pinned, archived)`.
