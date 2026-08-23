import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptMessage, randomId } from '@wolffmsg/shared';
import {
  claimBundles,
  closeApp,
  createActor,
  createGroup,
  identityMap,
  openDirect,
  prisma,
  readDecrypted,
  request,
  resetDatabase,
  sendEncrypted,
  type TestActor,
} from './helpers.js';

/**
 * Access control.
 *
 * Every test here takes the position of an attacker who knows the right ids
 * and holds a valid session for *some* account. Knowing an id must never be
 * enough.
 */

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeApp();
});

/** Try to post into a chat with a well-formed envelope but no membership. */
async function attemptSend(
  attacker: TestActor,
  chatId: string,
  bundleSource: TestActor,
  sourceChatId: string,
) {
  const bundles = await claimBundles(bundleSource, sourceChatId);
  const messageId = randomId(16);
  const createdAt = Date.now();
  const envelope = encryptMessage(
    { v: 1, body: 'intrusion' },
    {
      messageId,
      chatId,
      senderUserId: attacker.userId,
      senderDeviceId: attacker.deviceId,
      createdAt,
    },
    attacker.secrets.identityPrivateKey,
    bundles,
  );
  return request({
    method: 'POST',
    url: `/api/chats/${chatId}/messages`,
    actor: attacker,
    payload: {
      id: messageId,
      clientId: randomId(12),
      createdAt,
      envelope,
      replyToId: null,
      attachmentIds: [],
    },
  });
}

describe('conversation access', () => {
  it('User A cannot read User B private chat', async () => {
    const bob = await createActor();
    const carol = await createActor();
    const eve = await createActor();
    const chatId = await openDirect(bob, carol);
    await sendEncrypted(bob, chatId, 'private between us');

    const asEve = await request({
      method: 'GET',
      url: `/api/chats/${chatId}/messages`,
      actor: eve,
    });
    expect(asEve.status).toBe(404);

    const chatDetail = await request({
      method: 'GET',
      url: `/api/chats/${chatId}`,
      actor: eve,
    });
    expect(chatDetail.status).toBe(404);
  });

  it('answers 404 rather than 403, so existence is not disclosed', async () => {
    const bob = await createActor();
    const carol = await createActor();
    const eve = await createActor();
    const realChat = await openDirect(bob, carol);

    const existing = await request({
      method: 'GET',
      url: `/api/chats/${realChat}`,
      actor: eve,
    });
    const imaginary = await request({
      method: 'GET',
      url: '/api/chats/cm000000000000000000000',
      actor: eve,
    });
    expect(existing.status).toBe(imaginary.status);
  });

  it('User A cannot post into User B private chat', async () => {
    const bob = await createActor();
    const carol = await createActor();
    const eve = await createActor();
    const victimChat = await openDirect(bob, carol);
    const eveChat = await openDirect(eve, bob);

    const response = await attemptSend(eve, victimChat, eve, eveChat);
    expect([403, 404]).toContain(response.status);
    expect(await prisma.message.count({ where: { chatId: victimChat } })).toBe(0);
  });

  it('User A cannot list another chat members', async () => {
    const bob = await createActor();
    const carol = await createActor();
    const eve = await createActor();
    const groupId = await createGroup(bob, 'Private group', [carol.userId]);

    const response = await request({
      method: 'GET',
      url: `/api/chats/${groupId}`,
      actor: eve,
    });
    expect(response.status).toBe(404);
  });

  it('only shows a member history from the point they joined', async () => {
    const owner = await createActor();
    const early = await createActor();
    const late = await createActor();
    const groupId = await createGroup(owner, 'History test', [early.userId]);

    await sendEncrypted(owner, groupId, 'before the newcomer arrived');

    await request({
      method: 'POST',
      url: `/api/chats/${groupId}/members`,
      actor: owner,
      payload: { userIds: [late.userId] },
    });

    await sendEncrypted(owner, groupId, 'after the newcomer arrived');

    const lateView = await readDecrypted(late, groupId, identityMap(owner));
    const bodies = lateView.map((m) => m.body);
    expect(bodies).not.toContain('before the newcomer arrived');
    expect(bodies).toContain('after the newcomer arrived');
  });
});

describe('message ownership', () => {
  it('User A cannot delete User B message', async () => {
    const bob = await createActor();
    const carol = await createActor();
    const chatId = await openDirect(bob, carol);
    const sent = await sendEncrypted(bob, chatId, 'mine to delete');

    const response = await request({
      method: 'DELETE',
      url: `/api/messages/${sent.id}`,
      actor: carol,
    });
    expect(response.status).toBe(403);

    const row = await prisma.message.findUniqueOrThrow({
      where: { id: sent.id },
      select: { deletedAt: true },
    });
    expect(row.deletedAt).toBeNull();
  });

  it('an outsider cannot delete a message at all', async () => {
    const bob = await createActor();
    const carol = await createActor();
    const eve = await createActor();
    const chatId = await openDirect(bob, carol);
    const sent = await sendEncrypted(bob, chatId, 'not yours');

    const response = await request({
      method: 'DELETE',
      url: `/api/messages/${sent.id}`,
      actor: eve,
    });
    expect(response.status).toBe(404);
  });

  it('User A cannot edit User B message', async () => {
    const bob = await createActor();
    const carol = await createActor();
    const chatId = await openDirect(bob, carol);
    const sent = await sendEncrypted(bob, chatId, 'original wording');

    const bundles = await claimBundles(carol, chatId);
    const forged = encryptMessage(
      { v: 1, body: 'rewritten by someone else' },
      sent.context,
      carol.secrets.identityPrivateKey,
      bundles,
    );

    const response = await request({
      method: 'PATCH',
      url: `/api/messages/${sent.id}`,
      actor: carol,
      payload: { envelope: forged },
    });
    expect(response.status).toBe(403);
  });

  it('a deleted message loses its ciphertext, not just its visibility', async () => {
    const bob = await createActor();
    const carol = await createActor();
    const chatId = await openDirect(bob, carol);
    const sent = await sendEncrypted(bob, chatId, 'delete me');

    await request({ method: 'DELETE', url: `/api/messages/${sent.id}`, actor: bob });

    const row = await prisma.message.findUniqueOrThrow({
      where: { id: sent.id },
      include: { keys: true },
    });
    expect(row.ciphertext).toBeNull();
    expect(row.nonce).toBeNull();
    expect(row.signature).toBeNull();
    expect(row.keys).toHaveLength(0);
    expect(row.deletedAt).not.toBeNull();
  });

  it('an outsider cannot react to a message', async () => {
    const bob = await createActor();
    const carol = await createActor();
    const eve = await createActor();
    const chatId = await openDirect(bob, carol);
    const sent = await sendEncrypted(bob, chatId, 'react to me');

    const response = await request({
      method: 'POST',
      url: `/api/messages/${sent.id}/reactions`,
      actor: eve,
      payload: { emoji: '🐺' },
    });
    expect(response.status).toBe(404);
  });

  it('rejects a reaction that is not an emoji', async () => {
    const bob = await createActor();
    const carol = await createActor();
    const chatId = await openDirect(bob, carol);
    const sent = await sendEncrypted(bob, chatId, 'react to me');

    for (const value of ['hello', '<script>', '12345', ' ']) {
      const response = await request({
        method: 'POST',
        url: `/api/messages/${sent.id}/reactions`,
        actor: carol,
        payload: { emoji: value },
      });
      expect(response.status).toBe(400);
    }
  });
});

describe('group permissions', () => {
  async function groupWithRoles() {
    const owner = await createActor();
    const admin = await createActor();
    const member = await createActor();
    const outsider = await createActor();
    const groupId = await createGroup(owner, 'Pack', [admin.userId, member.userId]);

    await request({
      method: 'PATCH',
      url: `/api/chats/${groupId}/members/${admin.userId}/role`,
      actor: owner,
      payload: { role: 'admin' },
    });

    return { owner, admin, member, outsider, groupId };
  }

  it('a member cannot add or remove people', async () => {
    const { member, outsider, groupId } = await groupWithRoles();

    const add = await request({
      method: 'POST',
      url: `/api/chats/${groupId}/members`,
      actor: member,
      payload: { userIds: [outsider.userId] },
    });
    expect(add.status).toBe(403);
  });

  it('a member cannot rename the group', async () => {
    const { member, groupId } = await groupWithRoles();
    const response = await request({
      method: 'PATCH',
      url: `/api/chats/${groupId}`,
      actor: member,
      payload: { title: 'Hijacked' },
    });
    expect(response.status).toBe(403);
  });

  it('a member cannot promote themselves', async () => {
    const { member, groupId } = await groupWithRoles();
    const response = await request({
      method: 'PATCH',
      url: `/api/chats/${groupId}/members/${member.userId}/role`,
      actor: member,
      payload: { role: 'admin' },
    });
    expect(response.status).toBe(403);

    const row = await prisma.chatMember.findUniqueOrThrow({
      where: { chatId_userId: { chatId: groupId, userId: member.userId } },
      select: { role: true },
    });
    expect(row.role).toBe('member');
  });

  it('an admin can add and remove ordinary members', async () => {
    const { admin, member, outsider, groupId } = await groupWithRoles();

    const add = await request({
      method: 'POST',
      url: `/api/chats/${groupId}/members`,
      actor: admin,
      payload: { userIds: [outsider.userId] },
    });
    expect(add.status).toBe(200);

    const remove = await request({
      method: 'DELETE',
      url: `/api/chats/${groupId}/members/${member.userId}`,
      actor: admin,
    });
    expect(remove.status).toBe(200);
  });

  it('an admin cannot remove the owner', async () => {
    const { owner, admin, groupId } = await groupWithRoles();
    const response = await request({
      method: 'DELETE',
      url: `/api/chats/${groupId}/members/${owner.userId}`,
      actor: admin,
    });
    expect(response.status).toBe(403);
  });

  it('an admin cannot remove another admin', async () => {
    const { owner, admin, member, groupId } = await groupWithRoles();
    await request({
      method: 'PATCH',
      url: `/api/chats/${groupId}/members/${member.userId}/role`,
      actor: owner,
      payload: { role: 'admin' },
    });

    const response = await request({
      method: 'DELETE',
      url: `/api/chats/${groupId}/members/${member.userId}`,
      actor: admin,
    });
    expect(response.status).toBe(403);
  });

  it('an admin cannot promote or demote — only the owner can', async () => {
    const { admin, member, groupId } = await groupWithRoles();
    const response = await request({
      method: 'PATCH',
      url: `/api/chats/${groupId}/members/${member.userId}/role`,
      actor: admin,
      payload: { role: 'admin' },
    });
    expect(response.status).toBe(403);
  });

  it('an admin cannot delete the group', async () => {
    const { admin, groupId } = await groupWithRoles();
    const response = await request({
      method: 'DELETE',
      url: `/api/chats/${groupId}`,
      actor: admin,
    });
    expect(response.status).toBe(403);
    expect(await prisma.chat.count({ where: { id: groupId } })).toBe(1);
  });

  it('the owner can transfer ownership, and then loses owner powers', async () => {
    const { owner, admin, groupId } = await groupWithRoles();

    const transfer = await request({
      method: 'POST',
      url: `/api/chats/${groupId}/transfer-ownership`,
      actor: owner,
      payload: { userId: admin.userId },
    });
    expect(transfer.status).toBe(200);

    const roles = await prisma.chatMember.findMany({
      where: { chatId: groupId },
      select: { userId: true, role: true },
    });
    expect(roles.find((r) => r.userId === admin.userId)?.role).toBe('owner');
    expect(roles.find((r) => r.userId === owner.userId)?.role).toBe('admin');

    const nowRefused = await request({
      method: 'DELETE',
      url: `/api/chats/${groupId}`,
      actor: owner,
    });
    expect(nowRefused.status).toBe(403);
  });

  it('read-only mode stops members posting but not admins', async () => {
    const { owner, admin, member, groupId } = await groupWithRoles();

    const lock = await request({
      method: 'PATCH',
      url: `/api/chats/${groupId}/permissions`,
      actor: owner,
      payload: { readOnlyForMembers: true },
    });
    expect(lock.status).toBe(200);

    const asMember = await sendEncrypted(member, groupId, 'may I speak?');
    expect(asMember.status).toBe(403);

    const asAdmin = await sendEncrypted(admin, groupId, 'admins may');
    expect(asAdmin.status).toBe(201);
  });

  it('a member cannot pin a message; an admin can', async () => {
    const { owner, admin, member, groupId } = await groupWithRoles();
    const sent = await sendEncrypted(owner, groupId, 'pin me');

    const asMember = await request({
      method: 'POST',
      url: `/api/chats/${groupId}/pins/${sent.id}`,
      actor: member,
    });
    expect(asMember.status).toBe(403);

    const asAdmin = await request({
      method: 'POST',
      url: `/api/chats/${groupId}/pins/${sent.id}`,
      actor: admin,
    });
    expect(asAdmin.status).toBe(200);
  });

  it('a group admin can delete a member message, but cannot rewrite it', async () => {
    const { owner, member, groupId } = await groupWithRoles();
    const sent = await sendEncrypted(member, groupId, 'off topic');

    const bundles = await claimBundles(owner, groupId);
    const rewrite = await request({
      method: 'PATCH',
      url: `/api/messages/${sent.id}`,
      actor: owner,
      payload: {
        envelope: encryptMessage(
          { v: 1, body: 'words put in their mouth' },
          sent.context,
          owner.secrets.identityPrivateKey,
          bundles,
        ),
      },
    });
    expect(rewrite.status).toBe(403);

    const remove = await request({
      method: 'DELETE',
      url: `/api/messages/${sent.id}`,
      actor: owner,
    });
    expect(remove.status).toBe(200);
  });

  it('a removed member immediately loses access', async () => {
    const { owner, member, groupId } = await groupWithRoles();
    await sendEncrypted(owner, groupId, 'members only');

    expect(
      (await request({ method: 'GET', url: `/api/chats/${groupId}/messages`, actor: member }))
        .status,
    ).toBe(200);

    await request({
      method: 'DELETE',
      url: `/api/chats/${groupId}/members/${member.userId}`,
      actor: owner,
    });

    expect(
      (await request({ method: 'GET', url: `/api/chats/${groupId}/messages`, actor: member }))
        .status,
    ).toBe(404);
  });

  it('an outsider cannot leave, pin, or configure a group', async () => {
    const { outsider, groupId } = await groupWithRoles();
    for (const call of [
      { method: 'POST' as const, url: `/api/chats/${groupId}/leave` },
      { method: 'PATCH' as const, url: `/api/chats/${groupId}/permissions`, payload: { readOnlyForMembers: true } },
      { method: 'PATCH' as const, url: `/api/chats/${groupId}`, payload: { title: 'nope' } },
    ]) {
      const response = await request({ ...call, actor: outsider });
      expect(response.status).toBe(404);
    }
  });
});

describe('blocking', () => {
  it('a blocked user cannot send a message', async () => {
    const bob = await createActor();
    const nuisance = await createActor();
    const chatId = await openDirect(nuisance, bob);

    const before = await sendEncrypted(nuisance, chatId, 'hello there');
    expect(before.status).toBe(201);

    await request({
      method: 'POST',
      url: '/api/blocked',
      actor: bob,
      payload: { userId: nuisance.userId },
    });

    const after = await sendEncrypted(nuisance, chatId, 'hello again');
    expect(after.status).toBe(403);
  });

  it('blocking is symmetric in effect', async () => {
    const bob = await createActor();
    const nuisance = await createActor();
    const chatId = await openDirect(nuisance, bob);
    await request({
      method: 'POST',
      url: '/api/blocked',
      actor: bob,
      payload: { userId: nuisance.userId },
    });

    // The blocker also stops being able to write into that conversation.
    const response = await sendEncrypted(bob, chatId, 'one last word');
    expect(response.status).toBe(403);
  });

  it('unblocking restores messaging', async () => {
    const bob = await createActor();
    const other = await createActor();
    const chatId = await openDirect(other, bob);

    await request({
      method: 'POST',
      url: '/api/blocked',
      actor: bob,
      payload: { userId: other.userId },
    });
    expect((await sendEncrypted(other, chatId, 'blocked')).status).toBe(403);

    await request({
      method: 'DELETE',
      url: `/api/blocked/${other.userId}`,
      actor: bob,
    });
    expect((await sendEncrypted(other, chatId, 'unblocked')).status).toBe(201);
  });

  it('hides a blocked user from search', async () => {
    const bob = await createActor('wolf_searcher');
    const hidden = await createActor('wolf_hidden_one');

    const before = await request<{ users: { id: string }[] }>({
      method: 'GET',
      url: '/api/users/search?q=wolf_hidden',
      actor: bob,
    });
    expect(before.body.users.map((u) => u.id)).toContain(hidden.userId);

    await request({
      method: 'POST',
      url: '/api/blocked',
      actor: bob,
      payload: { userId: hidden.userId },
    });

    const after = await request<{ users: { id: string }[] }>({
      method: 'GET',
      url: '/api/users/search?q=wolf_hidden',
      actor: bob,
    });
    expect(after.body.users.map((u) => u.id)).not.toContain(hidden.userId);
  });

  it('a blocked user cannot open a fresh conversation', async () => {
    const bob = await createActor();
    const nuisance = await createActor();
    await request({
      method: 'POST',
      url: '/api/blocked',
      actor: bob,
      payload: { userId: nuisance.userId },
    });

    const response = await request({
      method: 'POST',
      url: '/api/chats/direct',
      actor: nuisance,
      payload: { userId: bob.userId },
    });
    expect(response.status).toBe(403);
  });

  it('a blocked user cannot add the blocker to a group', async () => {
    const bob = await createActor();
    const nuisance = await createActor();
    await request({
      method: 'POST',
      url: '/api/blocked',
      actor: bob,
      payload: { userId: nuisance.userId },
    });

    const groupId = await createGroup(nuisance, 'Unwanted');
    const response = await request<{ added: string[] }>({
      method: 'POST',
      url: `/api/chats/${groupId}/members`,
      actor: nuisance,
      payload: { userIds: [bob.userId] },
    });
    expect(response.body.added).not.toContain(bob.userId);
  });
});

describe('privacy settings', () => {
  it('honours "nobody may message me"', async () => {
    const recluse = await createActor();
    const stranger = await createActor();

    await request({
      method: 'PATCH',
      url: '/api/me/privacy',
      actor: recluse,
      payload: { whoCanMessage: 'nobody' },
    });

    const response = await request({
      method: 'POST',
      url: '/api/chats/direct',
      actor: stranger,
      payload: { userId: recluse.userId },
    });
    expect(response.status).toBe(403);
  });

  it('honours "contacts only may message me"', async () => {
    const selective = await createActor();
    const stranger = await createActor();

    await request({
      method: 'PATCH',
      url: '/api/me/privacy',
      actor: selective,
      payload: { whoCanMessage: 'contacts' },
    });

    expect(
      (
        await request({
          method: 'POST',
          url: '/api/chats/direct',
          actor: stranger,
          payload: { userId: selective.userId },
        })
      ).status,
    ).toBe(403);

    // Once the recluse adds them, the door opens.
    await request({
      method: 'POST',
      url: '/api/contacts',
      actor: selective,
      payload: { userId: stranger.userId },
    });

    expect(
      (
        await request({
          method: 'POST',
          url: '/api/chats/direct',
          actor: stranger,
          payload: { userId: selective.userId },
        })
      ).status,
    ).toBe(201);
  });

  it('hides last-seen from someone outside the chosen audience', async () => {
    const shy = await createActor();
    const stranger = await createActor();
    await openDirect(shy, stranger);

    await request({
      method: 'PATCH',
      url: '/api/me/privacy',
      actor: shy,
      payload: { lastSeenVisibility: 'nobody' },
    });

    const response = await request<{
      user: { online: boolean | null; lastSeenAt: string | null };
    }>({ method: 'GET', url: `/api/users/${shy.userId}`, actor: stranger });

    expect(response.body.user.online).toBeNull();
    expect(response.body.user.lastSeenAt).toBeNull();
  });

  it('hides the bio when set to nobody', async () => {
    const shy = await createActor();
    const stranger = await createActor();
    await request({
      method: 'PATCH',
      url: '/api/me/profile',
      actor: shy,
      payload: { bio: 'Something personal' },
    });
    await request({
      method: 'PATCH',
      url: '/api/me/privacy',
      actor: shy,
      payload: { bioVisibility: 'nobody' },
    });

    const response = await request<{ user: { bio: string | null } }>({
      method: 'GET',
      url: `/api/users/${shy.userId}`,
      actor: stranger,
    });
    expect(response.body.user.bio).toBeNull();

    // But the owner still sees their own.
    const own = await request<{ user: { bio: string | null } }>({
      method: 'GET',
      url: '/api/auth/me',
      actor: shy,
    });
    expect(own.body.user.bio).toBe('Something personal');
  });

  it('refuses a group invitation when the audience does not allow it', async () => {
    const guarded = await createActor();
    const stranger = await createActor();

    await request({
      method: 'PATCH',
      url: '/api/me/privacy',
      actor: guarded,
      payload: { whoCanAddToGroups: 'nobody' },
    });

    const groupId = await createGroup(stranger, 'Uninvited');
    const response = await request<{ added: string[] }>({
      method: 'POST',
      url: `/api/chats/${groupId}/members`,
      actor: stranger,
      payload: { userIds: [guarded.userId] },
    });
    expect(response.body.added).toEqual([]);
  });

  it('suppresses read receipts when the reader turns them off', async () => {
    const sender = await createActor();
    const reader = await createActor();
    const chatId = await openDirect(sender, reader);
    const sent = await sendEncrypted(sender, chatId, 'did you see this?');

    await request({
      method: 'PATCH',
      url: '/api/me/privacy',
      actor: reader,
      payload: { readReceipts: false },
    });

    await request({
      method: 'POST',
      url: `/api/chats/${chatId}/read`,
      actor: reader,
      payload: { messageIds: [sent.id] },
    });

    // The reader's own unread count clears...
    const chats = await request<{ chats: { id: string; unreadCount: number }[] }>({
      method: 'GET',
      url: '/api/chats',
      actor: reader,
    });
    expect(chats.body.chats.find((c) => c.id === chatId)?.unreadCount).toBe(0);
  });
});

describe('input that should never be trusted', () => {
  it('ignores a sender device id supplied in the request body', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const bundles = await claimBundles(alice, chatId);

    const messageId = randomId(16);
    const createdAt = Date.now();
    const envelope = encryptMessage(
      { v: 1, body: 'whose device?' },
      {
        messageId,
        chatId,
        senderUserId: alice.userId,
        senderDeviceId: alice.deviceId,
        createdAt,
      },
      alice.secrets.identityPrivateKey,
      bundles,
    );

    await request({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      actor: alice,
      payload: {
        id: messageId,
        clientId: randomId(12),
        createdAt,
        envelope,
        replyToId: null,
        attachmentIds: [],
        // Attempts to attribute the message to Bob's device.
        senderDeviceId: bob.deviceId,
        senderId: bob.userId,
      },
    });

    const row = await prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      select: { senderId: true, senderDeviceId: true },
    });
    expect(row.senderId).toBe(alice.userId);
    expect(row.senderDeviceId).toBe(alice.deviceId);
  });

  it('ignores a role supplied in the request body', async () => {
    const owner = await createActor();
    const member = await createActor();
    const groupId = await createGroup(owner, 'Roles', [member.userId]);

    await request({
      method: 'PATCH',
      url: `/api/chats/${groupId}/membership`,
      actor: member,
      payload: { pinned: true, role: 'owner', archived: false },
    });

    const row = await prisma.chatMember.findUniqueOrThrow({
      where: { chatId_userId: { chatId: groupId, userId: member.userId } },
      select: { role: true, pinned: true },
    });
    expect(row.role).toBe('member');
    expect(row.pinned).toBe(true);
  });

  it('rejects a reply pointing at a message in another chat', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const carol = await createActor();
    const chatOne = await openDirect(alice, bob);
    const chatTwo = await openDirect(alice, carol);

    const inChatOne = await sendEncrypted(alice, chatOne, 'over here');
    const response = await sendEncrypted(alice, chatTwo, 'cross reply', {
      replyToId: inChatOne.id,
    });
    expect(response.status).toBe(400);
  });

  it('rejects a malformed message id', async () => {
    const alice = await createActor();
    const bob = await createActor();
    const chatId = await openDirect(alice, bob);
    const bundles = await claimBundles(alice, chatId);
    const createdAt = Date.now();

    const envelope = encryptMessage(
      { v: 1, body: 'x' },
      {
        messageId: '../../etc/passwd',
        chatId,
        senderUserId: alice.userId,
        senderDeviceId: alice.deviceId,
        createdAt,
      },
      alice.secrets.identityPrivateKey,
      bundles,
    );

    const response = await request({
      method: 'POST',
      url: `/api/chats/${chatId}/messages`,
      actor: alice,
      payload: {
        id: '../../etc/passwd',
        clientId: randomId(12),
        createdAt,
        envelope,
        replyToId: null,
        attachmentIds: [],
      },
    });
    expect(response.status).toBe(400);
  });

  it('does not leak internal detail in an error response', async () => {
    const alice = await createActor();
    const response = await request<{ error: { message: string } }>({
      method: 'GET',
      url: '/api/chats/does-not-exist',
      actor: alice,
    });
    const text = JSON.stringify(response.body);
    expect(text).not.toMatch(/prisma|postgres|at .*\.ts:|stack/i);
  });
});
