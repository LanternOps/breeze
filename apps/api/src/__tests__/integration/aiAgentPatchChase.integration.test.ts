/**
 * AI patch agent W03 (#5749), Task 6 — chase, retry, escalate against live
 * PostgreSQL.
 *
 * Sibling of `aiAgentPatchLane` (W01) and `aiAgentPatchInstall` (W02). What
 * only a real database can show:
 *
 *  1. **The failedWork read never crosses an org boundary.** `patch_job_results`
 *     has no `org_id`; the loader runs under the SYSTEM context (RLS bypassed)
 *     and reaches the org through `patch_jobs.org_id` AND `devices.org_id`.
 *     Two forged cross-tenant shapes — a sibling org's job pointing at OUR
 *     device, and OUR job pointing at a sibling org's device — must both be
 *     invisible. A `device_id`-only join would show the first; a `job_id`-only
 *     join would show the second.
 *  2. **Grouping and the attempt bound are real.** One failed attempt yields a
 *     chase card through the identical W02 minting path; a second failed
 *     attempt exhausts the bound and the chase is refused in favour of an
 *     escalation.
 *  3. **`queued` is delivery, not failure**; a whole-device summary row
 *     (`patch_id IS NULL`) is not a patch failure; a reboot-required
 *     SUCCESSFUL install (#4228) is not a failure row.
 *  4. **A chase card is suppressed on the next occurrence** like any install.
 *  5. **The query plan has an index to use** — `EXPLAIN` reaches
 *     `patch_job_results` through `idx_patch_job_results_status_created`
 *     (the wave's one migration), never a bare sequential scan.
 */
import './setup';

import { vi } from 'vitest';
vi.hoisted(() => {
  process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
});

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PATCH_CHASE_MAX_ATTEMPTS, type PatchPlanOutcome, type PatchPlanOutcomeRefs } from '@breeze/shared';
import { getTestDb } from './setup';
import {
  assignUserToOrganization, createOrganization, createPartner, createRole, createSite, createUser, grantRolePermissions,
} from './db-utils';
import { db, withSystemDbAccessContext } from '../../db';
import {
  actionIntents, aiAgents, aiAgentRuns, configPolicyAssignments, configPolicyFeatureLinks, configPolicyPatchSettings,
  configurationPolicies, devicePatches, devices, patches, patchJobResults, patchJobs, patchPolicies,
} from '../../db/schema';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import { loadPatchEvidence, patchEvidenceRefs, type PatchEvidence } from '../../services/aiAgents/patchEvidence';
import { persistPatchPlan, type PatchPersistRunInput } from '../../services/aiAgents/patchPlan';
import { patchEpisodeIdempotencyKey } from '../../services/aiAgents/patchEpisode';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function insertDevice(orgId: string, siteId: string, over: { isEphemeral?: boolean } = {}) {
  const unique = randomUUID().slice(0, 8);
  const [device] = await withSystemDbAccessContext(() => db
    .insert(devices)
    .values({
      orgId, siteId, agentId: `w03-agent-${unique}`, hostname: `w03-host-${unique}`, osType: 'windows', osVersion: '10',
      architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online', lastSeenAt: new Date(),
      isEphemeral: over.isEphemeral ?? false,
    })
    .returning());
  return device!;
}

async function insertPatch() {
  const unique = randomUUID().slice(0, 8);
  const [patch] = await withSystemDbAccessContext(() => db
    .insert(patches)
    .values({
      source: 'microsoft', externalId: `KB-${unique}`, vendor: 'Microsoft', title: `Security update ${unique}`,
      severity: 'critical', requiresReboot: true, releaseDate: '2026-01-01',
    })
    .returning());
  return patch!;
}

async function markOutstanding(orgId: string, deviceId: string, patchId: string) {
  await withSystemDbAccessContext(() => db.insert(devicePatches).values({ deviceId, orgId, patchId, status: 'pending' }));
}

async function insertJob(orgId: string) {
  const [job] = await withSystemDbAccessContext(() => db
    .insert(patchJobs)
    .values({ orgId, name: `W03 job ${randomUUID().slice(0, 8)}`, status: 'failed', devicesTotal: 1, devicesFailed: 1 })
    .returning({ id: patchJobs.id }));
  return job!.id;
}

type ResultStatus = 'pending' | 'running' | 'queued' | 'completed' | 'failed' | 'skipped';

async function insertResult(
  jobId: string, deviceId: string, patchId: string | null,
  over: { status?: ResultStatus; errorMessage?: string | null; exitCode?: number | null; rebootRequired?: boolean; daysAgo?: number } = {},
) {
  const createdAt = new Date(Date.now() - (over.daysAgo ?? 0) * 24 * 60 * 60 * 1000);
  const [row] = await withSystemDbAccessContext(() => db
    .insert(patchJobResults)
    .values({
      jobId, deviceId, patchId,
      status: over.status ?? 'failed',
      errorMessage: over.errorMessage === undefined ? 'Server-side timeout: no response from agent' : over.errorMessage,
      exitCode: over.exitCode === undefined ? 1 : over.exitCode,
      rebootRequired: over.rebootRequired ?? false,
      createdAt, completedAt: createdAt,
    })
    .returning({ id: patchJobResults.id }));
  return row!.id;
}

async function seedRingForOrg(partnerId: string, orgId: string) {
  return withSystemDbAccessContext(async () => {
    const [ring] = await db
      .insert(patchPolicies)
      .values({
        partnerId, kind: 'ring', name: `W03 ring ${randomUUID().slice(0, 8)}`, deferralDays: 0,
        autoApprove: { enabled: true, severities: ['critical', 'important'] },
        categoryRules: [],
      })
      .returning({ id: patchPolicies.id });
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId, partnerId: null, name: 'W03 patch policy', status: 'active' })
      .returning({ id: configurationPolicies.id });
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'patch', featurePolicyId: ring!.id, inlineSettings: {} })
      .returning({ id: configPolicyFeatureLinks.id });
    await db.insert(configPolicyPatchSettings).values({ featureLinkId: link!.id, sources: ['os'] });
    await db.insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'organization', targetId: orgId, priority: 0 });
    return ring!.id;
  });
}

function effectivePolicyFields() {
  return {
    enabled: true,
    mode: 'shadow' as const,
    model: null,
    toolAllowlist: ['manage_patches:install'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: {},
    triggers: {},
    recipients: { userIds: [], roleIds: [] },
    instructions: null,
    cooldownSeconds: 900,
  };
}

interface Fixture {
  partnerId: string; orgId: string; siteId: string; deviceId: string; patchId: string; jobId: string; agentId: string;
}

/** Partner, org, device with ONE outstanding critical patch the ring
 *  auto-approves, a failed patch job for the org, a patch agent and an
 *  approver who holds `patches:execute`. No failure rows yet. */
async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await insertDevice(org.id, site.id);
  const patch = await insertPatch();
  await markOutstanding(org.id, device.id, patch.id);
  await seedRingForOrg(partner.id, org.id);
  const jobId = await insertJob(org.id);

  const creator = await createUser({ partnerId: partner.id, orgId: org.id, email: `creator-${randomUUID()}@w03.test` });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  // manage_patches now maps onto the real routes' devices:* grants
  // (2026-09-17 ROLE audit §2.6 — `patches` was never a catalog resource).
  await grantRolePermissions(role.id, [{ resource: 'devices', action: 'execute' }]);
  const approver = await createUser({ partnerId: partner.id, orgId: org.id, email: `approver-${randomUUID()}@w03.test` });
  await assignUserToOrganization(approver.id, org.id, role.id);

  const [agent] = await withSystemDbAccessContext(() => db
    .insert(aiAgents)
    .values({ partnerId: partner.id, orgId: null, kind: 'patch', name: 'Patch Agent', ...effectivePolicyFields(), createdBy: creator.id })
    .returning());
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, deviceId: device.id, patchId: patch.id, jobId, agentId: agent!.id };
}

/** OD-7 A: no run in this program opens a ticket. */
async function ticketCount(orgId: string): Promise<number> {
  const rows = (await getTestDb().execute(sql`SELECT COUNT(*) AS c FROM tickets WHERE org_id = ${orgId}::uuid`)) as unknown as Array<{ c: unknown }>;
  return Number(rows[0]?.c ?? 0);
}

async function insertRunRow(f: Fixture): Promise<string> {
  const snapshot = {
    schemaVersion: 1, agentId: f.agentId, kind: 'patch', effective: effectivePolicyFields(), resolvedAt: new Date().toISOString(),
  };
  const [row] = await withSystemDbAccessContext(() => db
    .insert(aiAgentRuns)
    .values({
      agentId: f.agentId, orgId: f.orgId, deviceId: null, profile: 'patch', scheduleId: null, triggerKind: 'manual',
      triggerRef: { kind: 'patch' }, dedupeKey: `w03-${randomUUID()}`, modeAtStart: 'shadow',
      policySnapshot: snapshot as never, status: 'running',
    })
    .returning({ id: aiAgentRuns.id }));
  return row!.id;
}

async function evidenceFor(f: Fixture): Promise<PatchEvidence> {
  return withSystemDbAccessContext(() => loadPatchEvidence(f.orgId, f.partnerId));
}

/** The failedWork group for the fixture's (device, patch) — what a chase or escalation cites. */
function groupFor(evidence: PatchEvidence, f: Fixture) {
  const row = evidence.sections.failedWork.rows.find((r) => r.deviceId === f.deviceId && r.fields.patchId === f.patchId);
  if (!row) throw new Error('fixture failedWork row missing');
  return {
    failureClass: row.fields.failureClass as string,
    attemptCount: row.fields.attemptCount as number,
    jobResultIds: row.jobResultIds ?? [],
  };
}

function chasePlan(f: Fixture, g: ReturnType<typeof groupFor>, cls: 'chase' | 'escalation' = 'chase'): PatchPlanOutcome {
  return {
    schemaVersion: 1,
    summary: 'Plan',
    posture: { compliancePct: 50, devicesAtRisk: 1, oldestOutstandingDays: 10 },
    items: [{
      class: cls, severity: 'high', deviceId: f.deviceId, patchIds: [f.patchId], jobResultIds: g.jobResultIds,
      failureClass: g.failureClass as never, attemptCount: g.attemptCount,
      title: cls === 'chase' ? 'Retry 1 critical update' : 'Escalate a failing update', detail: 'd', evidenceRef: 'failedWork:0',
    }],
    dispositions: [],
    evidenceTruncated: false,
    generatedAt: new Date().toISOString(),
  };
}

async function persist(f: Fixture, plan: PatchPlanOutcome, refs: PatchPlanOutcomeRefs) {
  const runId = await insertRunRow(f);
  const run: PatchPersistRunInput = {
    id: runId, orgId: f.orgId, agentId: f.agentId, scheduleId: null, toolAllowlist: ['manage_patches:install'], maxActionsPerRun: 5,
  };
  const auth = buildAgentAuthContext(
    { id: f.agentId, orgId: null, partnerId: f.partnerId, name: 'Patch Agent', kind: 'patch' },
    { id: runId, orgId: f.orgId, deviceId: null, deviceSiteId: null },
    { id: f.orgId, partnerId: f.partnerId },
  );
  return persistPatchPlan(run, plan, refs, auth);
}

// ---------------------------------------------------------------------------
// 1: the failedWork read never crosses an org boundary
// ---------------------------------------------------------------------------

describe('failedWork evidence is org-pinned on both join legs', () => {
  runDb('groups real patch_job_results failures and never names a sibling org\'s rows', async () => {
    const f = await seedFixture();
    // Sibling org under the SAME partner, with its own failure on the SAME global patch row.
    const orgB = await createOrganization({ partnerId: f.partnerId });
    const siteB = await createSite({ orgId: orgB.id });
    const deviceB = await insertDevice(orgB.id, siteB.id);
    await markOutstanding(orgB.id, deviceB.id, f.patchId);
    const jobB = await insertJob(orgB.id);

    const mine = await insertResult(f.jobId, f.deviceId, f.patchId);
    const theirs = await insertResult(jobB, deviceB.id, f.patchId);
    // Forged cross-tenant shapes (RLS is bypassed under the system context;
    // these rows exist and only the predicates keep them out):
    //  - THEIR job naming OUR device → a job_id-only join would show it under org B;
    //    a device_id-only join would show it under org A.
    const forgedOnOurDevice = await insertResult(jobB, f.deviceId, f.patchId);
    //  - OUR job naming THEIR device → a job_id-only join would show it under org A.
    const forgedOnTheirDevice = await insertResult(f.jobId, deviceB.id, f.patchId);

    const evidence = await evidenceFor(f);
    const rows = evidence.sections.failedWork.rows;
    expect(evidence.sections.failedWork.available).toBe(true);
    expect(rows.every((r) => r.deviceId === f.deviceId)).toBe(true);
    const cited = rows.flatMap((r) => r.jobResultIds ?? []);
    expect(cited).toEqual([mine]);
    for (const forged of [theirs, forgedOnOurDevice, forgedOnTheirDevice]) expect(cited).not.toContain(forged);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields).toMatchObject({ patchId: f.patchId, failureClass: 'transient', attemptCount: 1 });

    // And from org B's side: only its own consistent row.
    const evidenceB = await withSystemDbAccessContext(() => loadPatchEvidence(orgB.id, f.partnerId));
    const citedB = evidenceB.sections.failedWork.rows.flatMap((r) => r.jobResultIds ?? []);
    expect(citedB).toEqual([theirs]);
  });

  runDb('a forged sibling-org result can never be cited by a chase — the refs come from the org-pinned bundle', async () => {
    const f = await seedFixture();
    const orgB = await createOrganization({ partnerId: f.partnerId });
    const jobB = await insertJob(orgB.id);
    const forged = await insertResult(jobB, f.deviceId, f.patchId);
    await insertResult(f.jobId, f.deviceId, f.patchId);

    const evidence = await evidenceFor(f);
    const refs = patchEvidenceRefs(evidence);
    expect(refs.jobResultIds.has(forged)).toBe(false);
    const g = groupFor(evidence, f);
    const plan = chasePlan(f, { ...g, jobResultIds: [forged] });
    const { dispositions } = await persist(f, plan, refs);
    expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'job_result_not_in_evidence' });
  });

  runDb('excludes an ephemeral (Quick Support) device even inside the org', async () => {
    const f = await seedFixture();
    const ephemeral = await insertDevice(f.orgId, f.siteId, { isEphemeral: true });
    await insertResult(f.jobId, ephemeral.id, f.patchId);
    await insertResult(f.jobId, f.deviceId, f.patchId);
    const evidence = await evidenceFor(f);
    expect(evidence.sections.failedWork.rows.map((r) => r.deviceId)).toEqual([f.deviceId]);
  });
});

// ---------------------------------------------------------------------------
// 2: grouping, the attempt bound, and the W02 path reuse
// ---------------------------------------------------------------------------

describe('chase and escalation over real attempt history', () => {
  runDb('one failed attempt yields a chase card through the W02 minting path; two exhaust the bound and escalate', async () => {
    const f = await seedFixture();
    await insertResult(f.jobId, f.deviceId, f.patchId, { daysAgo: 2 });

    const e1 = await evidenceFor(f);
    const g1 = groupFor(e1, f);
    expect(g1).toMatchObject({ failureClass: 'transient', attemptCount: 1 });

    const first = await persist(f, chasePlan(f, g1), patchEvidenceRefs(e1));
    expect(first.dispositions[0]).toMatchObject({ class: 'chase', disposition: 'intent_created', mintedPatchIds: [f.patchId] });
    const [intent] = await withSystemDbAccessContext(() => db
      .select().from(actionIntents).where(eq(actionIntents.id, first.intentIds[0]!)).limit(1));
    expect(intent).toMatchObject({
      actionName: 'manage_patches', status: 'pending_approval', scopeKind: 'device', policyDecisionState: 'human_required',
      idempotencyKey: patchEpisodeIdempotencyKey(f.orgId, f.deviceId, f.patchId),
    });
    expect(intent!.reason).toMatch(new RegExp(`attempt 2 of ${PATCH_CHASE_MAX_ATTEMPTS}`));
    expect(intent!.reason).toContain('transient');

    // The retry ran and failed again (a second reaper timeout, different string).
    await insertResult(f.jobId, f.deviceId, f.patchId, {
      errorMessage: 'Server-side timeout: no response from agent after 30 minutes', daysAgo: 1,
    });
    // Retire the live card so suppression does not mask the attempt gate.
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE action_intents SET status = 'expired', decided_at = now() - interval '20 days' WHERE id = ${intent!.id}::uuid
    `));

    const e2 = await evidenceFor(f);
    const g2 = groupFor(e2, f);
    // Two different reaper strings, ONE transient group with two attempts.
    expect(e2.sections.failedWork.rows.filter((r) => r.deviceId === f.deviceId)).toHaveLength(1);
    expect(g2).toMatchObject({ failureClass: 'transient', attemptCount: 2 });
    expect(g2.jobResultIds).toHaveLength(2);

    const second = await persist(f, chasePlan(f, g2), patchEvidenceRefs(e2));
    expect(second.dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'chase_attempts_exhausted' });
    expect(second.intentIds).toEqual([]);

    // OD-7 A: an escalation opens NO ticket. Counted against the live table
    // across the persist, so a future ticket write in persistPatchPlan fails
    // here — a source grep over runFinishedNotify.ts would not.
    const ticketsBefore = await ticketCount(f.orgId);
    const escalated = await persist(f, chasePlan(f, g2, 'escalation'), patchEvidenceRefs(e2));
    expect(escalated.dispositions[0]).toMatchObject({ class: 'escalation', disposition: 'recorded' });
    expect(escalated.intentIds).toEqual([]);
    expect(await ticketCount(f.orgId)).toBe(ticketsBefore);
  });

  runDb('a non-retryable class is refused and a quoted class the evidence did not compute is refused', async () => {
    const f = await seedFixture();
    await insertResult(f.jobId, f.deviceId, f.patchId, { errorMessage: '0x8024200B installation failed: not applicable' });
    const e = await evidenceFor(f);
    const g = groupFor(e, f);
    expect(g.failureClass).toBe('permanent');
    const refused = await persist(f, chasePlan(f, g), patchEvidenceRefs(e));
    expect(refused.dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'class_not_retryable' });
    const lied = await persist(f, chasePlan(f, { ...g, failureClass: 'transient' }), patchEvidenceRefs(e));
    expect(lied.dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'failure_class_mismatch' });
  });

  runDb('a chase card is suppressed on the next occurrence like any other install', async () => {
    const f = await seedFixture();
    await insertResult(f.jobId, f.deviceId, f.patchId);
    const e = await evidenceFor(f);
    const g = groupFor(e, f);
    const first = await persist(f, chasePlan(f, g), patchEvidenceRefs(e));
    expect(first.dispositions[0]!.disposition).toBe('intent_created');
    const second = await persist(f, chasePlan(f, g), patchEvidenceRefs(e));
    expect(second.dispositions[0]).toMatchObject({ disposition: 'suppressed', reason: 'live_intent_exists' });
    const live = await getTestDb().execute(sql`
      SELECT COUNT(*) AS c FROM action_intents
      WHERE org_id = ${f.orgId}::uuid AND idempotency_key = ${patchEpisodeIdempotencyKey(f.orgId, f.deviceId, f.patchId)}
        AND status IN ('pending_approval', 'approved', 'executing')
    `) as unknown as Array<{ c: unknown }>;
    expect(Number(live[0]!.c)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3: what is NOT a failure
// ---------------------------------------------------------------------------

describe('rows that are not failed work', () => {
  runDb('a queued row for an offline device produces neither a failure row nor a chase — it is a coverage count', async () => {
    const f = await seedFixture();
    await insertResult(f.jobId, f.deviceId, f.patchId, { status: 'queued', errorMessage: null, exitCode: null });
    const e = await evidenceFor(f);
    expect(e.sections.failedWork.rows).toEqual([]);
    expect(e.queuedOffline).toBe(1);
    expect(patchEvidenceRefs(e).jobResultIds.size).toBe(0);
  });

  runDb('a whole-device summary row (patch_id IS NULL) is not a patch failure', async () => {
    const f = await seedFixture();
    await insertResult(f.jobId, f.deviceId, null, { errorMessage: 'device skipped: no approved set' });
    const e = await evidenceFor(f);
    expect(e.sections.failedWork.rows).toEqual([]);
  });

  runDb('a reboot-required SUCCESSFUL install (#4228) produces no failure row', async () => {
    const f = await seedFixture();
    await insertResult(f.jobId, f.deviceId, f.patchId, { status: 'completed', errorMessage: null, exitCode: 0, rebootRequired: true });
    const e = await evidenceFor(f);
    expect(e.sections.failedWork.rows).toEqual([]);
    expect(e.queuedOffline).toBe(0);
  });

  runDb('a failure older than the window is not counted as attempt history', async () => {
    const f = await seedFixture();
    await insertResult(f.jobId, f.deviceId, f.patchId, { daysAgo: 45 });
    await insertResult(f.jobId, f.deviceId, f.patchId, { daysAgo: 1 });
    const e = await evidenceFor(f);
    expect(groupFor(e, f).attemptCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5: the query plan
// ---------------------------------------------------------------------------

describe('the failedWork query plan', () => {
  runDb('reaches patch_job_results through idx_patch_job_results_status_created, never a bare sequential scan', async () => {
    const f = await seedFixture();
    await insertResult(f.jobId, f.deviceId, f.patchId);
    // A test table is tiny, so the planner would legitimately pick a seq scan
    // on cost alone; disabling it for this transaction asks the narrower
    // question that matters here — does an index exist whose shape serves
    // this predicate? Without the W03 migration the answer is a seq scan
    // regardless (recorded in the PR: 6,000 rows, 5,761 removed by filter).
    const plan = await withSystemDbAccessContext(() => db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const rows = await tx.execute<{ 'QUERY PLAN': string }>(sql`
        EXPLAIN (FORMAT TEXT)
        SELECT r.id, r.device_id, d.hostname, r.patch_id, p.title, r.status, r.error_message, r.exit_code,
               r.created_at, r.completed_at, COUNT(*) OVER () AS total_count
        FROM patch_job_results r
        JOIN patch_jobs j ON j.id = r.job_id AND j.org_id = ${f.orgId}::uuid
        JOIN devices d ON d.id = r.device_id AND d.org_id = ${f.orgId}::uuid
          AND d.is_ephemeral = false AND d.status <> 'decommissioned'
        JOIN patches p ON p.id = r.patch_id
        WHERE r.status = 'failed' AND r.patch_id IS NOT NULL
          AND r.created_at >= ${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamp
        ORDER BY r.created_at DESC, r.id ASC
        LIMIT 2000
      `);
      return [...rows].map((r) => r['QUERY PLAN']).join('\n');
    }));
    expect(plan).toContain('idx_patch_job_results_status_created');
    expect(plan).not.toMatch(/Seq Scan on patch_job_results/);
    // The cutoff is an INDEX condition, not a post-scan filter (a leaky
    // `now() - interval` would demote it under RLS).
    expect(plan).toMatch(/Index Cond: \(created_at >= /);
  });
});
