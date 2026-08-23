import type { AuthContext } from './auth/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after a valid session cookie has been resolved. */
    auth?: AuthContext;
  }
}

export {};
