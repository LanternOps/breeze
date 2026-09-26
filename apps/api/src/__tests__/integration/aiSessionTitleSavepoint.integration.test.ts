/**
 * Regression #7074: every chat send handler inserts the user message and then
 * auto-sets the session title in the SAME request transaction, catching and
 * logging a title failure. Without a savepoint a SQL-level title failure
 * aborts that transaction, and postgres.js re-throws the swallowed error at
 * COMMIT — the user-message insert is rolled back even though the handler
 * already moved on and started the assistant's turn.
 *
 * persistAutoSessionTitle must isolate its failure in a savepoint so the
 * message insert survives. A title longer than the varchar(255) column is the
 * deterministic SQL-level failure used here (22001 string_data_right_truncation);
 * in production the same path is hit by a deadlock, an RLS denial or a
 * connection blip.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiMessages, aiSessions } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { persistAutoSessionTitle } from '../../services/aiSessionTitle';
import { pgErrorCode } from '../../utils/pgErrors';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgCtx(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: null, userId: null };
}

async function seedSession(): Promise<{ orgId: string; sessionId: string }> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [session] = await db.insert(aiSessions).values({ orgId: org.id }).returning({ id: aiSessions.id });
    return { orgId: org.id, sessionId: session!.id };
  });
}

async function readBack(sessionId: string) {
  return withSystemDbAccessContext(async () => {
    const messages = await db.select({ content: aiMessages.content }).from(aiMessages)
      .where(eq(aiMessages.sessionId, sessionId));
    const [session] = await db.select({ title: aiSessions.title }).from(aiSessions)
      .where(eq(aiSessions.id, sessionId));
    return { messages, title: session?.title ?? null };
  });
}

describe('persistAutoSessionTitle (real DB, breeze_app) — #7074', () => {
  runDb('a failing title update does not roll back the user message inserted in the same request transaction', async () => {
    const { orgId, sessionId } = await seedSession();

    let titleError: unknown;
    await withDbAccessContext(orgCtx(orgId), async () => {
      await db.insert(aiMessages).values({ sessionId, role: 'user', content: 'keep me' });
      try {
        await persistAutoSessionTitle(sessionId, 'x'.repeat(300));
      } catch (err) {
        titleError = err; // the route handlers catch and log exactly like this
      }
    });

    expect(pgErrorCode(titleError)).toBe('22001');
    const after = await readBack(sessionId);
    expect(after.messages).toEqual([{ content: 'keep me' }]);
    expect(after.title).toBeNull();
  });

  runDb('a successful title update commits with the message', async () => {
    const { orgId, sessionId } = await seedSession();

    await withDbAccessContext(orgCtx(orgId), async () => {
      await db.insert(aiMessages).values({ sessionId, role: 'user', content: 'hello' });
      await persistAutoSessionTitle(sessionId, 'hello');
    });

    const after = await readBack(sessionId);
    expect(after.messages).toEqual([{ content: 'hello' }]);
    expect(after.title).toBe('hello');
  });
});
