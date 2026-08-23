<div align="center">

# WOLFF**MSG** 🐺

**A private, end-to-end encrypted messenger you run yourself.**

[Architecture](ARCHITECTURE.md) · [Security](SECURITY.md) ·
[Deployment](DEPLOYMENT.md) · [Environment](ENVIRONMENT.md) ·
[Testing](TESTING.md)

</div>

---

Messages are encrypted in the browser that sends them and decrypted only on the
devices that receive them. The server stores ciphertext and routing metadata,
and holds no key that opens any of it — there is no `body`, `text` or `content`
column in the messages table, and a test sweeps every text column in the
database on every run to prove it stays that way.

**There is no hosted instance, deliberately.** A server run by someone else
still holds your account, your contact graph and your delivery metadata.
Self-hosting is what makes the privacy claim mean anything.

---

## What it does

**Messaging** — direct and group chats, replies, edits, deletes, reactions,
forwarding, pinned messages, unread counts, delivery and read status,
debounced typing indicators, presence and last-seen.

**Media** — photos, video, documents and voice messages, all encrypted on the
device before upload, with chunked transfer, real progress, cancel and retry.
Fullscreen image viewing with zoom and swipe, and downloads that never break
the encryption.

**Calls** — one-to-one voice and video over WebRTC, peer-to-peer, with STUN and
optional TURN.

**Security you can inspect** — per-device identity keys, safety numbers you can
compare out of band, a ✓ Verified / ⚠ Unverified state per contact, a warning
when a peer's key changes unexpectedly, a list of active sessions you can
revoke individually or all at once, and a Security Center showing sign-ins and
failed attempts.

**The rest** — search (message search runs on-device, because the server cannot
read them), contacts, blocking enforced server-side, eight settings sections,
a ⌘K command palette, dark and light themes, full keyboard navigation, and an
installable PWA with an offline shell and a send queue that drains on
reconnect.

---

## Try it in five minutes

Requires Node 20.11+, PostgreSQL 14+, and optionally Redis.

```bash
git clone <this-repo> wolffmsg && cd wolffmsg
npm install

cp .env.example .env
# Set DATABASE_URL, and:  SESSION_SECRET=$(openssl rand -base64 48)

npm run db:migrate      # create the schema
npm run seed            # optional: five accounts and a group to poke at
npm run dev             # server on :4000, client on :5173
```

Open <http://localhost:5173> in two different browsers (or one normal and one
private window — each browser profile is a separate *device* with its own
keys), register two accounts, and send a message.

Then confirm the whole premise:

```sql
SELECT ciphertext FROM messages LIMIT 1;
```

Bytes. Not words. There is no column that would hold words.

### With Docker instead

```bash
cp .env.example .env    # set POSTGRES_PASSWORD and SESSION_SECRET
docker compose up -d --build
```

Everything on <http://localhost:8080>. Only nginx is published; PostgreSQL and
Redis stay on the internal network. See [DEPLOYMENT.md](DEPLOYMENT.md) before
exposing it to anything.

---

## How the encryption works, briefly

Every primitive comes from [libsodium](https://doc.libsodium.org/). **WolffMsg
implements no cryptography of its own** — no cipher, no MAC, no KDF, no key
exchange, no RNG.

Each message gets a fresh random content key. The body is sealed with
XChaCha20-Poly1305-IETF under associated data binding the message id, chat id,
sender id, sender device id and timestamp — so a captured ciphertext cannot be
replayed into another chat or re-attributed to another sender. The content key
is then sealed separately to each recipient *device* using an X25519 sealed box
against a one-time prekey, and the sender signs the result with Ed25519.
Recipients verify the signature before they attempt to decrypt.

One-time prekeys are issued at most once — claimed atomically, proven by a test
that races ten simultaneous claims — and deleted after use, which is where
forward secrecy comes from.

Private keys live in IndexedDB, wrapped by an AES-GCM key generated with
`extractable: false`. Even a script injected into the page cannot read that key
out to use elsewhere. `localStorage` holds nothing secret, and one module is
permitted to touch it at all.

**This is not the Signal Protocol, and does not claim to be.** There is no
Double Ratchet, which means no post-compromise recovery and no deniability.
That trade was made deliberately: implementing the Signal Protocol from scratch
is how E2EE systems get subtly and invisibly broken. Every construction here is
a documented libsodium API used for its stated purpose.

**No system is "100% secure."** [SECURITY.md](SECURITY.md) sets out exactly
what is encrypted, what the server can still see (all of your metadata), and
every known limitation — nine of them, collected in one list at the end.

---

## The stack

| | |
|---|---|
| **Client** | React 19 · TypeScript · Vite 6 · Zustand · Framer Motion |
| **Server** | Node 20+ · Fastify 5 · TypeScript · `ws` · zod · pino |
| **Data** | PostgreSQL 14+ via Prisma 6 · Redis |
| **Crypto** | libsodium (`libsodium-wrappers-sumo`) · Argon2id (`@node-rs/argon2`) |
| **Tests** | Vitest · Playwright for the end-to-end drives |

An npm workspaces monorepo:

```
packages/shared    cryptography and wire types, imported by both sides
packages/server    API, WebSocket hub, schema
packages/web       the client, where all encryption happens
```

`shared` exists so the two halves cannot drift: change the envelope format and
the build fails, rather than production.

---

## Commands

```bash
npm run dev          # server and client together
npm run build        # all three packages
npm test             # 209 tests across all three
npm run typecheck    # strict TypeScript
npm run lint         # ESLint, type-aware

npm run db:migrate   # create/apply a migration (development)
npm run db:deploy    # apply existing migrations (production)
npm run db:studio    # browse the data
npm run seed         # development fixtures
```

The server suite needs a real PostgreSQL database — see
[TESTING.md](TESTING.md), which also lists honestly what is *not* covered.

---

## Design notes

The interface is dark by default with a light theme that switches instantly.
Glassmorphic surfaces, an aurora accent (indigo → cyan) with four variants, and
a system font stack — no third-party font or asset CDN is contacted at any
point, which is a privacy decision as much as a performance one.

It is fully responsive down to 390 px and built to feel like an app rather than
a page on mobile: swipe-back navigation, safe-area insets, and no layout shift
when the keyboard opens. Keyboard navigation, visible focus, ARIA labelling and
`prefers-reduced-motion` are honoured throughout.

Overlays deliberately do not use `AnimatePresence` — it drops its completion
callback whenever a nested subtree re-renders during the exit window, leaving
an invisible element covering the page and swallowing clicks.
`hooks/usePresence.ts` makes unmounting unconditional instead. There is a note
in that file explaining why, because the next person to reach for
`AnimatePresence` deserves to know.

---

## Contributing

Two rules that matter more than style:

1. **Do not invent cryptography.** No new protocol, primitive, KDF, MAC or
   RNG. If a feature needs something that is not already a documented libsodium
   API used for its stated purpose, the answer is to change the architecture,
   not to write the primitive.
2. **Assert the negative.** "Alice can read her own chat" is worth one line.
   "Bob cannot" is the test that catches the regression.

`npm run lint && npm run typecheck && npm test` must pass. CI runs all three
against a real database.

---

## Licence

AGPL-3.0-only. If you run a modified version as a service, the people using it
are entitled to its source — which, for a messenger whose security depends on
the code it serves you, is the point.
