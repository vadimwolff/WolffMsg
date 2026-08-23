# Testing

What is tested, how to run it, and — as honestly as the rest of these
documents — what is not covered.

```bash
npm test          # all three packages
npm run typecheck # strict TypeScript across all three
npm run lint      # ESLint, type-aware
```

**209 tests** at the time of writing: 35 cryptographic, 143 server
integration, 31 client unit.

---

## Setup

The shared and web suites need nothing. The server suite needs a **real
PostgreSQL database** — it is an integration suite, not a mocked one, because
the properties worth testing (atomic prekey claims, cascade deletes, unique
constraints under a race) exist in the database and not in the code.

```bash
createdb wolffmsg_test
```

```dotenv
TEST_DATABASE_URL=postgresql://wolff:...@localhost:5432/wolffmsg_test?schema=public
```

**Point this at a database you do not care about.** The suite truncates every
table between tests. It also refuses to touch the real counter store: the
helper that clears rate limits throws unless `NODE_ENV=test`.

Redis is not required; the suite uses the in-process counter store.

---

## `@wolffmsg/shared` — the cryptography (35 tests)

`packages/shared/src/crypto/crypto.test.ts`. These are the tests that matter
most, because everything else in the system assumes they pass.

They exercise the real primitives — nothing is stubbed — and cover:

**Correctness**
- Round-trip encryption and decryption across devices.
- Multi-device fan-out: every one of a user's devices can open the message.
- Attachment streams round-trip, including at frame boundaries.
- Safety numbers are symmetric: both sides compute the same 60 digits.

**Confidentiality**
- A plaintext canary never appears in the ciphertext, the nonce, the signature
  or any sealed key.
- Nonces and content keys are unique across many encryptions.

**Integrity and binding** — each of these must *fail*:
- A flipped ciphertext bit.
- A flipped bit in the sealed key.
- The same envelope replayed into a **different chat id**.
- The same envelope re-attributed to a **different sender**.
- A tampered timestamp.
- A signature from the wrong device.
- An attachment stream truncated before its FINAL frame.

**Forward secrecy**
- A one-time prekey that has been consumed cannot open the message again.
- A prekey bundle with an invalid signature is refused before anything is
  sealed to it.

---

## `@wolffmsg/server` — integration (143 tests)

Five files, run against a real database and a real Fastify instance via
`app.inject`. Every test actor holds **real device keys and performs real
encryption**, so the suite walks the same code path a browser does. A break in
the protocol shows up as a failing test rather than a passing mock.

### `e2ee.test.ts` — the central claim

The one to read first. It sends a message containing a known canary string,
then queries `information_schema` for **every `text`, `varchar` and `jsonb`
column in the entire database** and asserts the canary appears in none of them.

Adding a plaintext column anywhere in a future change breaks this test. That is
the point.

It also covers: sealed keys reaching only the devices they were addressed to;
a device outside the chat receiving no key; and the server rejecting malformed
envelopes (wrong nonce length, wrong signature length).

### `auth.test.ts` (30 tests)

Registration, sign-in, sign-out, session lifecycle.

- Argon2id hashes are PHC-formatted, verify correctly, and are re-hashed when
  parameters change.
- Wrong username and wrong password are **indistinguishable** in response and
  in timing — the account-enumeration defence.
- Account lockout after repeated failures.
- A forged session cookie is rejected.
- Changing a password invalidates every other session.
- "Log out all other devices" leaves the current one working.
- CSRF: no token, mismatched token, unrecognised origin — all 403. Safe methods
  need no token. With `COOKIE_SAMESITE=none`, a session-bearing write with no
  Origin header is refused.

### `authorization.test.ts`

Every rule from the specification, as an explicit negative test:

- **User A cannot read User B's chat** — and gets 404, not 403, so the API does
  not confirm the chat exists.
- **User A cannot delete User B's message.**
- **A member cannot perform admin actions** — cannot promote, cannot remove
  members, cannot change group settings.
- **An admin cannot remove the owner**, and cannot transfer ownership.
- **A blocked user cannot send** — enforced server-side, in both directions.
- **An unauthorised user cannot fetch an attachment**, and access is cut off
  the moment they are removed from the group.
- Privacy settings (`whoCanMessage`, `lastSeenVisibility`) are enforced by the
  server, not the client.

### `realtime.test.ts` (24 tests)

Real WebSocket connections against a real server.

- A message is delivered to participants and **not** to an outsider.
- Typing indicators relay to the other party, never back to the sender, are
  refused for a chat the socket is not in, and are suppressed for a user who
  turned them off.
- Presence reaches people who share a chat, and reaches neither strangers nor
  blocked users.
- Calls ring the other party and relay signalling; signalling is refused to
  someone outside the call's chat.
- Group membership changes notify every member.
- Session revocation closes the socket.

### `media.test.ts` (20 tests)

- Uploaded attachments are **ciphertext on disk** — the test reads the stored
  file and asserts the plaintext is absent.
- Round-trip through upload and download.
- Blobs are served with headers that stop the browser executing them.
- Storage keys are random, never derived from user input, and cannot escape the
  storage root — including a path-traversal avatar key.
- An avatar whose bytes do not match its declared type is refused: the suite
  uploads `<svg onload="alert(1)">` named `evil.png` and expects 400. SVG is
  rejected outright.
- Attachment access follows current chat membership, revoked immediately on
  removal; an upload cannot be attached to someone else's message.
- Orphaned uploads are swept; attached ones are left alone.

### Concurrency

Prekey issuance is raced ten ways simultaneously; the test asserts ten
**distinct** keys come back. This is the atomic `FOR UPDATE SKIP LOCKED` claim
that gives the protocol its forward secrecy, and it cannot be verified any
other way than by racing it.

Message idempotency is likewise tested with a concurrent double-submit of the
same client id, asserting exactly one row.

---

## `@wolffmsg/web` — client unit (31 tests)

`serverOrigin.test.ts` (18) covers the server-address validator, which is the
input every API URL and the WebSocket are built from: `javascript:` and `data:`
URLs refused, plain HTTP refused except on loopback, paths and query strings
refused, a stored value re-validated on load rather than trusted because it
once passed the form.

`csp.test.ts` (13) covers the Content Security Policy the build emits — logic
that runs once, where a mistake is invisible until it reaches a browser, either
as a policy that permits what it should not or as one that breaks the app.
Both failure modes have already happened here: an early version omitted
`'wasm-unsafe-eval'` and blocked libsodium entirely. The tests pin both
directions, including that `connect-src` never widens unless explicitly asked
to.

---

## End-to-end

Two Playwright drives live outside the repository's test suites, because they
need a running server, a running database and two real browser contexts. They
are how each release is checked by hand.

**Same-origin drive.** Registers two accounts in two browser contexts, opens a
conversation, sends messages in both directions, and asserts each side
*decrypts and displays* what the other sent. Then: typing indicators,
reactions, the command palette, the Security Center, the safety number, light
theme, closing settings, and the mobile layout at 390×844.

**Split-origin drive.** The built client served from one origin against a
server on another, with `COOKIE_SAMESITE=none`. Asserts the session cookie
arrives as `SameSite=None; Secure` with the `__Host-` prefix, that messages are
delivered and decrypted over the cross-origin WebSocket, and that the CSRF
token round-trips so writes succeed.

Both drives also fail on any Content Security Policy violation. That is how
the missing `'wasm-unsafe-eval'` was caught before it shipped: the policy
blocked libsodium's WebAssembly module, and the app could not encrypt anything
at all.

Both currently pass, against the production build served behind a
single-origin proxy standing in for `docker/nginx.conf`.

---

## Writing a new test

`packages/server/src/tests/helpers.ts` provides the harness:

```ts
const alice = await createActor();
const bob = await createActor();
const chatId = await openDirect(alice, bob);

// Real encryption with alice's real device keys.
await sendMessage(alice, chatId, [bob], 'the quick brown fox');
```

Two rules:

1. **Never mock the cryptography.** A test that stubs encryption tests nothing
   worth knowing.
2. **Assert the negative.** "Alice can read her own chat" is worth one line;
   "Bob cannot" is the test that catches the regression.

---

## What is not covered

Stated plainly, because a coverage claim that hides its gaps is worse than no
claim.

- **No browser-level unit tests for React components.** Component behaviour is
  covered only by the Playwright drives, which are not in CI.
- **The Playwright drives are not automated in CI.** They need a database, a
  server and browsers; they are run by hand before a release.
- **WebRTC media is not tested.** Signalling is; the actual peer connection and
  media path are not, because that needs two real browsers with real devices.
- **Push notification delivery is not tested end to end.** The payload
  construction is; whether Apple or Google actually deliver it is not.
- **No load or soak testing.** The concurrency tests race specific invariants;
  they say nothing about behaviour at scale.
- **No fuzzing** of the envelope parser or the API schemas.
- **No third-party security audit.** See SECURITY.md §14.

---

## Continuous integration

`.github/workflows/ci.yml` runs typecheck, lint and all three suites against a
PostgreSQL service container on every push and pull request.
