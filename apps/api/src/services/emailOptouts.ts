import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { userEmailOptouts } from '../db/schema';

// Per-user email opt-outs (spec 2026-10-15 §2.2, §6). The topic list is closed:
// the migration's CHECK mirrors it, so a new topic is a deliberate migration.
// Every function runs in the CALLER's DB context: a request context reads and
// writes only the caller's own row (Shape 6 RLS); the one-click unsubscribe and
// the digest job call these from system scope.

export const EMAIL_OPTOUT_TOPICS = ['connection_health_digest'] as const;
export type EmailOptoutTopic = (typeof EMAIL_OPTOUT_TOPICS)[number];
export type EmailOptoutSource = 'settings' | 'one_click';

export function isEmailOptoutTopic(value: unknown): value is EmailOptoutTopic {
  return typeof value === 'string' && (EMAIL_OPTOUT_TOPICS as readonly string[]).includes(value);
}

function assertTopic(topic: string): asserts topic is EmailOptoutTopic {
  if (!isEmailOptoutTopic(topic)) throw new Error(`unknown email opt-out topic: ${topic}`);
}

/** Spec §6 resolver: true when the user has opted out of `topic`. */
export async function isOptedOut(userId: string, topic: EmailOptoutTopic): Promise<boolean> {
  assertTopic(topic);
  const rows = await db
    .select({ userId: userEmailOptouts.userId })
    .from(userEmailOptouts)
    .where(and(eq(userEmailOptouts.userId, userId), eq(userEmailOptouts.topic, topic)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Record an opt-out. Idempotent: an existing row (from either source) is kept.
 * Written as INSERT … SELECT FROM users so an id that no longer exists is a
 * no-op instead of an FK error (an old unsubscribe link for a deleted user).
 * Returns whether the user exists.
 */
export async function setEmailOptOut(
  userId: string,
  topic: EmailOptoutTopic,
  source: EmailOptoutSource,
): Promise<{ userExists: boolean }> {
  assertTopic(topic);
  const rows = await db.execute(sql`
    WITH u AS (SELECT id FROM users WHERE id = ${userId}),
    ins AS (
      INSERT INTO user_email_optouts (user_id, topic, source)
      SELECT id, ${topic}, ${source} FROM u
      ON CONFLICT (user_id, topic) DO NOTHING
    )
    SELECT count(*)::int AS n FROM u
  `);
  const n = Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  return { userExists: n > 0 };
}

/** Remove an opt-out (re-subscribe). Idempotent. */
export async function clearEmailOptOut(userId: string, topic: EmailOptoutTopic): Promise<void> {
  assertTopic(topic);
  await db
    .delete(userEmailOptouts)
    .where(and(eq(userEmailOptouts.userId, userId), eq(userEmailOptouts.topic, topic)));
}
