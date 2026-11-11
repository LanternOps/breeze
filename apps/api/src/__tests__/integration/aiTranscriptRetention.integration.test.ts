/**
 * #4342 W4 — AI transcript retention against real Postgres, through the
 * unprivileged `breeze_app` pool (forced RLS): a batch that forgot to elect
 * system scope matches zero rows here and fails these tests. Fixtures are
 * written with the privileged test connection.
 *
 * Pins: the stub keeps accounting and drops content; flagged sessions are
 * held (OD 2); an abandoned `active` session is stubbed and expired (Review
 * Focus 4); client sessions follow `client_ai_org_policies.retention_days`;
 * stubs are hard-deleted at the audit window only once no screenshot is left
 * (correction 8); an org with NO audit policy row keeps its stubs (decision B);
 * a second run is a no-op; report mode changes nothing and its counts match
 * what enforce does.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import {
  aiActionPlans,
  aiDataPolicies,
  aiMessages,
  aiScreenshots,
  aiSessions,
  aiToolExecutions,
  clientAiOrgPolicies,
  clientAiUsage,
  portalUsers,
} from '../../db/schema';
import { runAiTranscriptRetention } from '../../jobs/aiTranscriptRetention';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const daysAgo = (d: number) => ago(d * DAY_MS);
const TOMBSTONE = { _retention: 'scrubbed', at: NOW.toISOString() };

const deleter = vi.fn(async () => 'not_found' as const);
const run = (enforce: boolean) =>
  runAiTranscriptRetention({ batchSize: 50, maxBatches: 10, enforce, now: NOW, deleteTranscript: deleter });

async function newOrg(auditDays: number | null) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  // New orgs get a 365-day audit policy from a trigger; set or remove it explicitly.
  if (auditDays === null) {
    await getTestDb().execute(sql`DELETE FROM audit_retention_policies WHERE org_id = ${org.id}`);
  } else {
    await getTestDb().execute(sql`
      INSERT INTO audit_retention_policies (org_id, retention_days) VALUES (${org.id}, ${auditDays})
      ON CONFLICT (org_id) DO UPDATE SET retention_days = EXCLUDED.retention_days`);
  }
  return { partnerId: partner.id, orgId: org.id };
}

type SessionOpts = {
  type?: string;
  status?: 'active' | 'closed' | 'expired';
  lastActivity: Date;
  flagged?: boolean;
  clientUserId?: string;
};

async function insertSession(orgId: string, o: SessionOpts): Promise<string> {
  const [row] = await getTestDb().insert(aiSessions).values({
    orgId,
    model: 'claude-test',
    type: o.type ?? 'general',
    status: o.status ?? 'closed',
    clientUserId: o.clientUserId ?? null,
    title: 'Secret title',
    systemPrompt: 'system prompt with context',
    contextSnapshot: { device: 'secret' },
    workbookName: o.type?.endsWith('_client') ? 'Payroll.xlsx' : null,
    sdkSessionId: `sdk-${randomUUID()}`,
    totalCostCents: 12.5,
    turnCount: 4,
    flaggedAt: o.flagged ? daysAgo(1) : null,
    flagReason: o.flagged ? 'reviewer note' : null,
    createdAt: o.lastActivity,
    lastActivityAt: o.lastActivity,
    updatedAt: o.lastActivity,
  }).returning({ id: aiSessions.id });
  const id = row!.id;
  await getTestDb().insert(aiMessages).values({ sessionId: id, role: 'user', content: 'please read the secret', createdAt: o.lastActivity });
  await getTestDb().insert(aiToolExecutions).values({
    sessionId: id, toolName: 'file_operations', toolInput: { path: 'C:/secret' }, toolOutput: { content: 'secret' },
    errorMessage: 'free text with secret', status: 'completed', createdAt: o.lastActivity, completedAt: o.lastActivity,
  });
  await getTestDb().insert(aiActionPlans).values({ sessionId: id, orgId, steps: [{ tool: 'x' }], createdAt: o.lastActivity });
  return id;
}

const sessionRow = async (id: string) => (await getTestDb().select().from(aiSessions).where(eq(aiSessions.id, id)))[0];
const count = async (table: 'ai_messages' | 'ai_action_plans' | 'ai_tool_executions' | 'ai_screenshots', sessionId: string) => {
  const rows = await getTestDb().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE session_id = ${sessionId}`);
  return rows[0]!.n;
};

async function portalUser(orgId: string) {
  const [u] = await getTestDb().insert(portalUsers)
    .values({ orgId, email: `p-${randomUUID()}@example.test`, authMethod: 'password' })
    .returning({ id: portalUsers.id });
  return u!.id;
}

describe('aiTranscriptRetention (real Postgres, breeze_app pool)', () => {
  it('stubs a closed technician session past 365 d: content gone, accounting kept', async () => {
    const { orgId } = await newOrg(1000);
    const old = await insertSession(orgId, { lastActivity: daysAgo(400) });
    const recent = await insertSession(orgId, { lastActivity: daysAgo(300) });
    const before = await sessionRow(old);

    const s = await run(true);

    expect(s.stubbed.technician).toBe(1);
    expect(s.stubsDeleted).toBe(0);
    const after = await sessionRow(old);
    expect(after).toMatchObject({
      title: null, systemPrompt: null, contextSnapshot: null, workbookName: null, flagReason: null, sdkSessionId: null,
      totalCostCents: before!.totalCostCents, turnCount: 4, model: 'claude-test', flaggedBy: null, status: 'closed',
    });
    expect(after!.createdAt).toEqual(before!.createdAt);
    expect(after!.transcriptPurgedAt).toBeInstanceOf(Date);
    expect(await count('ai_messages', old)).toBe(0);
    expect(await count('ai_action_plans', old)).toBe(0);
    const [exec] = await getTestDb().select().from(aiToolExecutions).where(eq(aiToolExecutions.sessionId, old));
    expect(exec).toMatchObject({ toolInput: TOMBSTONE, toolOutput: TOMBSTONE, errorMessage: null, toolName: 'file_operations', status: 'completed' });
    expect(deleter).toHaveBeenCalledWith(before!.sdkSessionId);

    expect((await sessionRow(recent))!.transcriptPurgedAt).toBeNull();
    expect(await count('ai_messages', recent)).toBe(1);
  });

  it('holds a flagged session while flagged, and stubs it on the run after unflagging', async () => {
    const { orgId } = await newOrg(1000);
    const id = await insertSession(orgId, { lastActivity: daysAgo(400), flagged: true });
    await run(true);
    expect((await sessionRow(id))).toMatchObject({ transcriptPurgedAt: null, title: 'Secret title', flagReason: 'reviewer note' });
    expect(await count('ai_messages', id)).toBe(1);

    await getTestDb().update(aiSessions).set({ flaggedAt: null, flaggedBy: null }).where(eq(aiSessions.id, id));
    await run(true);
    expect((await sessionRow(id))!.transcriptPurgedAt).toBeInstanceOf(Date);
  });

  it('stubs an abandoned active session and sets it expired; leaves one with a message an hour ago', async () => {
    const { orgId } = await newOrg(1000);
    const abandoned = await insertSession(orgId, { status: 'active', lastActivity: daysAgo(400) });
    const live = await insertSession(orgId, { status: 'active', lastActivity: daysAgo(400) });
    await getTestDb().insert(aiMessages).values({ sessionId: live, role: 'user', content: 'still here', createdAt: ago(HOUR_MS) });

    await run(true);

    expect(await sessionRow(abandoned)).toMatchObject({ status: 'expired', title: null });
    expect(await sessionRow(live)).toMatchObject({ status: 'active', transcriptPurgedAt: null, title: 'Secret title' });
  });

  it('client sessions follow client_ai_org_policies.retention_days; NULL keeps; client_ai_usage is untouched', async () => {
    const thirty = await newOrg(1000);
    const forever = await newOrg(1000);
    const u30 = await portalUser(thirty.orgId);
    const uForever = await portalUser(forever.orgId);
    await getTestDb().insert(clientAiOrgPolicies).values([
      { orgId: thirty.orgId, retentionDays: 30 },
      { orgId: forever.orgId, retentionDays: null },
    ]);
    await getTestDb().insert(clientAiUsage).values({
      orgId: thirty.orgId, clientUserId: u30, period: 'daily', periodKey: '2026-01-01', sessionCount: 1,
    });
    const stubbed = await insertSession(thirty.orgId, { type: 'excel_client', clientUserId: u30, lastActivity: daysAgo(31) });
    const young = await insertSession(thirty.orgId, { type: 'excel_client', clientUserId: u30, lastActivity: daysAgo(29) });
    const kept = await insertSession(forever.orgId, { type: 'word_client', clientUserId: uForever, lastActivity: daysAgo(900) });
    // A technician session in the same org is on the 365-day window, not the client one.
    const tech = await insertSession(thirty.orgId, { lastActivity: daysAgo(31) });

    const s = await run(true);

    expect(s.stubbed).toEqual({ technician: 0, client: 1 });
    expect(await sessionRow(stubbed)).toMatchObject({ workbookName: null, title: null });
    expect((await sessionRow(stubbed))!.transcriptPurgedAt).toBeInstanceOf(Date);
    expect((await sessionRow(young))!.transcriptPurgedAt).toBeNull();
    expect((await sessionRow(kept))!.transcriptPurgedAt).toBeNull();
    expect((await sessionRow(tech))!.transcriptPurgedAt).toBeNull();
    const usage = await getTestDb().select().from(clientAiUsage).where(eq(clientAiUsage.orgId, thirty.orgId));
    expect(usage).toHaveLength(1);
  });

  it('deletes a stub past the audit window once no screenshot is left; keeps one whose screenshot remains', async () => {
    const { orgId } = await newOrg(500);
    const site = await createSite({ orgId });
    const device = await createDevice({ orgId, siteId: site.id });
    const plain = await insertSession(orgId, { lastActivity: daysAgo(600) });
    const withShot = await insertSession(orgId, { lastActivity: daysAgo(600) });
    await getTestDb().insert(aiScreenshots).values({
      deviceId: device.id, orgId, sessionId: withShot, storageKey: `k/${randomUUID()}.jpg`, width: 1, height: 1, sizeBytes: 1,
      expiresAt: new Date(NOW.getTime() + DAY_MS),
    });
    const between = await insertSession(orgId, { lastActivity: daysAgo(450) });

    // First run: all three are stubbed; the two past 500 d with no screenshot go.
    const first = await run(true);
    expect(first.stubbed.technician).toBe(3);
    expect(first.stubsDeleted).toBe(1);
    expect(await sessionRow(plain)).toBeUndefined();
    expect(await count('ai_tool_executions', plain)).toBe(0);

    const kept = await sessionRow(withShot);
    expect(kept!.transcriptPurgedAt).toBeInstanceOf(Date);
    const [shot] = await getTestDb().select().from(aiScreenshots).where(eq(aiScreenshots.sessionId, withShot));
    expect(shot!.expiresAt.getTime()).toBeLessThanOrEqual(NOW.getTime() + 1000);
    expect((await sessionRow(between))!.transcriptPurgedAt).toBeInstanceOf(Date);

    // helperScreenshotRetention removes file then row; the next run deletes the stub.
    await getTestDb().delete(aiScreenshots).where(eq(aiScreenshots.sessionId, withShot));
    const second = await run(true);
    expect(second.stubsDeleted).toBe(1);
    expect(await sessionRow(withShot)).toBeUndefined();
    expect(await sessionRow(between)).toBeDefined();
  });

  it('decision B: an org with no audit policy row has zero stub-delete eligible rows, is counted, and keeps its stubs', async () => {
    const { orgId } = await newOrg(null);
    const id = await insertSession(orgId, { lastActivity: daysAgo(3000) });

    const report = await run(false);
    expect(report.orgsWithoutAuditPolicy).toBe(1);
    expect(report.eligible).toMatchObject({ technician: 1, stubDelete: 0 });

    const enforce = await run(true);
    expect(enforce.orgsWithoutAuditPolicy).toBe(1);
    expect(enforce.stubbed.technician).toBe(1);
    expect(enforce.stubsDeleted).toBe(0);
    expect((await sessionRow(id))!.transcriptPurgedAt).toBeInstanceOf(Date);

    // Even as an existing stub, it is never counted for deletion.
    const again = await run(false);
    expect(again.eligible.stubDelete).toBe(0);
    expect(await sessionRow(id)).toBeDefined();
  });

  it('a second enforce run is a no-op', async () => {
    const { orgId } = await newOrg(1000);
    const id = await insertSession(orgId, { lastActivity: daysAgo(400) });
    await run(true);
    const stub = await sessionRow(id);
    const second = await run(true);
    expect(second.stubbed).toEqual({ technician: 0, client: 0 });
    expect(second.stubsDeleted).toBe(0);
    expect(await sessionRow(id)).toEqual(stub);
  });

  it('report mode changes nothing, and its counts equal what enforce then does', async () => {
    const { orgId, partnerId } = await newOrg(1000);
    await getTestDb().insert(aiDataPolicies).values({ partnerId, transcriptRetentionDays: 90 });
    const u = await portalUser(orgId);
    await getTestDb().insert(clientAiOrgPolicies).values({ orgId, retentionDays: 30 });
    const t1 = await insertSession(orgId, { lastActivity: daysAgo(100) });
    const t2 = await insertSession(orgId, { status: 'expired', lastActivity: daysAgo(200) });
    await insertSession(orgId, { lastActivity: daysAgo(80) });
    const c1 = await insertSession(orgId, { type: 'outlook_client', clientUserId: u, lastActivity: daysAgo(40) });
    // An existing stub past the audit window (1000 d) with no screenshot.
    const oldStub = await insertSession(orgId, { lastActivity: daysAgo(1200) });
    await getTestDb().update(aiSessions).set({ transcriptPurgedAt: daysAgo(800) }).where(eq(aiSessions.id, oldStub));

    const snapshot = async () => getTestDb().execute(sql`
      SELECT s.id, s.title, s.transcript_purged_at, s.status,
             (SELECT count(*)::int FROM ai_messages m WHERE m.session_id = s.id) AS messages
        FROM ai_sessions s WHERE s.org_id = ${orgId} ORDER BY s.id`);
    const before = [...await snapshot()];
    const report = await run(false);
    expect([...await snapshot()]).toEqual(before);
    expect(report.eligible).toEqual({ technician: 2, client: 1, stubDelete: 1, capped: false });

    const enforce = await run(true);
    expect(enforce.stubbed).toEqual({ technician: report.eligible.technician, client: report.eligible.client });
    expect(enforce.stubsDeleted).toBe(report.eligible.stubDelete);
    for (const id of [t1, t2, c1]) expect((await sessionRow(id))!.transcriptPurgedAt).toBeInstanceOf(Date);
    expect(await sessionRow(oldStub)).toBeUndefined();
  });
});

describe('W4 migration 2027-01-23-190000 (partner backfill)', () => {
  const ROLLBACK = new Error('roll back the migration replay');

  it('backfills 365 on partner rows only, and re-applying keeps a later NULL', async () => {
    const { readFile } = await import('node:fs/promises');
    const migration = await readFile(
      new URL('../../../migrations/2027-01-23-190000-ai-transcript-retention-columns.sql', import.meta.url),
      'utf8',
    );
    const { partnerId, orgId } = await newOrg(365);
    await getTestDb()
      .transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE ai_data_policies DROP CONSTRAINT ai_data_policies_transcript_retention_chk`);
        await tx.execute(sql`ALTER TABLE ai_data_policies DROP COLUMN transcript_retention_days`);
        await tx.execute(sql`INSERT INTO ai_data_policies (partner_id, tool_output_retention_days) VALUES (${partnerId}, 30)`);
        await tx.execute(sql`INSERT INTO ai_data_policies (org_id, tool_output_retention_days) VALUES (${orgId}, 7)`);

        await tx.execute(sql.raw(migration));

        const read = async () => [...await tx.execute<{ owner: string; days: number | null }>(sql`
          SELECT CASE WHEN org_id IS NULL THEN 'partner' ELSE 'org' END AS owner, transcript_retention_days AS days
            FROM ai_data_policies WHERE partner_id = ${partnerId} OR org_id = ${orgId} ORDER BY 1`)];
        expect(await read()).toEqual([{ owner: 'org', days: null }, { owner: 'partner', days: 365 }]);

        // A partner who later chooses "keep forever" is not overwritten on re-apply.
        await tx.execute(sql`UPDATE ai_data_policies SET transcript_retention_days = NULL WHERE partner_id = ${partnerId}`);
        await tx.execute(sql.raw(migration));
        expect(await read()).toEqual([{ owner: 'org', days: null }, { owner: 'partner', days: null }]);

        const fks = [...await tx.execute<{ conname: string; confdeltype: string }>(sql`
          SELECT conname, confdeltype::text AS confdeltype FROM pg_constraint
           WHERE contype = 'f' AND confrelid = 'public.ai_sessions'::regclass
             AND conrelid IN ('public.ai_action_plans'::regclass, 'public.ai_screenshots'::regclass)
           ORDER BY conname`)];
        expect(fks).toEqual([
          { conname: 'ai_action_plans_session_id_ai_sessions_id_fk', confdeltype: 'c' },
          { conname: 'ai_screenshots_session_id_ai_sessions_id_fk', confdeltype: 'c' },
        ]);
        throw ROLLBACK;
      })
      .catch((err: unknown) => {
        if (err !== ROLLBACK) throw err;
      });
  });
});
