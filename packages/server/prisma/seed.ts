/**
 * Development seed.
 *
 * Creates a handful of accounts, a contact graph, a block, and a group with
 * real roles — enough to exercise permissions, the chat list, search and the
 * privacy settings without registering five accounts by hand every time the
 * database is reset.
 *
 * ## What it deliberately does not create: messages
 *
 * A WolffMsg message body is encrypted on the device that sends it, and the
 * content key is sealed to each recipient *device's* published prekey. Seeding
 * conversations would mean one of two things, and both are worse than an empty
 * chat:
 *
 *  - Writing plaintext into the database. There is no column for it — see the
 *    comment on `Message` in schema.prisma — and adding one would be the exact
 *    thing the whole design exists to prevent.
 *  - Generating device keys here, encrypting with them, and throwing the
 *    private halves away. The rows would look right and no browser could ever
 *    open them: a chat full of messages that permanently fail to decrypt.
 *
 * So the seeded accounts start with empty chats, and you type the first
 * message yourself from a real browser that holds real keys. Nothing here
 * pretends to be something it is not.
 *
 * Devices are not seeded either, for the same reason: a device row without the
 * private key in some browser's vault is a device that can never receive
 * anything. Each account gets its device the moment you sign in as it.
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/password.js';
import { env } from '../src/env.js';

const prisma = new PrismaClient();

/**
 * The shared password for every seeded account.
 *
 * Deliberately obvious rather than realistic: these accounts exist on a
 * developer's machine, and a plausible-looking password invites someone to
 * reuse the pattern somewhere it matters.
 */
const SEED_PASSWORD = 'seed-password-not-for-real-use';

interface SeedUser {
  username: string;
  displayName: string;
  bio: string;
}

const USERS: SeedUser[] = [
  {
    username: 'alice',
    displayName: 'Alice Renard',
    bio: 'Cartographer. Mostly nocturnal.',
  },
  {
    username: 'bob',
    displayName: 'Bob Nightfall',
    bio: 'Carries the lantern.',
  },
  {
    username: 'carol',
    displayName: 'Carol Vega',
    bio: 'Runs the north crossing.',
  },
  {
    username: 'dave',
    displayName: 'Dave Oakes',
    bio: '',
  },
  {
    username: 'mallory',
    displayName: 'Mallory Grey',
    bio: 'Blocked by Alice, on purpose — for testing the block rules.',
  },
];

/** For a direct chat, the two ids sorted and joined; see services/chats.ts. */
function directKeyFor(a: string, b: string): string {
  return [a, b].sort().join(':');
}

async function main(): Promise<void> {
  if (env.isProduction) {
    // These accounts share one well-known password. Refusing outright is the
    // only safe behaviour; a warning would eventually be ignored.
    console.error(
      'Refusing to seed: NODE_ENV is production. The seed creates accounts ' +
        'with a shared, published password.',
    );
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.user.count();
  if (existing > 0) {
    console.error(
      `Refusing to seed: the database already holds ${existing} account(s). ` +
        'Reset it first (npm run db:migrate -- --force-reset) so the seed ' +
        'never collides with data you meant to keep.',
    );
    process.exitCode = 1;
    return;
  }

  // One hash for every account: Argon2id is intentionally slow, and hashing
  // the same string five times would only make the seed five times slower.
  const passwordHash = await hashPassword(SEED_PASSWORD);

  const created = new Map<string, string>();

  for (const entry of USERS) {
    const user = await prisma.user.create({
      data: {
        username: entry.username,
        displayName: entry.displayName,
        ...(entry.bio ? { bio: entry.bio } : {}),
        passwordHash,
        settings: { create: {} },
      },
      select: { id: true },
    });
    created.set(entry.username, user.id);
  }

  const id = (username: string): string => {
    const value = created.get(username);
    if (!value) throw new Error(`Seed user ${username} was not created`);
    return value;
  };

  /*
   * Contacts are directional: Alice having Bob is not Bob having Alice. Seeding
   * both directions for some pairs and one for others is what makes the
   * asymmetry visible while developing.
   */
  const contacts: [string, string][] = [
    ['alice', 'bob'],
    ['bob', 'alice'],
    ['alice', 'carol'],
    ['carol', 'alice'],
    ['bob', 'carol'],
    ['carol', 'dave'],
  ];
  for (const [owner, target] of contacts) {
    await prisma.contact.create({
      data: { ownerId: id(owner), targetId: id(target) },
    });
  }

  // Alice blocks Mallory. Every send, presence and profile rule the server
  // enforces around blocking can be checked against this pair.
  await prisma.blockedUser.create({
    data: { blockerId: id('alice'), blockedId: id('mallory') },
  });

  // An empty direct chat, so the chat list is not blank on first sign-in.
  await prisma.chat.create({
    data: {
      type: 'direct',
      directKey: directKeyFor(id('alice'), id('bob')),
      members: {
        create: [{ userId: id('alice') }, { userId: id('bob') }],
      },
    },
  });

  // A group covering all three roles, which is what the permission checks in
  // services/access.ts are written against.
  await prisma.chat.create({
    data: {
      type: 'group',
      title: 'North Crossing',
      description: 'Planning the crossing. Owner: Alice. Admin: Carol.',
      ownerId: id('alice'),
      members: {
        create: [
          { userId: id('alice'), role: 'owner' },
          { userId: id('carol'), role: 'admin' },
          { userId: id('bob'), role: 'member' },
          { userId: id('dave'), role: 'member' },
        ],
      },
    },
  });

  console.error(
    [
      '',
      `Seeded ${USERS.length} accounts, ${contacts.length} contact links, 1 block,`,
      'one empty direct chat and one group (owner / admin / member).',
      '',
      `Sign in as any of: ${USERS.map((u) => u.username).join(', ')}`,
      `Password for all of them: ${SEED_PASSWORD}`,
      '',
      'Chats start empty on purpose: message bodies can only be encrypted by a',
      'device holding the private keys, and those live in a browser. Send the',
      'first message from the app.',
      '',
    ].join('\n'),
  );
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
