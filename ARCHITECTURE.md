# Architecture

How WolffMsg is put together, and why. For the security properties and their
limits, see [SECURITY.md](SECURITY.md).

---

## The shape of the thing

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser                                                        │
│                                                                 │
│   React 19 UI                                                   │
│        │                                                        │
│   Zustand stores ── session · chats · calls · ui                │
│        │                                                        │
│   ┌────┴──────────────────────────────────────────┐             │
│   │  Crypto layer (@wolffmsg/shared + web/crypto) │             │
│   │   · device identity, prekeys                  │             │
│   │   · encrypt / decrypt / sign / verify         │             │
│   │   · attachment secretstream                   │             │
│   │   · non-extractable key vault (IndexedDB)     │             │
│   │   · decrypted message cache (IndexedDB)       │             │
│   └────┬──────────────────────────────────────────┘             │
│        │            ciphertext only, in both directions         │
└────────┼────────────────────────────────────────────────────────┘
         │  HTTPS  ·  WebSocket
┌────────┴────────────────────────────────────────────────────────┐
│  nginx        static client + reverse proxy for /api and /ws    │
└────────┬────────────────────────────────────────────────────────┘
         │
┌────────┴────────────────────────────────────────────────────────┐
│  Server (Fastify)                                               │
│                                                                 │
│   routes ─→ security (csrf · rate limit · ip hint)              │
│          ─→ auth    (sessions · argon2 · devices)               │
│          ─→ services (access · chats · messages · attachments)  │
│          ─→ realtime (socket · hub)                             │
│                                                                 │
│   Never possesses a key that opens anything it stores.          │
└──────┬────────────────────────────┬─────────────────────────────┘
       │                            │
┌──────┴────────┐          ┌────────┴────────┐    ┌───────────────┐
│  PostgreSQL   │          │      Redis      │    │  Blob storage │
│  22 tables    │          │  rate limits    │    │  ciphertext   │
│  ciphertext   │          │  presence       │    │  on disk      │
│  + metadata   │          │  fan-out pub/sub│    │               │
└───────────────┘          └─────────────────┘    └───────────────┘
```

---

## Repository layout

An npm workspaces monorepo with three packages:

```
packages/
  shared/    Cryptography and wire types. Imported by BOTH sides.
  server/    Fastify API, WebSocket hub, Prisma schema.
  web/       React client. Where all encryption happens.
```

`shared` exists so the two halves cannot drift. The envelope format, the AAD
construction, the validation rules and the event types are defined once and
compiled into both, which means a change to the wire format fails to build
rather than failing in production.

### `packages/shared`

| Module | Responsibility |
|---|---|
| `crypto/envelope.ts` | `encryptMessage`, `decryptMessage`, `buildAad`, per-device key sealing |
| `crypto/identity.ts` | Device secrets, prekey generation, rotation, bundle verification |
| `crypto/attachment.ts` | Streaming attachment encryption in 64 KiB frames |
| `crypto/safety.ts` | The 60-digit number two people compare |
| `crypto/vault.ts` | Passphrase-wrapped key export |
| `crypto/sodium.ts` | libsodium initialisation and encoding helpers |
| `validation.ts` | Username, password, display-name and emoji rules |
| `realtime.ts` | `ServerEvent` / `ClientCommand` union types |
| `types.ts` | Records shared by the API and the UI |

### `packages/server`

| Directory | Responsibility |
|---|---|
| `routes/` | 74 HTTP endpoints. Parse, authorise, delegate, respond. |
| `services/` | Everything that touches the database. `access.ts` owns every permission decision. |
| `auth/` | Sessions, Argon2id, device registration |
| `security/` | CSRF, rate limits, IP hinting |
| `realtime/` | WebSocket server (`socket.ts`) and fan-out hub (`hub.ts`) |
| `storage/` | Blob writes with streaming size caps and path containment |
| `prisma/` | Schema, migrations, development seed |

### `packages/web`

| Directory | Responsibility |
|---|---|
| `crypto/` | Key vault, session identity, attachment I/O, decrypted cache |
| `store/` | Zustand stores: session, chats, calls, UI |
| `lib/` | HTTP client, socket client, IndexedDB, formatting, server origin |
| `screens/` | Auth, connect-to-server, app shell, chat list, chat view |
| `components/` | Everything else, including the eight settings sections |

---

## The message path, end to end

This is the core of the system, so it is worth following one message all the
way through.

### 1. Composing

`ChatView` collects the text and any attachment. Attachments are encrypted
first, in the browser, with `crypto_secretstream_xchacha20poly1305` in 64 KiB
frames, and uploaded — the upload returns a descriptor that becomes part of the
message body. The upload reports real progress, can be cancelled, and can be
retried.

### 2. Choosing recipients

The client asks the server for a prekey bundle per device in the chat
(`POST /api/keys/claim`). The server hands out a one-time prekey where one is
available, claiming it atomically so no two senders can receive the same one,
and falls back to the device's signed prekey otherwise.

The client **verifies every bundle's signature** against the identity key it
already has pinned for that device. If a device's identity key has changed
since last time, the UI raises a safety-number warning rather than silently
encrypting to the new key.

### 3. Encrypting

One random content key per message. The body is sealed with
XChaCha20-Poly1305-IETF under AAD binding the message id, chat id, sender id,
sender device id and timestamp. The content key is then sealed separately to
each recipient device. The sender signs a BLAKE2b hash of AAD ‖ ciphertext.

### 4. Sending

`POST /api/chats/:chatId/messages` carries the ciphertext, nonce, signature and
one sealed key per device. The client chooses the message id — a 16–32
character opaque string — which is what makes the send **idempotent**: a retry
after a dropped connection reuses the same `clientId`, and the unique
constraint on `(senderId, clientId)` collapses it to the original row.

The server validates exact byte lengths (nonce 24, signature 64, sealed key 80),
clamps the timestamp to ±5 minutes of its own clock, and **drops sealed keys
addressed to devices that are not in the chat** — so a malicious sender cannot
use the fan-out as a covert channel to a third party.

### 5. Fanning out

Rows are written in one transaction: the `messages` row, one `message_keys` row
per recipient device, `attachments` rows, and the chat's `lastMessageAt`. Then
the hub publishes `message:new` — over Redis pub/sub when configured, so a
multi-node deployment reaches sockets on other nodes.

**Each connected device receives only its own sealed key.** The event is
projected per device before it is written to the socket.

### 6. Receiving

The client verifies the sender's signature *before* attempting to unseal —
order matters: an unauthenticated ciphertext is never fed to the decryption
routine. It rebuilds the AAD from the message's own routing fields, unseals the
content key with the matching private prekey, and decrypts.

On success the one-time prekey's private half is deleted locally, which is
what makes that message forward-secret. The plaintext is written to a local
IndexedDB cache so search and re-render do not require re-decryption.

### 7. Receipts

Delivery is acknowledged over the socket as soon as the device stores the
message; read is acknowledged when the message is actually on screen, and only
if the reader has read receipts enabled. Both are per-message-id, which is what
lets a single ✓ / ✓✓ be accurate rather than approximate.

---

## State on the client

Four Zustand stores, deliberately separate:

- **`session`** — who is signed in, on which device, the server's config, the
  connection state, and the chosen API origin.
- **`chats`** — the chat list, loaded messages, the decryption pipeline, the
  outbox, and the folding of realtime events into all of the above.
- **`calls`** — WebRTC peer connections and call state.
- **`ui`** — overlays, toasts, the mobile pane split.

Selectors return frozen shared constants (`NO_MESSAGES`, `NO_IDS`) rather than
fresh empty arrays, because a selector that returns a new array on every call
makes `useSyncExternalStore` loop forever.

### The outbox

A message typed while offline is not lost. It goes into an outbox with its
client id, the UI shows it as pending, and the queue drains on reconnect. The
idempotent send path means a message that actually reached the server before
the connection dropped is not duplicated by the retry.

### Overlay presence

Overlays do **not** use `AnimatePresence`. It removes an exiting child only
when that child reports its animation finished, and that report is lost
whenever a nested subtree re-renders during the exit window — which any overlay
containing async data loading does. The result is an element that animates to
`opacity: 0` and then stays in the DOM forever, invisibly covering the page and
swallowing every click.

`hooks/usePresence.ts` replaces it with a timer: `open` goes false, the caller
gets `leaving: true` for a fixed window so it can animate out, and then the
element is removed whether or not anything reported anything. Unmounting is
unconditional.

---

## Realtime

One WebSocket per tab, authenticated by the same session cookie as the HTTP
API, with the Origin checked on upgrade — browsers do not apply the same-origin
policy to WebSockets, so that check is the only thing between a hostile page
and a cookie-authenticated socket.

**Server events**: `ready`, `pong`, `error`, `message:new`, `message:updated`,
`message:deleted`, `message:reaction`, `message:delivered`, `message:read`,
`typing:start`, `typing:stop`, `presence:update`, `chat:update`,
`chat:removed`, `chat:pinned`, `contact:update`, `identity:changed`,
`prekeys:low`, `session:revoked`, `call:incoming`, `call:accepted`,
`call:declined`, `call:ended`, `call:signal`.

**Client commands**: `ping`, `typing:start`, `typing:stop`,
`presence:subscribe`, `presence:unsubscribe`, `message:delivered`,
`message:read`, `call:start`, `call:accept`, `call:decline`, `call:hangup`,
`call:signal`.

Reconnection uses exponential backoff with jitter (500 ms → 30 s), plus
immediate retries on `online` and on tab focus — waking from a background tab
is the most common moment for a socket to be silently dead. Commands issued
while offline are queued and replayed.

The hub abstracts fan-out: with Redis it publishes to a channel every node
subscribes to; without it, it delivers in-process only. **A multi-node
deployment without Redis will not deliver across nodes.**

---

## Data model

22 tables. The ones that carry the design:

- **`users`** — credentials and profile. `passwordVersion` invalidates sessions
  on password change.
- **`user_settings`** — privacy, notification and appearance preferences, all
  enforced server-side.
- **`devices`** — one cryptographic identity per device. Only public keys.
- **`prekeys`** — `@@id([deviceId, keyId])`. One-time keys are claimed at most
  once; that claim is what provides forward secrecy.
- **`sessions`** — opaque server-side sessions storing only an HMAC of the
  secret.
- **`chats`** / **`chat_members`** — `directKey` is a unique column holding the
  two user ids sorted and joined, which is what prevents duplicate DMs under a
  race. Roles live here and nowhere else.
- **`messages`** — `ciphertext`, `nonce`, `signature` as bytes. **There is
  deliberately no body, text or content column.** A monotonic `seq` per chat
  drives ordering and O(1) unread counts.
- **`message_keys`** — the content key sealed to one device. One row per
  recipient device per message.
- **`message_deliveries`** / **`message_reads`** — per-message receipts.
- **`attachments`** — size, storage key, and the encrypted header. Never the
  key.
- **`security_events`** / **`login_attempts`** — the audit trail behind the
  Security Center, holding IP *hints* rather than addresses.

Every foreign key is declared with an explicit `onDelete`. Multi-row writes —
sending a message, creating a group, deleting a message and its attachments —
run inside `prisma.$transaction`.

---

## Search

Message search runs **entirely on the client**, over the local decrypted
IndexedDB cache. The server cannot search messages because it cannot read them,
and an architecture where it could would mean it held plaintext.

User and chat search are server-side, because usernames and group titles are
not encrypted.

---

## Calls

WebRTC, peer-to-peer. The server issues ICE server configuration
(`GET /api/calls/ice-servers`) and relays signalling over the socket without
inspecting it. Media never passes through the server unless a TURN relay is
configured, and even then TURN sees only DTLS-SRTP-encrypted frames.

---

## Two deployment shapes

**Same origin (recommended).** nginx serves the built client and proxies
`/api` and `/ws` to the server. The browser sees one origin, so the session
cookie stays `SameSite=strict` — a CSRF defence no application code can get
wrong. This is what `docker-compose.yml` builds.

**Split origin.** The client is published to a static host (GitHub Pages, a
CDN) and talks to a server elsewhere. `packages/web/src/lib/serverOrigin.ts` is
the only module that knows which shape is in play; every API URL and the socket
URL are derived from it. This requires `COOKIE_SAMESITE=none` on the server and
is genuinely weaker — see SECURITY.md §7. Nothing about the encryption changes:
the server never held plaintext in either shape.

When a static host serves the client with no API behind it, the app shows a
connect screen asking which server to use, rather than a sign-in form whose
every button would fail. There is no shared or demo server, by design.

---

## Build and tooling

- **TypeScript** in strict mode with `noUncheckedIndexedAccess`, across all
  three packages. Tests are included in each package's `tsconfig.json` so they
  are type-checked and linted; a separate `tsconfig.build.json` keeps them out
  of `dist`.
- **Vite 6** for the client. `libsodium` is split into its own chunk so the
  sign-in screen paints before the crypto core finishes downloading; React,
  Framer Motion and the settings surface are split too.
- **Prisma 6** for the schema, migrations and the typed client.
- **Vitest** for all three suites.
- **ESLint 9** flat config, type-aware, with rules chosen for correctness and
  security rather than formatting.

A postinstall script (`scripts/patch-libsodium-esm.mjs`) repairs a broken
relative import in `libsodium-wrappers-sumo`'s published ESM bundle. Icons are
generated by `scripts/generate-icons.mjs`, a dependency-free PNG rasteriser
sharing the logo's polygon geometry — no image toolchain, and no third-party
font or asset CDN is contacted at any point.
