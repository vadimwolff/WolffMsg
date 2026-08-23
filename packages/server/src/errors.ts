import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * An error whose message is safe to show a user.
 *
 * Anything thrown that is *not* an AppError is treated as an internal fault:
 * it gets logged with full detail and answered with a generic message, so
 * stack traces and driver errors never reach a client.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (
  message: string,
  fields?: Record<string, string>,
  code = 'bad_request',
) => new AppError(400, code, message, fields);

export const unauthorized = (message = 'You need to sign in to do that') =>
  new AppError(401, 'unauthorized', message);

/**
 * Used for both "you may not" and "it does not exist" wherever revealing the
 * difference would leak the existence of another user's resource.
 */
export const forbidden = (message = 'You do not have access to that') =>
  new AppError(403, 'forbidden', message);

export const notFound = (message = 'Not found') =>
  new AppError(404, 'not_found', message);

export const conflict = (message: string, code = 'conflict') =>
  new AppError(409, code, message);

export const tooLarge = (message: string) =>
  new AppError(413, 'payload_too_large', message);

export const rateLimited = (message: string, retryAfterSeconds: number) => {
  const err = new AppError(429, 'rate_limited', message);
  (err as AppError & { retryAfter?: number }).retryAfter = retryAfterSeconds;
  return err;
};

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'not_found', message: 'Not found' },
    });
  });

  app.setErrorHandler(
    (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof AppError) {
        const retryAfter = (error as AppError & { retryAfter?: number }).retryAfter;
        if (retryAfter) reply.header('Retry-After', String(retryAfter));
        reply.status(error.statusCode).send({
          error: {
            code: error.code,
            message: error.message,
            ...(error.fields ? { fields: error.fields } : {}),
          },
        });
        return;
      }

      if (error instanceof ZodError) {
        const fields: Record<string, string> = {};
        for (const issue of error.issues) {
          const key = issue.path.join('.') || '_';
          if (!fields[key]) fields[key] = issue.message;
        }
        reply.status(400).send({
          error: {
            code: 'validation_failed',
            message: 'Some of those details are not valid',
            fields,
          },
        });
        return;
      }

      const fastifyError = error as {
        statusCode?: number;
        code?: string;
        message?: string;
      };

      // Fastify's own client-side errors (bad JSON, payload too large, …) are
      // safe to surface, but only with our own wording.
      if (
        typeof fastifyError.statusCode === 'number' &&
        fastifyError.statusCode >= 400 &&
        fastifyError.statusCode < 500
      ) {
        const message =
          fastifyError.statusCode === 413
            ? 'That upload is too large'
            : 'That request could not be processed';
        reply.status(fastifyError.statusCode).send({
          error: { code: fastifyError.code ?? 'bad_request', message },
        });
        return;
      }

      // Genuine server fault. Log everything, tell the client nothing.
      const ref = Math.random().toString(36).slice(2, 10);
      logger.error(
        {
          ref,
          err: error,
          method: request.method,
          url: request.routeOptions?.url ?? request.url,
          userId: request.auth?.userId,
        },
        'unhandled server error',
      );
      reply.status(500).send({
        error: {
          code: 'internal_error',
          message: env.isProduction
            ? `Something went wrong. Reference ${ref}`
            : `Something went wrong (${(error as Error)?.message ?? 'unknown'}). Reference ${ref}`,
        },
      });
    },
  );
}
