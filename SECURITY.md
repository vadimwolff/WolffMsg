# Security

This document is written to be checked, not to be reassuring. It sets out what
WolffMsg encrypts, what it does not, what the server can still see, which
primitives are used, and where the design is weaker than the alternatives it
was measured against.

**WolffMsg is not "100% secure", and no system is.** What follows is a
description of a specific set of trade-offs.

---

## 1. What is end-to-end encrypted

| Data | Encrypted end-to-end? | Notes |
|---|---|---|
| Message text | **Yes** | Per-message random key, sealed to each recipient device |
| Message attachments (photo, video, file, voice) | **Yes** | Encrypted in the browser before upload |
| Attachment file names, MIME types, dimensions | **Yes** | Carried inside the encrypted message body |
| Reply quotes and forward context | **Yes** | Part of the encrypted body |
| Reaction emoji | **No** | Stored in plaintext — see §6 |
| Group names and descriptions | **No** | Stored in plaintext — see §6 |
| Display names, usernames, bios, avatars | **No** | Profile data the server must serve |
| Who talks to whom, and when | **No** | This is metadata; see §6 |

The `messages` table has **no** `body`, `text` or `content` column. It stores
`ciphertext`, `nonce` and `signature` as bytes, plus routing columns. A test in
`packages/server/src/tests/e2ee.test.ts` sweeps every `text`, `varchar` and
`jsonb` column in the entire database after sending a message containing a
known canary string, and fails if that string appears anywhere.

---

## 2. Which cryptography is used

**Every primitive comes from [libsodium](https://doc.libsodium.org/)**, via
`libsodium-wrappers-sumo`. Password hashing on the server uses
[`@node-rs/argon2`](https://github.com/napi-rs/node-rs), a binding to the
reference Rust implementation. **WolffMsg implements no cryptographic
primitive of its own** — no cipher, no MAC, no KDF, no key exchange, no
random number generator.

| Purpose | Construction |
|---|---|
| Message body | `crypto_aead_xchacha20poly1305_ietf` — XChaCha20-Poly1305, 256-bit key, 192-bit random nonce |
| Sealing the content key to a device | `crypto_box_seal` — X25519 + XSalsa20-Poly1305 sealed box |
| Message authenticity | `crypto_sign_detached` — Ed25519, over BLAKE2b(AAD ‖ ciphertext) |
| Prekey signatures | `crypto_sign_detached` — Ed25519 by the device identity key |
| Attachments | `crypto_secretstream_xchacha20poly1305` — 64 KiB frames |
| Safety numbers | `crypto_generichash` — BLAKE2b, 5 200 iterations |
| Passwords (server) | Argon2id, 64 MiB memory, 3 passes, 4 lanes |
| Passphrase-wrapped key export | `crypto_pwhash` — Argon2id, `MODERATE` limits |
| Session token digests | HMAC-SHA256 under an HKDF-derived pepper |
| All randomness | `crypto_secretbox`-grade CSPRNG (`randombytes_buf`) / Web Crypto `getRandomValues` |

---

## 3. The message protocol

WolffMsg uses what this repository calls the **Sealed Prekey Protocol, v1**. It
is described here in full because a protocol you cannot read is a protocol you
cannot check.

### Sending

1. The sender generates a fresh random 256-bit **content key**.
2. It builds the **associated data (AAD)**: the protocol version, message id,
   chat id, sender user id, sender device id and creation timestamp, joined
   with `U+001F` and encoded as UTF-8.
3. The plaintext body is encrypted with XChaCha20-Poly1305-IETF under the
   content key, with that AAD and a fresh random 192-bit nonce.
4. The sender fetches a **prekey bundle** for every device in the chat —
   including its own other devices — and verifies each bundle's Ed25519
   signature against the identity key it has for that device. An unverifiable
   bundle is a hard failure, not a warning.
5. For each device, the content key is sealed with `crypto_box_seal` to that
   device's **one-time prekey** if the server issued one, or to its **signed
   prekey** if none remained.
6. The sender signs `BLAKE2b(AAD ‖ ciphertext)` with its Ed25519 identity key.
7. The ciphertext, nonce, signature and the per-device sealed keys go to the
   server.

### Receiving

1. The recipient device is handed only *its own* sealed key. The server drops
   keys addressed to devices that are not in the chat.
2. It rebuilds the AAD from the message's own routing fields — not from
   anything the sender asserted separately.
3. It **verifies the sender's Ed25519 signature first**, against the pinned
   identity key for that sending device. Only then does it unseal.
4. It unseals the content key with the matching private prekey and decrypts.
5. On success, a **one-time prekey is deleted locally**.

### What binding the AAD achieves

Because the AAD covers the chat id, sender id and sender device id, a captured
ciphertext cannot be replayed into a different chat, attributed to a different
sender, or re-dated: decryption fails outright. Tests cover each of these
cases.

### Forward secrecy, precisely

One-time prekeys are issued **at most once**. The server claims one atomically:

```sql
UPDATE prekeys SET claimed_at = now()
WHERE (device_id, key_id) = (
  SELECT device_id, key_id FROM prekeys
  WHERE device_id = $1 AND kind = 'onetime' AND claimed_at IS NULL
  FOR UPDATE SKIP LOCKED LIMIT 1
)
```

A concurrency test races ten simultaneous claims and asserts that ten distinct
keys come back. After a message is successfully decrypted, the client deletes
the private half. Compromising the device afterwards does not recover that
message.

**The limits of that guarantee**, stated plainly:

- If a device's one-time prekeys run out before it comes online to publish
  more, senders fall back to the **signed prekey**. Messages sealed to a signed
  prekey are **not** forward-secret until that prekey is rotated. The client
  replenishes automatically and the server emits a `prekeys:low` event, but the
  window exists.
- Messages that have been received and decrypted are stored in a local
  IndexedDB cache so search works. Compromising an *unlocked* device recovers
  that history. Signing out destroys it.

---

## 4. What this is not

**WolffMsg does not implement the Signal Protocol, and does not claim to.**
There is no Double Ratchet, no X3DH, no chain-key derivation.

The consequences are concrete:

- **No post-compromise recovery ("future secrecy").** If a device's identity
  and signed prekey are stolen, an attacker can decrypt future messages sealed
  to that signed prekey until the keys are rotated and the peers notice the
  change. The Double Ratchet heals from this automatically; this protocol does
  not.
- **Weaker forward secrecy.** The Double Ratchet advances a key per message.
  Here it advances per *one-time prekey*, with the signed-prekey fallback above.
- **No deniability.** Messages carry an Ed25519 signature by the sending
  device, which is cryptographic evidence of authorship. Signal deliberately
  uses a deniable authenticator instead.

This design was chosen over writing a Double Ratchet because **implementing the
Signal Protocol from scratch is how E2EE systems get subtly and invisibly
broken**. Every construction used here is a documented libsodium API used for
its stated purpose. If you need the Signal Protocol's properties, use a library
that has been audited for them — do not use this.

---

## 5. Key storage

**Private keys never leave the browser and are never sent to the server.** The
server has no API that would accept one.

On the client, device secrets are held in IndexedDB, encrypted under an
AES-GCM key generated with `extractable: false`:

```ts
const key = await crypto.subtle.generateKey(
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
);
```

The `CryptoKey` handle itself is stored in IndexedDB. A non-extractable key
cannot be read back out by *any* script, including one injected by an XSS: such
an attacker can ask the browser to decrypt while the page is open, but cannot
exfiltrate the key material to use later or elsewhere. The client verifies at
runtime that the key really is non-extractable and refuses to proceed if not.

**`localStorage` is never used for anything secret.** One module
(`packages/web/src/lib/prefs.ts`) is permitted to touch it at all, holding only
the theme and the configured server address; an ESLint rule enforces this
across the rest of the codebase.

### What this does not protect against

- **A compromised browser or operating system.** Nothing in a web application
  can defend against a keylogger, a malicious extension with host permissions,
  or a browser exploit.
- **A hostile or compromised server serving malicious JavaScript.** This is the
  fundamental limit of every web-delivered E2EE application: the code that does
  the encrypting arrives from the server on each visit. Self-hosting is the
  mitigation, which is why WolffMsg is built to be self-hosted and why there is
  no shared instance. A native app with signed, verifiable builds does not have
  this property; a web app does.
- **An unlocked, physically-present device.** The vault key is not tied to a
  passphrase or a biometric; whoever holds the unlocked browser profile has the
  session.

---

## 6. What the server can see

Encryption protects content. It does not hide that you communicated.

The server necessarily knows and stores:

- **Who talks to whom, and when.** Chat membership, message timestamps,
  sequence numbers.
- **Message sizes**, and which devices each message was addressed to.
- **Delivery and read receipts** — who received and read which message ids and
  when (subject to the recipient's read-receipt setting).
- **Group names, descriptions, membership and roles.**
- **Reaction emoji**, stored unencrypted. They are validated against a strict
  single-emoji pattern, so the field cannot be repurposed as a plaintext side
  channel.
- **Pinned message ids.**
- **Profile data**: username, display name, bio, avatar image.
- **Presence**: online state and last-seen timestamps.
- **Device list**: names, platforms and public keys.
- **Attachment sizes and storage keys** (the bytes themselves are ciphertext).
- **Security events**: sign-ins, failed attempts, password changes, session
  revocations.

Reactions and group names are not encrypted because doing so honestly would
require a group key-agreement scheme, and that is exactly the kind of protocol
this project refuses to invent. They are listed here rather than glossed over.

### What is deliberately *not* stored

- Message plaintext, in any column, ever.
- Any private key.
- Any password, in any reversible form.
- **Raw IP addresses.** Addresses are reduced to a `/24` (IPv4) or `/48` (IPv6)
  prefix plus a short keyed HMAC digest, which is enough to rate-limit and to
  show "a new sign-in from a different network" without retaining a location
  history. See `packages/server/src/security/ipHint.ts`.

---

## 7. Authentication and sessions

**Passwords** are hashed with Argon2id (64 MiB, 3 passes, 4 lanes). The hash is
re-evaluated on each successful sign-in and transparently upgraded if the
parameters have since been raised.

**Account enumeration** is prevented by running a full Argon2id verification
against a decoy hash when the username does not exist, so a wrong username and
a wrong password take the same time and return the same message. The
username-availability endpoint used during sign-up is separately rate-limited.

**Sessions are opaque and server-side.** The cookie is `<sessionId>.<secret>`;
the database stores only `HMAC-SHA256(secret)` under an HKDF-derived pepper, so
a database dump does not yield usable session tokens. Sessions slide forward on
use and rotate their secret periodically. Changing a password bumps
`passwordVersion`, which invalidates every existing session at once.

**Cookies** are `HttpOnly`, `SameSite=strict` and, with `COOKIE_SECURE=true`,
`Secure` with the `__Host-` prefix.

**CSRF** is defended in two independent layers:

1. An **Origin check** on every unsafe method, against the exact configured
   allow-list.
2. A **double-submit token** on every request that carries a session cookie.
   The value lives in a JS-readable cookie on the API origin and must be echoed
   in the `x-wolff-csrf` header.

Sign-up and sign-in are deliberately exempt from layer 2 — they are the
requests that *issue* the token — and carry their authority in the body rather
than in an ambient cookie.

### The split-origin exception

If the client is served from a different origin than the API (a static host
such as GitHub Pages), `SameSite=strict` would mean the cookie is never sent
and nobody could sign in. Setting `COOKIE_SAMESITE=none` allows that
deployment, and it is **a real weakening**: the browser is no longer refusing
cross-site requests on your behalf, and CSRF then rests entirely on the Origin
allow-list and the double-submit token. In that mode the server additionally
*requires* an Origin header on session-bearing writes, since a missing one can
no longer be read as "same-site". It also refuses to boot without
`COOKIE_SECURE=true`.

The same-origin deployment is the recommended one, and is what
`docker-compose.yml` sets up.

---

## 8. Authorisation

**No permission, role, user id or chat id from the client is ever trusted.**
Every authorisation decision goes through
`packages/server/src/services/access.ts`, which reads the current state from
the database.

- Membership is checked before any chat data is returned.
- A non-member receives **404, not 403**, so the API does not confirm that a
  chat id exists.
- Group roles (`owner` / `admin` / `member`) are read from `chat_members`, never
  from the request.
- Blocking is enforced server-side in both directions, on sending, on presence,
  and on profile visibility.
- Attachments are authorised per request against current chat membership;
  removing someone from a group cuts off their access to its attachments
  immediately.
- Message edit and delete are permitted only to the author, with group admins
  able to delete but not edit.

The suite in `packages/server/src/tests/authorization.test.ts` covers each of
these as an explicit negative test.

---

## 9. Input handling and injection

- **SQL injection**: all queries go through Prisma's parameterised client. The
  one raw statement in the codebase is the prekey claim in §3, which is
  parameterised, and the test-only `TRUNCATE`.
- **XSS**: React escapes by default; `dangerouslySetInnerHTML` is banned by an
  ESLint rule. Links in message text are parsed and rendered as elements rather
  than injected as markup, and `javascript:` URLs are rejected. Behind that
  sits the Content Security Policy below.
- **Path traversal**: uploaded file names are never used to build a path. Every
  blob gets a server-generated random storage key, and the resolved path is
  checked to be inside the storage root before any write or read.
- **MIME spoofing**: the declared type is never trusted, and the two upload
  paths handle it differently because they can.
  - **Avatars** arrive as plaintext, so their bytes *are* checked: the leading
    magic number must actually be JPEG, PNG or WebP, and must match the
    declared type. SVG is refused outright — it is an XSS vector when served
    inline. A `.png` containing `<svg onload=…>` is rejected with 400, and
    there is a test that submits exactly that.
  - **Message attachments** are ciphertext by the time the server sees them,
    so their type genuinely cannot be verified. They are instead served with
    `Content-Disposition: attachment` and never rendered.

  Both paths are size-capped as bytes arrive — a 10 GB upload is refused
  mid-flight, not buffered — and every blob is served as
  `application/octet-stream` with `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`,
  `Cross-Origin-Resource-Policy: same-origin` and
  `Referrer-Policy: no-referrer`.
- **SSRF**: the server makes no outbound HTTP request driven by user input. The
  only outbound calls are Web Push, to endpoints supplied by the browser's own
  push service.
- **Command injection**: the server never spawns a subprocess.
- **Prototype pollution**: request bodies are validated with zod schemas that
  strip unknown keys.

---

## 10. Content Security Policy

The client ships a strict CSP, emitted as a `<meta http-equiv>` **inside the
built HTML** rather than only as a response header. That is deliberate: a
static host — GitHub Pages, a CDN, an S3 bucket — cannot set headers, and the
policy has to travel with the file or those deployments have none at all.

```
default-src 'none';
script-src 'self' 'wasm-unsafe-eval' 'sha256-…';
style-src 'self' 'unsafe-inline';
img-src 'self' blob: data:;
media-src 'self' blob:;
font-src 'self';
connect-src 'self';
worker-src 'self'; manifest-src 'self';
object-src 'none'; base-uri 'none'; form-action 'none';
upgrade-insecure-requests
```

Three parts of that are worth explaining rather than glossing over:

- **`'wasm-unsafe-eval'` is required, not a concession.** libsodium compiles a
  WebAssembly module; without it the entire crypto core fails to load and the
  app cannot encrypt anything. It is the narrow directive that permits *only*
  WebAssembly compilation — it does not enable `eval()` or any other
  string-to-JavaScript path, which is exactly why it exists separately from
  `'unsafe-eval'`. There is no `'unsafe-eval'` and no `'unsafe-inline'` for
  script anywhere in the policy.
- **`'unsafe-inline'` in `style-src` permits style attributes, not script.**
  React writes component styles as inline `style` attributes and Framer Motion
  mutates them every frame. It is unavoidable and much narrower than it sounds.
- **The inline script hash is computed from the final built HTML**, so it
  cannot drift from what actually ships. Editing the theme-painting script
  updates the hash automatically.

`connect-src 'self'` is the whole point for the recommended deployment: an
injected script has nowhere to send a decrypted message. A build pinned to a
separate API origin names that origin and its WebSocket exactly. **A build that
lets each visitor choose their own server cannot know the answer at build
time**, and falls back to `https: wss:` plus loopback — that still rules out
`http:`, `data:` and every non-secure exfiltration path, but it does not
restrict *which* secure host, and it should not be described as if it did. It
is opt-in (`ALLOW_RUNTIME_SERVER`) and is what the GitHub Pages workflow uses.

`frame-ancestors` cannot be expressed in a meta tag; `X-Frame-Options: DENY` is
set as a header instead. The API sets its own, stricter policy on its own
responses, and blob responses set a third (`default-src 'none'; sandbox`).

---

## 11. Rate limits

Anonymous endpoints are keyed by an address hint; authenticated ones by user
id, so one person behind a shared NAT cannot lock out a whole building.

| Operation | Limit | Window |
|---|---|---|
| Register | 10 | 1 hour |
| Sign in (per address) | 10 | 15 min |
| Sign in (per account) | 8 | 15 min |
| Change password | 5 | 1 hour |
| Send message | 120 | 1 min |
| Upload attachment | 40 | 5 min |
| Search | 60 | 1 min |
| Add contact | 40 | 1 hour |
| Create chat | 30 | 1 hour |
| Start call | 20 | 10 min |
| Claim prekeys | 300 | 5 min |
| WebSocket events | 600 | 1 min |
| Reactions | 120 | 1 min |
| Push subscribe | 20 | 1 hour |

Counters live in Redis when configured, and in process memory otherwise —
which means a multi-node deployment without Redis enforces limits per node.
Run Redis.

---

## 12. Logging

Structured logs (pino) are redacted at the logger, not at each call site.
Passwords, tokens, private keys, cookie values, authorization headers and
message plaintext never reach a log line. In production, error responses carry
a message and a code; stack traces are logged, never returned.

---

## 13. Push notifications

Push payloads contain **no message content**, because the server has none to
send. A push carries at most a chat id and a generic title. The service worker
raises no notification at all if a window is already focused.

Push is optional and off unless VAPID keys are configured.

---

## 14. Calls

Voice and video use WebRTC with DTLS-SRTP, which is end-to-end encrypted
between peers by construction. The server relays signalling without inspecting
it and never sees media.

**Caveat**: without a TURN server, media flows peer-to-peer and each side
learns the other's IP address. Configure TURN if that matters to your users.
With TURN, media is relayed and the addresses are hidden from the peer — but
the TURN server sees the encrypted media stream (not its contents).

---

## 15. Known limitations, collected

1. No post-compromise recovery; no Double Ratchet. (§4)
2. Forward secrecy lapses when one-time prekeys are exhausted. (§3)
3. Reaction emoji and group names are stored in plaintext. (§6)
4. All communication metadata is visible to the server. (§6)
5. A compromised server can serve malicious JavaScript. (§5)
6. The local decrypted message cache is readable on an unlocked device. (§5)
7. WebRTC without TURN reveals peer IP addresses. (§14)
8. `COOKIE_SAMESITE=none` weakens CSRF defence to application-level only. (§7)
9. No formal third-party security audit has been performed on this codebase.

---

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue.
Please include the version, a reproduction, and what an attacker gains.
