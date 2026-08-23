import type { SecurityEventRecord } from '@wolffmsg/shared';
import { prisma } from '../db.js';

/**
 * The append-only trail behind the Security Center.
 *
 * `detail` is written by the server only. It never contains message content,
 * a token, or a key — just enough for a person to recognise an action they did
 * or did not take.
 */
export async function recordSecurityEvent(params: {
  userId: string;
  kind: SecurityEventRecord['kind'];
  detail: string;
  ipHint: string | null;
}): Promise<void> {
  await prisma.securityEvent
    .create({
      data: {
        userId: params.userId,
        kind: params.kind,
        detail: params.detail.slice(0, 200),
        ipHint: params.ipHint,
      },
    })
    // Auditing must never break the action it is auditing.
    .catch(() => undefined);
}

export async function listSecurityEvents(
  userId: string,
  limit = 50,
): Promise<SecurityEventRecord[]> {
  const rows = await prisma.securityEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as SecurityEventRecord['kind'],
    createdAt: r.createdAt.toISOString(),
    detail: r.detail,
    ipHint: r.ipHint,
  }));
}
