# Environment variables

Every setting WolffMsg reads, what it does, and what happens if you get it
wrong. Copy `.env.example` to `.env` and fill it in; real deployments should
inject these through the process environment instead, and values already set
there always win over the file.

**Never commit `.env`.** It is in `.gitignore` and in `.dockerignore`, and
anything copied into a Docker build context is recoverable from the image
layers even if a later step deletes it.

Configuration is validated at boot with zod. An invalid value **stops the
process with a message naming the field** rather than starting a
half-configured server.

---

## Server

### Runtime

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production`. Production suppresses stack traces in responses and enables the extra boot checks below. |
| `PORT` | `4000` | |
| `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` if a reverse proxy on the same host is the only client. |

### Origins and cookies

| Variable | Default | Notes |
|---|---|---|
| `WEB_ORIGIN` | `http://localhost:5173` | **Exact** origins allowed to make browser requests, comma-separated. Scheme, host and port must all match — `https://chat.example.com` does not cover `https://chat.example.com:8443`. Used for CORS, for the CSRF Origin check, and for the WebSocket upgrade check. |
| `PUBLIC_URL` | `http://localhost:5173` | Where the client is reachable. Used to build links in push notifications. |
| `COOKIE_SECURE` | `false` | Set `true` behind TLS. Adds `Secure` and switches the session cookie to the `__Host-` prefix. In production, leaving it false logs a warning. |
| `COOKIE_SAMESITE` | `strict` | `strict` \| `lax` \| `none`. See below. |

**`COOKIE_SAMESITE` is the one setting worth reading carefully.** Leave it at
`strict` unless you are certain you need otherwise: the browser then refuses to
attach the session cookie to any cross-site request at all, which is a CSRF
defence that no application bug can undo.

Set it to `none` for exactly one deployment shape — the web client served from
a *different* origin than this API, such as GitHub Pages — where `strict` would
mean the cookie is never sent and nobody could sign in. That is a genuine
weakening: CSRF then rests entirely on the `WEB_ORIGIN` allow-list and the
double-submit token. The server **refuses to boot** with `COOKIE_SAMESITE=none`
and `COOKIE_SECURE=false`, because browsers silently discard such a cookie and
the failure would otherwise look like "login is broken" rather than
"misconfigured".

### Database

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes** | PostgreSQL connection string. SQLite is not supported — the schema relies on `FOR UPDATE SKIP LOCKED`, `jsonb` and `BigInt` sequences. |
| `TEST_DATABASE_URL` | for tests | A **separate** database. The integration suite truncates every table between tests; pointing this at a database you care about destroys it. |

### Redis

| Variable | Default | Notes |
|---|---|---|
| `REDIS_URL` | *(empty)* | Rate-limit counters, presence, and cross-node realtime fan-out. |

Leaving it empty falls back to an in-process implementation. That is fine for
development and for a genuinely single-instance deployment. With more than one
instance it is **not**: rate limits are then enforced per node, and realtime
events do not reach sockets connected to a different node. Run Redis in
production.

### Secrets

| Variable | Required | Notes |
|---|---|---|
| `SESSION_SECRET` | **yes**, ≥32 chars | Derives the session-token pepper and the CSRF signing key. Generate with `openssl rand -base64 48`. **Rotating it signs everyone out.** |

In production the server refuses to start if this still contains
`CHANGE_ME`, `example` or `placeholder`, so the value from `.env.example`
cannot ship by accident.

### Attachment storage

| Variable | Default | Notes |
|---|---|---|
| `STORAGE_DRIVER` | `local` | Only `local` today. |
| `STORAGE_PATH` | `./storage` | Where encrypted blobs are written. Back this up alongside the database — the two are useless without each other. |
| `MAX_ATTACHMENT_BYTES` | `104857600` (100 MiB) | Enforced as bytes arrive, so an oversize upload is refused mid-flight rather than buffered. |
| `MAX_AVATAR_BYTES` | `4194304` (4 MiB) | |

The bytes on disk are ciphertext the server cannot read. It holds no key that
opens them, which also means **a lost client key is not recoverable from a
server backup**.

### WebRTC

| Variable | Default | Notes |
|---|---|---|
| `STUN_SERVERS` | `stun:stun.l.google.com:19302` | Comma-separated. Point at your own if you would rather not tell Google when your users place a call. |
| `TURN_SERVER` | *(empty)* | Relay for peers behind symmetric NAT. |
| `TURN_USERNAME` | *(empty)* | |
| `TURN_PASSWORD` | *(empty)* | |

Without TURN, media is peer-to-peer and **each participant learns the other's
IP address**. With TURN, media is relayed and those addresses stay hidden from
the peer — the relay sees encrypted frames, not their contents. Calls still
work without TURN; some network combinations simply fail to connect.

### Web Push

| Variable | Default | Notes |
|---|---|---|
| `VAPID_PUBLIC_KEY` | *(empty)* | Generate both with `npx web-push generate-vapid-keys`. |
| `VAPID_PRIVATE_KEY` | *(empty)* | |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | A contact address push services can reach you at. |

Push is disabled unless both keys are set. Payloads carry **no message
content** — the server has none to send.

### Operations

| Variable | Default | Notes |
|---|---|---|
| `LOG_LEVEL` | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` \| `silent`. |
| `ALLOW_REGISTRATION` | `true` | Set `false` to close public sign-ups on a private deployment. Existing accounts are unaffected. |

---

## Web client (build time)

These are read by Vite when the client is **built** and baked into the output.
Nothing secret belongs here; the client holds no secrets of its own, because
keys are generated in the browser and never leave it. Template:
`packages/web/.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `VITE_API_ORIGIN` | *(empty)* | Where the API lives. Empty means same-origin — the recommended shape. Set it only for a split-origin deployment, and then the server needs `COOKIE_SAMESITE=none`, `COOKIE_SECURE=true` and this client's origin in `WEB_ORIGIN`. |
| `BASE_PATH` | `/` | Sub-path the built client is served from. `/wolffmsg/` for a GitHub Pages project site; the Pages workflow sets it automatically. |
| `VITE_API_TARGET` | `http://127.0.0.1:4000` | **Dev only.** Where `npm run dev` proxies `/api` and `/ws`. |

Leaving `VITE_API_ORIGIN` empty on a static host is a valid choice: the app
then asks each visitor which server to connect to, and remembers the answer.

---

## Docker Compose

`docker-compose.yml` reads the same `.env`, plus a few that only shape the
stack itself:

| Variable | Default | Notes |
|---|---|---|
| `POSTGRES_USER` | `wolff` | |
| `POSTGRES_PASSWORD` | **required** | Compose refuses to start without it. |
| `POSTGRES_DB` | `wolffmsg` | |
| `WEB_PORT` | `8080` | Host port nginx is published on. Nothing else is published. |

`DATABASE_URL` and `REDIS_URL` are constructed by compose from these and point
at the internal service names, so you do not set them yourself there.

---

## Minimum viable production configuration

```dotenv
NODE_ENV=production
WEB_ORIGIN=https://chat.example.com
PUBLIC_URL=https://chat.example.com
COOKIE_SECURE=true
COOKIE_SAMESITE=strict

POSTGRES_PASSWORD=<openssl rand -base64 32>
SESSION_SECRET=<openssl rand -base64 48>

REDIS_URL=redis://redis:6379
STORAGE_PATH=/app/storage
LOG_LEVEL=info
```

Everything else has a working default.

---

## What is deliberately not configurable

- **Argon2id parameters.** 64 MiB / 3 passes / 4 lanes, compiled in. A
  deployment that could weaken password hashing through a typo is a deployment
  that will.
- **The cryptographic primitives.** There is no cipher suite to select. See
  SECURITY.md §2.
- **Whether authorisation is checked.** There is no flag for it.
