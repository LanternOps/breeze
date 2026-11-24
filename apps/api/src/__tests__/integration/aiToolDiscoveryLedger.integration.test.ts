import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiMessages, aiSessions, aiToolExecutions, aiToolSearchEvents } from '../../db/schema';
import { persistTurnDiscovery, type TurnDiscoveryWrite } from '../../services/aiToolDiscoveryLedger';
import { affectedRowCount } from '../../services/aiToolDiscoveryMetrics';
import { clearStatementFaults, failWritesOn } from './caughtQueryFaults';
import { createOrganization, createPartner } from './db-utils';

// #12421 W01 (plan Decision 9): the ledger's failure isolation and reconcile
// scoping, on real Postgres as breeze_app. Mocked Drizzle cannot see 25P02.

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

const admin = () => getTestDb() as any;

async function tenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const insertSession = async () => {
    const [row] = await admin().insert(aiSessions).values({ orgId: org.id, model: 'claude-test', sdkSessionId: `sdk-${randomUUID()}` }).returning({ id: aiSessions.id });
    return row!.id as string;
  };
  const sessionId = await insertSession();
  const otherSessionId = await insertSession();
  const [msg] = await admin().insert(aiMessages).values({ sessionId, role: 'user', content: 'synthetic question' }).returning({ id: aiMessages.id });
  return { orgId: org.id as string, sessionId, otherSessionId, turnMessageId: msg!.id as string };
}

function write(t: Awaited<ReturnType<typeof tenant>>, overrides: Partial<TurnDiscoveryWrite> = {}): TurnDiscoveryWrite {
  return {
    sessionId: t.sessionId,
    orgId: t.orgId,
    turnMessageId: t.turnMessageId,
    surface: 'chat',
    surfaceFingerprint: '0123456789abcdef',
    events: [
      { toolUseId: 'toolu_s1', roundTripId: 'msg_1', query: 'restart a service', maxResults: 5, selectMode: false, resultToolNames: ['manage_services'], calledToolNames: ['manage_services'], totalDeferred: null, empty: false },
      { toolUseId: 'toolu_s2', roundTripId: 'msg_2', query: 'print spooler', maxResults: 5, selectMode: false, resultToolNames: [], calledToolNames: [], totalDeferred: null, empty: true },
    ],
    turn: { searches: 2, searchOnlyRoundTrips: 2, workRoundTrips: 1, firstCallAfterSearches: 2, aborted: false },
    reconcile: new Map(),
    ...overrides,
  };
}

afterEach(async () => {
  await clearStatementFaults();
});

describe('persistTurnDiscovery on real Postgres (#12421 W01)', () => {
  it('a successful write lands 1 turn + N search rows readable by the org', async () => {
    const t = await tenant();
    const outcome = await persistTurnDiscovery(write(t));
    expect(outcome).toEqual({ ok: true, rows: 3, reconciled: 0 });
    const rows = await withDbAccessContext(orgContext(t.orgId), () =>
      db.select().from(aiToolSearchEvents).where(eq(aiToolSearchEvents.sessionId, t.sessionId))
    );
    expect(rows.map((r) => r.kind).sort()).toEqual(['search', 'search', 'turn']);
    expect(rows.every((r) => r.turnMessageId === t.turnMessageId)).toBe(true);
    expect(rows.find((r) => r.toolUseId === 'toolu_s2')).toMatchObject({ empty: true, resultToolNames: [] });
  });

  it('reconciles discovery by (session_id, tool_use_id) without touching another session that reuses the id string', async () => {
    const t = await tenant();
    const [mine] = await admin().insert(aiToolExecutions).values({
      sessionId: t.sessionId, toolName: 'manage_services', toolInput: {}, status: 'completed', discovery: 'loaded_earlier', toolUseId: 'toolu_c1',
    }).returning({ id: aiToolExecutions.id });
    const [theirs] = await admin().insert(aiToolExecutions).values({
      sessionId: t.otherSessionId, toolName: 'manage_services', toolInput: {}, status: 'completed', discovery: 'loaded_earlier', toolUseId: 'toolu_c1',
    }).returning({ id: aiToolExecutions.id });
    const [already] = await admin().insert(aiToolExecutions).values({
      sessionId: t.sessionId, toolName: 'query_devices', toolInput: {}, status: 'completed', discovery: 'always_loaded', toolUseId: 'toolu_c2',
    }).returning({ id: aiToolExecutions.id });

    const outcome = await persistTurnDiscovery(write(t, {
      reconcile: new Map([['toolu_c1', 'searched_this_turn'], ['toolu_c2', 'always_loaded']]),
    }));
    // toolu_c2 already held its final value: IS DISTINCT FROM leaves it unchanged.
    expect(outcome).toEqual({ ok: true, rows: 3, reconciled: 1 });
    const read = async (id: string) => (await admin().select({ d: aiToolExecutions.discovery }).from(aiToolExecutions).where(eq(aiToolExecutions.id, id)))[0].d;
    expect(await read(mine!.id)).toBe('searched_this_turn');
    expect(await read(theirs!.id)).toBe('loaded_earlier');
    expect(await read(already!.id)).toBe('always_loaded');
  });

  it('a forced statement failure is reported as { ok: false } and a following write in the same held context succeeds (no 25P02)', async () => {
    const t = await tenant();
    await failWritesOn('ai_tool_search_events', { ops: 'INSERT' });
    let outcome: Awaited<ReturnType<typeof persistTurnDiscovery>> | undefined;
    await withDbAccessContext(orgContext(t.orgId), async () => {
      outcome = await persistTurnDiscovery(write(t));
      await db.insert(aiMessages).values({ sessionId: t.sessionId, role: 'assistant', content: 'after the failed telemetry write' });
    });
    expect(outcome?.ok).toBe(false);
    expect((outcome as { error: string }).error).not.toContain('restart a service');
    const after = await admin().select({ id: aiMessages.id }).from(aiMessages)
      .where(and(eq(aiMessages.sessionId, t.sessionId), eq(aiMessages.content, 'after the failed telemetry write')));
    expect(after).toHaveLength(1);
    const events = await admin().select({ id: aiToolSearchEvents.id }).from(aiToolSearchEvents).where(eq(aiToolSearchEvents.sessionId, t.sessionId));
    expect(events).toHaveLength(0);
  });

  it('a reconcile failure rolls back the whole turn write (one savepoint) and is reported', async () => {
    const t = await tenant();
    await admin().insert(aiToolExecutions).values({ sessionId: t.sessionId, toolName: 'manage_services', toolInput: {}, status: 'completed', toolUseId: 'toolu_c1' });
    await failWritesOn('ai_tool_executions', { ops: 'UPDATE' });
    const outcome = await persistTurnDiscovery(write(t, { reconcile: new Map([['toolu_c1', 'searched_this_turn']]) }));
    expect(outcome.ok).toBe(false);
    const events = await admin().select({ id: aiToolSearchEvents.id }).from(aiToolSearchEvents).where(eq(aiToolSearchEvents.sessionId, t.sessionId));
    expect(events).toHaveLength(0);
  });

  it('affectedRowCount reads the postgres.js update count the tool-call counter depends on', async () => {
    const t = await tenant();
    const [exec] = await admin().insert(aiToolExecutions).values({ sessionId: t.sessionId, toolName: 'manage_services', toolInput: {}, status: 'executing' }).returning({ id: aiToolExecutions.id });
    const matched = await withDbAccessContext(orgContext(t.orgId), () =>
      db.update(aiToolExecutions).set({ status: 'completed' }).where(and(eq(aiToolExecutions.id, exec!.id), eq(aiToolExecutions.status, 'executing')))
    );
    expect(affectedRowCount(matched)).toBe(1);
    const unmatched = await withDbAccessContext(orgContext(t.orgId), () =>
      db.update(aiToolExecutions).set({ status: 'completed' }).where(and(eq(aiToolExecutions.id, exec!.id), eq(aiToolExecutions.status, 'executing')))
    );
    expect(affectedRowCount(unmatched)).toBe(0);
  });
});
