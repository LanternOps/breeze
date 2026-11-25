import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiMessages, aiSessions, aiToolSearchEvents } from '../../db/schema';
import { executeOrgMerge } from '../../services/orgMerge';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { createOrganization, createPartner, createUser } from './db-utils';

// #12421 W01 T2: ai_tool_search_events is a session-keyed FK child of
// ai_sessions with no org_id. Its four policies join through ai_sessions; the
// INSERT/UPDATE WITH CHECK also bind turn_message_id to a message of the SAME
// session (Review Focus 4). Every tenant assertion runs as breeze_app (`db`);
// seeding runs on the admin connection so it is never what is measured.

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

const admin = () => getTestDb() as any;

async function insertSession(orgId: string): Promise<string> {
  const [row] = await admin()
    .insert(aiSessions)
    .values({ orgId, model: 'claude-test', sdkSessionId: `sdk-${randomUUID()}` })
    .returning({ id: aiSessions.id });
  return row!.id;
}

async function insertUserMessage(sessionId: string): Promise<string> {
  const [row] = await admin()
    .insert(aiMessages)
    .values({ sessionId, role: 'user', content: 'synthetic question' })
    .returning({ id: aiMessages.id });
  return row!.id;
}

function searchRow(sessionId: string, turnMessageId: string | null, query = 'restart a windows service') {
  return {
    sessionId,
    turnMessageId,
    kind: 'search' as const,
    toolUseId: `toolu_${randomUUID().slice(0, 12)}`,
    roundTripId: `msg_${randomUUID().slice(0, 12)}`,
    surface: 'chat',
    surfaceFingerprint: '0123456789abcdef',
    query,
    maxResults: 5,
    selectMode: false,
    resultToolNames: ['manage_services'],
    calledToolNames: ['manage_services'],
    empty: false,
  };
}

function turnRow(sessionId: string, turnMessageId: string | null) {
  return {
    sessionId,
    turnMessageId,
    kind: 'turn' as const,
    surface: 'chat',
    surfaceFingerprint: '0123456789abcdef',
    searches: 1,
    searchOnlyRoundTrips: 1,
    workRoundTrips: 1,
    firstCallAfterSearches: 1,
    aborted: false,
  };
}

interface Tenant {
  partnerId: string;
  orgAId: string;
  orgBId: string;
  sessionA: string;
  sessionA2: string;
  sessionB: string;
  messageA: string;
  messageA2: string;
  rowsA: string[];
  rowB: string;
}

async function seed(): Promise<Tenant> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const sessionA = await insertSession(orgA.id);
  const sessionA2 = await insertSession(orgA.id);
  const sessionB = await insertSession(orgB.id);
  const messageA = await insertUserMessage(sessionA);
  const messageA2 = await insertUserMessage(sessionA2);
  const messageB = await insertUserMessage(sessionB);
  const rowsA = await admin()
    .insert(aiToolSearchEvents)
    .values([searchRow(sessionA, messageA), turnRow(sessionA, messageA)])
    .returning({ id: aiToolSearchEvents.id });
  const [rowB] = await admin()
    .insert(aiToolSearchEvents)
    .values(searchRow(sessionB, messageB))
    .returning({ id: aiToolSearchEvents.id });
  return {
    partnerId: partner.id,
    orgAId: orgA.id,
    orgBId: orgB.id,
    sessionA,
    sessionA2,
    sessionB,
    messageA,
    messageA2,
    rowsA: rowsA.map((r: { id: string }) => r.id),
    rowB: rowB!.id,
  };
}

async function countForSession(sessionId: string): Promise<number> {
  const rows = await admin().select({ id: aiToolSearchEvents.id }).from(aiToolSearchEvents).where(eq(aiToolSearchEvents.sessionId, sessionId));
  return rows.length;
}

describe('ai_tool_search_events RLS (#12421 W01)', () => {
  it('org A reads its own session\'s search and turn rows and sees none of org B', async () => {
    const t = await seed();
    const rows = await withDbAccessContext(orgContext(t.orgAId), () =>
      db.select({ id: aiToolSearchEvents.id, sessionId: aiToolSearchEvents.sessionId }).from(aiToolSearchEvents)
        .where(inArray(aiToolSearchEvents.sessionId, [t.sessionA, t.sessionB]))
    );
    expect(rows.map((r) => r.id).sort()).toEqual([...t.rowsA].sort());
    expect(rows.every((r) => r.sessionId === t.sessionA)).toBe(true);

    // Positive control on the other side: org B sees its own row.
    const underB = await withDbAccessContext(orgContext(t.orgBId), () =>
      db.select({ id: aiToolSearchEvents.id }).from(aiToolSearchEvents).where(inArray(aiToolSearchEvents.sessionId, [t.sessionA, t.sessionB]))
    );
    expect(underB.map((r) => r.id)).toEqual([t.rowB]);
  });

  it('org B INSERT with org A\'s session_id is refused with 42501', async () => {
    const t = await seed();
    await expect(
      withDbAccessContext(orgContext(t.orgBId), () => db.insert(aiToolSearchEvents).values(searchRow(t.sessionA, null)))
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    expect(await countForSession(t.sessionA)).toBe(2);
  });

  it('org A INSERT with a turn_message_id of another org-A session is refused with 42501 (Review Focus 4)', async () => {
    const t = await seed();
    await expect(
      withDbAccessContext(orgContext(t.orgAId), () => db.insert(aiToolSearchEvents).values(searchRow(t.sessionA, t.messageA2)))
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    expect(await countForSession(t.sessionA)).toBe(2);
  });

  it('org A INSERT with a matching turn_message_id, and with none, succeeds (lifted-predicate control)', async () => {
    const t = await seed();
    await withDbAccessContext(orgContext(t.orgAId), () => db.insert(aiToolSearchEvents).values(searchRow(t.sessionA, t.messageA)));
    await withDbAccessContext(orgContext(t.orgAId), () => db.insert(aiToolSearchEvents).values(turnRow(t.sessionA, null)));
    expect(await countForSession(t.sessionA)).toBe(4);
  });

  it('org A UPDATE re-pointing turn_message_id to another session\'s message is refused with 42501', async () => {
    const t = await seed();
    await expect(
      withDbAccessContext(orgContext(t.orgAId), () =>
        db.update(aiToolSearchEvents).set({ turnMessageId: t.messageA2 }).where(eq(aiToolSearchEvents.id, t.rowsA[0]!))
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    // Control: a same-session update goes through.
    const changed = await withDbAccessContext(orgContext(t.orgAId), () =>
      db.update(aiToolSearchEvents).set({ calledToolNames: [] }).where(eq(aiToolSearchEvents.id, t.rowsA[0]!)).returning({ id: aiToolSearchEvents.id })
    );
    expect(changed).toHaveLength(1);
  });

  it('org B UPDATE and DELETE of org A\'s row match zero rows', async () => {
    const t = await seed();
    const updated = await withDbAccessContext(orgContext(t.orgBId), () =>
      db.update(aiToolSearchEvents).set({ query: 'tampered' }).where(eq(aiToolSearchEvents.id, t.rowsA[0]!)).returning({ id: aiToolSearchEvents.id })
    );
    expect(updated).toHaveLength(0);
    const deleted = await withDbAccessContext(orgContext(t.orgBId), () =>
      db.delete(aiToolSearchEvents).where(inArray(aiToolSearchEvents.id, t.rowsA)).returning({ id: aiToolSearchEvents.id })
    );
    expect(deleted).toHaveLength(0);
    const [stored] = await admin().select({ query: aiToolSearchEvents.query }).from(aiToolSearchEvents).where(eq(aiToolSearchEvents.id, t.rowsA[0]!));
    expect(stored.query).toBe('restart a windows service');
    expect(await countForSession(t.sessionA)).toBe(2);
  });

  it('system scope lifts org access but not the same-session predicate', async () => {
    const t = await seed();
    // The org-B denial above is breeze_has_org_access, not a missing grant or table:
    // under system scope the same forged session_id INSERT succeeds and every row reads.
    await withSystemDbAccessContext(() => db.insert(aiToolSearchEvents).values(searchRow(t.sessionA, null)));
    const all = await withSystemDbAccessContext(() =>
      db.select({ id: aiToolSearchEvents.id }).from(aiToolSearchEvents).where(inArray(aiToolSearchEvents.sessionId, [t.sessionA, t.sessionB]))
    );
    expect(all).toHaveLength(4);
    // The same-session clause is an independent AND in WITH CHECK: still refused.
    await expect(
      withSystemDbAccessContext(() => db.insert(aiToolSearchEvents).values(searchRow(t.sessionA, t.messageA2)))
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('ai_tool_search_events lifecycle (#12421 W01)', () => {
  it('deleting the ai_sessions row cascades its search rows', async () => {
    const t = await seed();
    await admin().delete(aiSessions).where(eq(aiSessions.id, t.sessionA));
    expect(await countForSession(t.sessionA)).toBe(0);
    expect(await countForSession(t.sessionB)).toBe(1);
  });

  it('org erasure through the tenant cascade leaves zero rows for that org\'s sessions', async () => {
    const t = await seed();
    const actor = await createUser({ partnerId: t.partnerId, orgId: null, email: `ase-erase-${randomUUID().slice(0, 8)}@example.test` });
    await cascadeDeleteOrg(t.orgAId, actor.id);
    expect(await countForSession(t.sessionA)).toBe(0);
    // The sibling org under the same partner keeps its row.
    expect(await countForSession(t.sessionB)).toBe(1);
  });

  it('org merge re-points ai_sessions and the rows follow their session', async () => {
    const priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    try {
      const t = await seed();
      const actor = await createUser({ partnerId: t.partnerId, orgId: null, email: `ase-merge-${randomUUID().slice(0, 8)}@example.test` });
      await executeOrgMerge({
        loserOrgId: t.orgAId,
        survivorOrgId: t.orgBId,
        partnerId: t.partnerId,
        performedBy: actor.id,
        performedByEmail: actor.email,
      });
      const [session] = await admin().select({ orgId: aiSessions.orgId }).from(aiSessions).where(eq(aiSessions.id, t.sessionA));
      expect(session.orgId).toBe(t.orgBId);
      expect(await countForSession(t.sessionA)).toBe(2);
      // The survivor now reads the loser's rows through the re-pointed session.
      const underSurvivor = await withDbAccessContext(orgContext(t.orgBId), () =>
        db.select({ id: aiToolSearchEvents.id }).from(aiToolSearchEvents).where(eq(aiToolSearchEvents.sessionId, t.sessionA))
      );
      expect(underSurvivor).toHaveLength(2);
    } finally {
      if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
    }
  });
});
