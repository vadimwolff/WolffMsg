import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/session.js';
import { RATE_LIMITS, consumeByUser } from '../security/rateLimit.js';
import {
  addContact,
  blockUser,
  listBlocked,
  listContacts,
  removeContact,
  unblockUser,
  unverifyContact,
  verifyContact,
} from '../services/contacts.js';

const idSchema = z.string().min(1).max(64);

export async function socialRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/contacts', async (request) => {
    const auth = requireAuth(request);
    return { contacts: await listContacts(auth.userId) };
  });

  app.post('/api/contacts', async (request, reply) => {
    const auth = requireAuth(request);
    await consumeByUser(RATE_LIMITS.addContact, auth.userId);
    const { userId, alias } = z
      .object({ userId: idSchema, alias: z.string().max(200).nullable().default(null) })
      .parse(request.body);
    const contact = await addContact(auth.userId, userId, alias);
    reply.status(201);
    return { contact };
  });

  app.delete<{ Params: { userId: string } }>(
    '/api/contacts/:userId',
    async (request) => {
      const auth = requireAuth(request);
      await removeContact(auth.userId, request.params.userId);
      return { ok: true };
    },
  );

  /** Record that safety numbers were compared out of band and matched. */
  app.post<{ Params: { userId: string } }>(
    '/api/contacts/:userId/verify',
    async (request) => {
      const auth = requireAuth(request);
      const { identityPublicKey } = z
        .object({ identityPublicKey: z.string().min(1).max(128) })
        .parse(request.body);
      await verifyContact(auth.userId, request.params.userId, identityPublicKey);
      return { ok: true };
    },
  );

  app.delete<{ Params: { userId: string } }>(
    '/api/contacts/:userId/verify',
    async (request) => {
      const auth = requireAuth(request);
      await unverifyContact(auth.userId, request.params.userId);
      return { ok: true };
    },
  );

  app.get('/api/blocked', async (request) => {
    const auth = requireAuth(request);
    return { blocked: await listBlocked(auth.userId) };
  });

  app.post('/api/blocked', async (request, reply) => {
    const auth = requireAuth(request);
    const { userId } = z.object({ userId: idSchema }).parse(request.body);
    await blockUser(auth.userId, userId);
    reply.status(201);
    return { ok: true };
  });

  app.delete<{ Params: { userId: string } }>(
    '/api/blocked/:userId',
    async (request) => {
      const auth = requireAuth(request);
      await unblockUser(auth.userId, request.params.userId);
      return { ok: true };
    },
  );
}
