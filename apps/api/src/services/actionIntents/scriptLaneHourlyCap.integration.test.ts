/**
 * Real-Postgres proof that the unattended lane's hourly cap is a RESERVATION
 * taken under `pg_advisory_xact_lock('ai-script-lane:<org>')`, not a
 * count-then-write (#5612 W04, spec §4.6 invariant 12, §6 "Concurrent
 * unattended approvals exceed the cap").
 *
 * A mocked test cannot do this: the whole point of the advisory lock is
 * behaviour across CONCURRENT transactions, and a Drizzle mock has one. This
 * suite drives `createActionIntent` for N distinct, lane-eligible proposals
 * in one `Promise.all` and asserts exactly CAP of them are approved at
 * creation while the rest fall to the human path with `hourly_cap` as their
 * breadcrumb.
 *
 * Co-located with the service it exercises, so it is named explicitly in BOTH
 * `vitest.integration.config.ts` (include) and `vitest.config.ts` (exclude) —
 * the same dual hand-list `createIntentAtomicity.integration.test.ts` uses.
 *
 * The lock was proved LOAD-BEARING at authoring time: with the
 * `await lockScriptLane(...)` line in scriptReviewerAutonomy.ts commented out,
 * the first test admits more than CAP (recorded in the PR body).
 */
import '../../__tests__/integration/setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  aiScriptPolicies,
  approvalRequests,
  devices,
  scriptProposalReviews,
  scriptProposals,
} from '../../db/schema';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { createActionIntent } from './intentService';
import { PERMISSIONS } from '../permissions';
import { getTestDb } from '../../__tests__/integration/setup';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from '../../__tests__/integration/db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const CAP = 3;
const N = 8;

function requesterAuth(user: { id: string; email: string }, orgId: string, partnerId: string, roleId: string): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: 'Requester', isPlatformAdmin: false },
    token: { sub: user.id, email: user.email, roleId, orgId, partnerId, scope: 'organization', type: 'access', mfa: true },
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition,
    canAccessOrg,
  };
}

interface Scenario {
  partnerId: string;
  orgId: string;
  deviceId: string;
  requester: { id: string; email: string };
  roleId: string;
  auth: AuthContext;
}

async function seedScenario(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  // scripts:execute is what `checkToolPermission('run_script', …)` — invariant
  // 13's chat branch — demands; approvals:decide makes the requester a valid
  // supervised self-approver so the human-path fan-out has someone to fan to.
  await grantRolePermissions(role.id, [PERMISSIONS.SCRIPTS_EXECUTE, PERMISSIONS.APPROVALS_DECIDE]);
  const requester = await createUser({ partnerId: partner.id, orgId: org.id, email: `lane-${randomUUID()}@hourlycap.test` });
  await assignUserToOrganization(requester.id, org.id, role.id);

  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `agent-lane-${randomUUID()}`,
      hostname: 'LANE-WIN-1',
      osType: 'windows',
      osVersion: '11',
      architecture: 'x64',
      agentVersion: '1.0.0',
      status: 'online',
    })
    .returning({ id: devices.id });

  // Partner ceiling (allowed, cap CAP) + org grant (enabled). temp_files needs
  // no checkpoint, so the only thing that can refuse these is the cap.
  await getTestDb().insert(aiScriptPolicies).values({
    partnerId: partner.id, orgId: null, unattendedAllowed: true, maxUnattendedPerHour: CAP,
    unattendedAllowedClasses: ['temp_files', 'services'],
  });
  await getTestDb().insert(aiScriptPolicies).values({
    orgId: org.id, partnerId: null, unattendedEnabled: true, maxUnattendedPerHour: CAP,
    unattendedAllowedClasses: ['temp_files', 'services'],
  });

  return {
    partnerId: partner.id,
    orgId: org.id,
    deviceId: device!.id,
    requester: { id: requester.id, email: requester.email },
    roleId: role.id,
    auth: requesterAuth({ id: requester.id, email: requester.email }, org.id, partner.id, role.id),
  };
}

/** N distinct reviewed, lane-eligible proposals (distinct content ⇒ distinct digests ⇒ distinct idempotency keys). */
async function seedReviewedProposals(s: Scenario, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const content = `Remove-Item "$env:TEMP\\lane-${randomUUID()}.tmp" -ErrorAction SilentlyContinue`;
    const [p] = await getTestDb()
      .insert(scriptProposals)
      .values({
        orgId: s.orgId,
        authorKind: 'chat_session',
        language: 'powershell',
        content,
        contentDigest: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        timeoutSeconds: 60,
        goal: 'clean a temp file',
        expectedEffect: 'one temp file removed',
        verification: { kind: 'exit_code', equals: 0 },
        targetDeviceIds: [s.deviceId],
        scannerVersion: '2026-09-11.1',
        basicHits: [],
        strictHits: [],
        touchClasses: ['temp_files'],
        status: 'reviewed',
        riskTier: 'low',
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning({ id: scriptProposals.id });
    await getTestDb().insert(scriptProposalReviews).values({
      orgId: s.orgId,
      proposalId: p!.id,
      reviewerKind: 'model',
      model: 'test-reviewer',
      reviewerPromptVersion: 'test',
      status: 'completed',
      riskTier: 'low',
      goalMatch: 'yes',
      reversible: true,
      verificationAdequate: true,
      recommendedAction: 'approve',
    });
    ids.push(p!.id);
  }
  return ids;
}

const runFor = (s: Scenario, proposalId: string) =>
  createActionIntent(s.auth, {
    toolName: 'run_script',
    input: { proposalId, deviceIds: [s.deviceId] },
    source: 'chat',
    orgId: s.orgId,
  });

let seeded: Scenario | null = null;

beforeEach(async () => {
  seeded = await seedScenario();
});

// No afterEach: setup.ts's per-test TRUNCATE ... CASCADE on the core tenant
// tables (organizations, partners, users) reaps everything this file seeds —
// including the append-only script_proposal_reviews rows breeze_app cannot
// delete itself.

async function laneIntentCount(orgId: string): Promise<number> {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ n: sql<number>`count(*)::int` }).from(actionIntents)
      .where(and(eq(actionIntents.orgId, orgId), eq(actionIntents.decidedVia, 'script_reviewer'))));
  return row?.n ?? 0;
}

describe('unattended lane hourly cap under concurrency (#5612 W04)', () => {
  runDb('exactly CAP of N concurrent lane requests are approved; the rest fall to the human path with hourly_cap', async () => {
    const s = seeded!;
    const proposals = await seedReviewedProposals(s, N);

    const results = await Promise.all(proposals.map((id) => runFor(s, id).catch((e) => ({ error: String(e) }))));

    const errors = results.filter((r) => 'error' in r);
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
    const approved = results.filter((r) => 'status' in r && r.status === 'approved');
    const pending = results.filter((r) => 'status' in r && r.status === 'pending_approval');
    expect(approved).toHaveLength(CAP);
    expect(pending).toHaveLength(N - CAP);

    // The database agrees — no over-admission survived the commit.
    expect(await laneIntentCount(s.orgId)).toBe(CAP);

    // Every refused request names the cap, not a generic denial.
    const refused = await withSystemDbAccessContext(() =>
      db.select({ result: actionIntents.result }).from(actionIntents)
        .where(and(eq(actionIntents.orgId, s.orgId), eq(actionIntents.status, 'pending_approval'))));
    expect(refused).toHaveLength(N - CAP);
    for (const r of refused) {
      expect((r.result as { scriptLaneRefusal?: string } | null)?.scriptLaneRefusal).toBe('hourly_cap');
    }

    // The approved rows carry the decision record and no approval rows.
    const approvedRows = await withSystemDbAccessContext(() =>
      db.select({ decidedVia: actionIntents.decidedVia, decidedByUserId: actionIntents.decidedByUserId, evidence: actionIntents.scriptReviewerEvidence, releaseBy: actionIntents.releaseBy })
        .from(actionIntents).where(and(eq(actionIntents.orgId, s.orgId), eq(actionIntents.status, 'approved'))));
    for (const row of approvedRows) {
      expect(row.decidedVia).toBe('script_reviewer');
      expect(row.decidedByUserId).toBeNull();
      expect(row.releaseBy).toBeInstanceOf(Date);
      expect(row.evidence).toMatchObject({ touchClasses: ['temp_files'], checkpointRequired: false, policySnapshot: { perHour: CAP } });
    }
    // No approval_requests row for any lane-approved intent; every refused
    // one fanned out to the requester (supervised self-approve) as usual.
    const approvalRows = await withSystemDbAccessContext(() =>
      db.select({ intentId: approvalRequests.intentId }).from(approvalRequests)
        .innerJoin(actionIntents, eq(approvalRequests.intentId, actionIntents.id))
        .where(eq(actionIntents.orgId, s.orgId)));
    const approvedIds = new Set(approved.map((r) => (r as { id: string }).id));
    expect(approvalRows.filter((r) => approvedIds.has(r.intentId!))).toHaveLength(0);
    expect(new Set(approvalRows.map((r) => r.intentId)).size).toBe(N - CAP);

    // script_proposals.decided_by stays NULL for lane decisions.
    const decided = await withSystemDbAccessContext(() =>
      db.select({ decidedBy: scriptProposals.decidedBy, intentId: scriptProposals.intentId }).from(scriptProposals)
        .where(inArray(scriptProposals.id, proposals)));
    expect(decided.every((p) => p.decidedBy === null && p.intentId !== null)).toBe(true);
  });

  runDb('the cap counts PENDING lane intents too — an undispatched admission still holds a slot', async () => {
    const s = seeded!;
    const first = await seedReviewedProposals(s, CAP);
    for (const id of first) expect((await runFor(s, id)).status).toBe('approved');
    const [extra] = await seedReviewedProposals(s, 1);
    const res = await runFor(s, extra!);
    expect(res.status).toBe('pending_approval');
    expect(res.result).toEqual({ scriptLaneRefusal: 'hourly_cap' });
  });

  runDb('an intent created 61 minutes ago no longer holds a slot', async () => {
    const s = seeded!;
    const first = await seedReviewedProposals(s, CAP);
    for (const id of first) expect((await runFor(s, id)).status).toBe('approved');
    // created_at is in the immutability trigger's deny-list (by design); the
    // superuser client lifts the trigger for exactly this fixture write.
    const sdb = getTestDb();
    await sdb.execute(sql.raw('ALTER TABLE action_intents DISABLE TRIGGER action_intents_immutable_trg'));
    try {
      await sdb.execute(sql`update action_intents set created_at = now() - interval '61 minutes' where org_id = ${s.orgId} and decided_via = 'script_reviewer'`);
    } finally {
      await sdb.execute(sql.raw('ALTER TABLE action_intents ENABLE TRIGGER action_intents_immutable_trg'));
    }
    const [p] = await seedReviewedProposals(s, 1);
    expect((await runFor(s, p!)).status).toBe('approved');
  });

  runDb('a proposal consumed by one intent cannot be consumed by a second (one live run per proposal)', async () => {
    const s = seeded!;
    const [p] = await seedReviewedProposals(s, 1);
    const [a, b] = await Promise.allSettled([runFor(s, p!), runFor(s, p!)]);
    const outcomes = [a, b];
    const fulfilled = outcomes.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof runFor>>> => r.status === 'fulfilled');
    // Both calls carry the same canonical arguments → same idempotency key,
    // so the second either replays the first (same id) or loses the proposal
    // CAS. Either way exactly one live intent exists for the proposal.
    const ids = new Set(fulfilled.map((r) => r.value.id));
    expect(ids.size).toBe(1);
    expect(await laneIntentCount(s.orgId)).toBe(1);
  });
});
