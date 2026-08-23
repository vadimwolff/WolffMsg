import { buildApp } from './app.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { connectDatabase, disconnectDatabase, prisma } from './db.js';
import { closeRedis } from './redis.js';
import { ensureStorageReady } from './storage/local.js';
import {
  attachWebSocketServer,
  shutdownWebSockets,
} from './realtime/socket.js';
import {
  closeAllConnections,
  initHub,
  initSessionRevocationListener,
} from './realtime/hub.js';
import { sweepOrphanAttachments } from './services/attachments.js';

/**
 * Background housekeeping. Each task is wrapped so a failure logs and retries
 * on the next tick rather than taking the process down.
 */
function startMaintenance(): NodeJS.Timeout[] {
  const hourly = setInterval(
    () => {
      void sweepOrphanAttachments().catch((err) =>
        logger.error({ err }, 'attachment sweep failed'),
      );
      void prisma.session
        .deleteMany({
          where: {
            OR: [
              { expiresAt: { lt: new Date(Date.now() - 7 * 86_400_000) } },
              { revokedAt: { lt: new Date(Date.now() - 7 * 86_400_000) } },
            ],
          },
        })
        .catch((err) => logger.error({ err }, 'session cleanup failed'));
      void prisma.loginAttempt
        .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 86_400_000) } } })
        .catch((err) => logger.error({ err }, 'login attempt cleanup failed'));
      void prisma.notification
        .deleteMany({
          where: {
            readAt: { not: null, lt: new Date(Date.now() - 30 * 86_400_000) },
          },
        })
        .catch((err) => logger.error({ err }, 'notification cleanup failed'));
    },
    60 * 60 * 1000,
  );
  hourly.unref?.();
  return [hourly];
}

async function main(): Promise<void> {
  await connectDatabase();
  await ensureStorageReady();
  await initHub();
  await initSessionRevocationListener();

  const app = await buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });

  attachWebSocketServer(app.server);
  const timers = startMaintenance();

  logger.info(
    { port: env.PORT, env: env.NODE_ENV, redis: env.redisEnabled, push: env.pushEnabled },
    'WolffMsg server listening',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    for (const timer of timers) clearInterval(timer);
    closeAllConnections();
    await shutdownWebSockets().catch(() => undefined);
    await app.close().catch(() => undefined);
    await closeRedis().catch(() => undefined);
    await disconnectDatabase().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A crash mid-request must not leave the process in an undefined state.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception — exiting');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'server failed to start');
  process.exit(1);
});
