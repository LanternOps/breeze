/**
 * AI patch agent W02 (#5748), Task 6 — actionable installs against live
 * PostgreSQL, as the unprivileged `breeze_app` role with forced RLS on.
 *
 * Sibling of `aiAgentPatchLane.integration.test.ts` (W01). What only a real
 * database can show:
 *
 *  1. **One live card per problem.** The same (device, patch) on two
 *     consecutive nightly occurrences produces exactly ONE live
 *     `action_intents` row — the suppression read (`findIntentsByIdempotencyKey`
 *     + `shouldSuppressPatchEpisode`) does it, and the partial unique index
 *     `action_intents_org_idem_uniq` (live statuses only) is the backstop.
 *  2. **A rejection suppresses for 14 days; an expiry does not.** Real
 *     status/decided_at rows, not a mocked history.
 *  3. **Release revalidation drops a drifted card.** The stored
 *     `effect_digest` pinned at creation no longer matches what
 *     `computeEffectDigestForRelease` recomputes once the patch was deferred,
 *     superseded, or the device moved org — which is exactly the comparison
 *     `jobs/intentReleaseWorker.ts` makes before failing the intent with
 *     `content_changed`.
 *  4. **The minted card is device-scoped and human-decided.** `scope_kind =
 *     'device'`, `policy_decision_state = 'human_required'`, Tier 3 supervised.
 *  5. **Approvals stay advisory (OD-3 A).** No run writes a `patch_approvals`
 *     row.
 *  6. **The eligibility read is org-pinned** — a forge with the wrong org
 *     returns zero eligible rows.
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
import { and, eq, sql } from 'drizzle-orm';
import type { PatchPlanOutcome } from '@breeze/shared';
import { getTestDb } from './setup';
import {
  assignUserToOrganization, createOrganization, createPartner, createRole, createSite, createUser, grantRolePermissions,
} from './db-utils';
import { db, withSystemDbAccessContext } from '../../db';
import {
  actionIntents, aiAgents, aiAgentRuns, configPolicyAssignments, configPolicyFeatureLinks, configPolicyPatchSettings,
  configurationPolicies, devicePatches, devices, patchApprovals, patches, patchPolicies,
} from '../../db/schema';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import { persistPatchPlan, type PatchPersistRunInput } from '../../services/aiAgents/patchPlan';
import { patchEpisodeIdempotencyKey } from '../../services/aiAgents/patchEpisode';
import { computeEffectDigestForRelease } from '../../services/actionIntents/effectDigest';
import { resolvePatchInstallEligibility } from '../../services/patchEligibility';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function countWhere(query: ReturnType<typeof sql>): Promise<number> {
  const rows = (await getTestDb().execute(query)) as unknown as Array<Record<string, unknown>>;
  return Number(Object.values(rows[0] ?? { c: 0 })[0]);
}

async function insertDevice(orgId: string, siteId: string) {
  const unique = randomUUID().slice(0, 8);
  const [device] = await withSystemDbAccessContext(() => db
    .insert(devices)
    .values({
      orgId, siteId, agentId: `w02-agent-${unique}`, hostname: `w02-host-${unique}`, osType: 'windows', osVersion: '10',
      architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online', lastSeenAt: new Date(),
    })
    .returning());
  return device!;
}

async function insertOutstandingPatch(orgId: string, deviceId: string, over: { releaseDate?: string; severity?: 'critical' | 'important' | 'moderate' | 'low' } = {}) {
  const unique = randomUUID().slice(0, 8);
  const [patch] = await withSystemDbAccessContext(() => db
    .insert(patches)
    .values({
      source: 'microsoft', externalId: `KB-${unique}`, vendor: 'Microsoft', title: `Security update ${unique}`,
      severity: over.severity ?? 'critical', requiresReboot: true, releaseDate: over.releaseDate ?? '2026-01-01',
    })
    .returning());
  await withSystemDbAccessContext(() => db.insert(devicePatches).values({ deviceId, orgId, patchId: patch!.id, status: 'pending' }));
  return patch!;
}

/** A ring whose auto-approve admits critical OS patches, linked to the org
 *  through a config policy — the live path `resolvePatchInstallEligibility`
 *  walks (`resolvePatchConfigDetailsForDevice` → `loadPolicyLocalPatchConfig`). */
async function seedRingForOrg(partnerId: string, orgId: string, deferralDays = 0) {
  return withSystemDbAccessContext(async () => {
    const [ring] = await db
      .insert(patchPolicies)
      .values({
        partnerId, kind: 'ring', name: `W02 ring ${randomUUID().slice(0, 8)}`, deferralDays,
        autoApprove: { enabled: true, severities: ['critical', 'important'] },
        categoryRules: [],
      })
      .returning({ id: patchPolicies.id });
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId, partnerId: null, name: 'W02 patch policy', status: 'active' })
      .returning({ id: configurationPolicies.id });
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'patch', featurePolicyId: ring!.id, inlineSettings: {} })
      .returning({ id: configPolicyFeatureLinks.id });
    await db.insert(configPolicyPatchSettings).values({ featureLinkId: link!.id, sources: ['os'] });
    await db.insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'organization', targetId: orgId, priority: 0 });
    return { ringId: ring!.id, policyId: policy!.id };
  });
}

interface Fixture {
  partnerId: string; orgId: string; siteId: string; deviceId: string; patchId: string; ringId: string;
  agentId: string; approverId: string; run: (id?: string) => PatchPersistRunInput; agentAuth: ReturnType<typeof buildAgentAuthContext>;
}

/** Whole tenancy: partner, org, device with one outstanding critical patch, a
 *  ring that auto-approves it, a patch agent and an approver who holds
 *  `patches:execute` (what `manage_patches:install` requires). */
async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await insertDevice(org.id, site.id);
  const patch = await insertOutstandingPatch(org.id, device.id);
  const { ringId } = await seedRingForOrg(partner.id, org.id);

  const creator = await createUser({ partnerId: partner.id, orgId: org.id, email: `creator-${randomUUID()}@w02.test` });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  // manage_patches now maps onto the real routes' devices:* grants
  // (2026-09-17 ROLE audit §2.6 — `patches` was never a catalog resource).
  await grantRolePermissions(role.id, [{ resource: 'devices', action: 'execute' }]);
  const approver = await createUser({ partnerId: partner.id, orgId: org.id, email: `approver-${randomUUID()}@w02.test` });
  await assignUserToOrganization(approver.id, org.id, role.id);

  const [agent] = await withSystemDbAccessContext(() => db
    .insert(aiAgents)
    .values({ partnerId: partner.id, orgId: null, kind: 'patch', name: 'Patch Agent', ...effectivePolicyFields(), createdBy: creator.id })
    .returning());

  const run = (id: string = randomUUID()): PatchPersistRunInput => ({
    id, orgId: org.id, agentId: agent!.id, scheduleId: null, toolAllowlist: ['manage_patches:install'], maxActionsPerRun: 5,
  });
  const agentAuth = buildAgentAuthContext(
    { id: agent!.id, orgId: null, partnerId: partner.id, name: agent!.name, kind: 'patch' },
    { id: randomUUID(), orgId: org.id, deviceId: null, deviceSiteId: null },
    { id: org.id, partnerId: partner.id },
  );
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, deviceId: device.id, patchId: patch.id, ringId, agentId: agent!.id, approverId: approver.id, run, agentAuth };
}

/** The agent's effective policy — `manage_patches:install` allowlisted, the
 *  shape `checkAgentGuardrails` validates off the run's policy snapshot. */
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

/** A real run row so `createActionIntent`'s `requestingAgentRunId` resolves
 *  and the agent guardrail can read a VALID policy snapshot off it. */
async function insertRunRow(f: Fixture): Promise<string> {
  const snapshot = {
    schemaVersion: 1, agentId: f.agentId, kind: 'patch', effective: effectivePolicyFields(), resolvedAt: new Date().toISOString(),
  };
  const [row] = await withSystemDbAccessContext(() => db
    .insert(aiAgentRuns)
    .values({
      agentId: f.agentId, orgId: f.orgId, deviceId: null, profile: 'patch', scheduleId: null, triggerKind: 'manual',
      triggerRef: { kind: 'patch' }, dedupeKey: `w02-${randomUUID()}`, modeAtStart: 'shadow',
      policySnapshot: snapshot as never, status: 'running',
    })
    .returning({ id: aiAgentRuns.id }));
  return row!.id;
}

function planFor(f: Fixture, patchIds: string[] = [f.patchId]): PatchPlanOutcome {
  return {
    schemaVersion: 1,
    summary: 'Plan',
    posture: { compliancePct: 50, devicesAtRisk: 1, oldestOutstandingDays: 10 },
    items: [{
      class: 'install', severity: 'critical', deviceId: f.deviceId, patchIds,
      title: 'Install 1 critical update', detail: 'd', evidenceRef: 'topNonCompliant:0',
    }],
    dispositions: [],
    evidenceTruncated: false,
    generatedAt: new Date().toISOString(),
  };
}

function refsFor(f: Fixture, patchIds: string[] = [f.patchId]) {
  return {
    deviceIds: new Set([f.deviceId]),
    patchIdsByDevice: new Map([[f.deviceId, new Set(patchIds)]]),
    windowIds: new Set<string>(),
    jobResultIds: new Set<string>(),
  };
}

async function persist(f: Fixture, plan = planFor(f), refs = refsFor(f)) {
  const runId = await insertRunRow(f);
  const auth = buildAgentAuthContext(
    { id: f.agentId, orgId: null, partnerId: f.partnerId, name: 'Patch Agent', kind: 'patch' },
    { id: runId, orgId: f.orgId, deviceId: null, deviceSiteId: null },
    { id: f.orgId, partnerId: f.partnerId },
  );
  return persistPatchPlan(f.run(runId), plan, refs, auth);
}

async function readIntent(intentId: string) {
  const [row] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1));
  return row!;
}

async function liveIntentCount(orgId: string, key: string): Promise<number> {
  return countWhere(sql`
    SELECT COUNT(*) AS c FROM action_intents
    WHERE org_id = ${orgId}::uuid AND idempotency_key = ${key}
      AND status IN ('pending_approval', 'approved', 'executing')
  `);
}

async function decideIntent(intentId: string, status: 'rejected' | 'expired' | 'cancelled', decidedDaysAgo: number | null) {
  await withSystemDbAccessContext(() => db.execute(sql`
    UPDATE action_intents
    SET status = ${status},
        decided_at = ${decidedDaysAgo === null ? null : sql`now() - (${decidedDaysAgo} || ' days')::interval`}
    WHERE id = ${intentId}::uuid
  `));
}

async function releaseDigest(intent: { arguments: unknown }): Promise<string | null> {
  return withSystemDbAccessContext(async () =>
    (await computeEffectDigestForRelease('manage_patches', intent.arguments as Record<string, unknown>, db)).digest);
}

// ---------------------------------------------------------------------------
// 1-2: one live card per problem; suppression after a decision
// ---------------------------------------------------------------------------

describe('one intent per problem (OD-4 A)', () => {
  runDb('the same (device, patch) on two consecutive occurrences yields exactly ONE live intent', async () => {
    const f = await seedFixture();
    const key = patchEpisodeIdempotencyKey(f.orgId, f.deviceId, f.patchId);

    const first = await persist(f);
    expect(first.dispositions[0]).toMatchObject({ disposition: 'intent_created', mintedPatchIds: [f.patchId] });
    expect(first.intentIds).toHaveLength(1);

    const second = await persist(f);
    expect(second.dispositions[0]).toMatchObject({ disposition: 'suppressed', reason: 'live_intent_exists' });
    expect(second.intentIds).toEqual([]);

    expect(await liveIntentCount(f.orgId, key)).toBe(1);
  });

  runDb('a rejected card is suppressed on the next occurrence and re-proposed after the window', async () => {
    const f = await seedFixture();
    const first = await persist(f);
    const intentId = first.intentIds[0]!;

    await decideIntent(intentId, 'rejected', 2);
    const soon = await persist(f);
    expect(soon.dispositions[0]).toMatchObject({ disposition: 'suppressed', reason: 'recently_rejected' });

    await decideIntent(intentId, 'rejected', 15);
    const later = await persist(f);
    expect(later.dispositions[0]).toMatchObject({ disposition: 'intent_created' });
    expect(later.intentIds[0]).not.toBe(intentId);
  });

  runDb('an expired card is re-proposed immediately', async () => {
    const f = await seedFixture();
    const first = await persist(f);
    await decideIntent(first.intentIds[0]!, 'expired', null);

    const again = await persist(f);
    expect(again.dispositions[0]).toMatchObject({ disposition: 'intent_created' });
    expect(again.intentIds[0]).not.toBe(first.intentIds[0]);
  });

  runDb('the unique index rejects a second live intent on the same key', async () => {
    const f = await seedFixture();
    const first = await persist(f);
    const original = await readIntent(first.intentIds[0]!);

    let caught: unknown;
    try {
      // A byte-for-byte clone of the live row under a fresh id — same org,
      // same key, same live status — is exactly what the partial unique index
      // must refuse.
      await withSystemDbAccessContext(() => db.execute(sql`
        INSERT INTO action_intents
        SELECT (jsonb_populate_record(NULL::action_intents, to_jsonb(a) || jsonb_build_object('id', ${randomUUID()}::uuid))).*
        FROM action_intents a WHERE a.id = ${original.id}::uuid
      `));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as { cause?: { code?: string } }).cause?.code).toBe('23505');
  });
});

// ---------------------------------------------------------------------------
// 3: the minted card's shape, and what a run never writes
// ---------------------------------------------------------------------------

describe('the minted card', () => {
  runDb('is device-scoped, Tier-3 supervised and pending_approval — never policy-decided', async () => {
    const f = await seedFixture();
    const { intentIds } = await persist(f);
    const row = await readIntent(intentIds[0]!);
    expect(row.status).toBe('pending_approval');
    expect(row.scopeKind).toBe('device');
    expect(row.scopeDeviceId).toBe(f.deviceId);
    expect(row.policyDecisionState).toBe('human_required');
    expect(row.riskTier).toBe(3);
    expect(row.approvalScope).toBe('supervised');
    expect(row.actionName).toBe('manage_patches');
    expect(row.arguments).toEqual({ action: 'install', deviceIds: [f.deviceId], patchIds: [f.patchId] });
    expect(row.idempotencyKey).toBe(patchEpisodeIdempotencyKey(f.orgId, f.deviceId, f.patchId));
    // The eligibility verdict was pinned at creation for the release re-check.
    expect(row.effectDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  runDb('an approval_advisory item writes NO patch_approvals row and mints no intent', async () => {
    const f = await seedFixture();
    const before = await countWhere(sql`SELECT COUNT(*) AS c FROM patch_approvals WHERE partner_id = ${f.partnerId}::uuid`);
    const plan = planFor(f);
    plan.items = [{ class: 'approval_advisory', severity: 'high', patchIds: [f.patchId], title: 'Approve KB', detail: 'd', evidenceRef: 'ringPosture:0' }];
    const { dispositions, intentIds } = await persist(f, plan);
    expect(dispositions[0]).toMatchObject({ disposition: 'recorded' });
    expect(intentIds).toEqual([]);
    expect(await countWhere(sql`SELECT COUNT(*) AS c FROM patch_approvals WHERE partner_id = ${f.partnerId}::uuid`)).toBe(before);
    expect(await countWhere(sql`SELECT COUNT(*) AS c FROM action_intents WHERE org_id = ${f.orgId}::uuid`)).toBe(0);
  });

  runDb('a patch that is not eligible right now is dropped from the card with its reason', async () => {
    const f = await seedFixture();
    // 'low' is outside the ring's severities, so it needs a manual approval it does not have.
    const low = await insertOutstandingPatch(f.orgId, f.deviceId, { severity: 'low' });
    const { dispositions } = await persist(f, planFor(f, [f.patchId, low.id]), refsFor(f, [f.patchId, low.id]));
    expect(dispositions[0]).toMatchObject({
      disposition: 'intent_created',
      mintedPatchIds: [f.patchId],
      droppedPatchIds: [{ patchId: low.id, reason: 'awaiting_manual_approval' }],
    });
  });
});

// ---------------------------------------------------------------------------
// 4: release revalidation — the pinned verdict vs the live one
// ---------------------------------------------------------------------------

describe('release revalidation (effect digest, intentReleaseWorker comparison)', () => {
  runDb('the recomputed digest matches the pinned one while nothing changed', async () => {
    const f = await seedFixture();
    const { intentIds } = await persist(f);
    const row = await readIntent(intentIds[0]!);
    expect(await releaseDigest(row)).toBe(row.effectDigest);
  });

  runDb('drops a patch that became deferred after approval', async () => {
    const f = await seedFixture();
    const { intentIds } = await persist(f);
    const row = await readIntent(intentIds[0]!);
    // The patch was released 2026-01-01; a 3650-day ring auto-approve
    // deferral (parseRingAutoApprove reads it off the autoApprove jsonb) now
    // holds it.
    await withSystemDbAccessContext(() => db
      .update(patchPolicies)
      .set({ autoApprove: { enabled: true, severities: ['critical', 'important'], deferralDays: 3650 } })
      .where(eq(patchPolicies.id, f.ringId)));
    expect(await releaseDigest(row)).not.toBe(row.effectDigest);
  });

  runDb('drops a patch that became superseded after approval', async () => {
    const f = await seedFixture();
    const { intentIds } = await persist(f);
    const row = await readIntent(intentIds[0]!);
    await withSystemDbAccessContext(() => db.update(patches).set({ supersededBy: 'KB-newer' }).where(eq(patches.id, f.patchId)));
    expect(await releaseDigest(row)).not.toBe(row.effectDigest);
  });

  runDb('drops a patch that was un-approved after approval (manual approval revoked, no ring rule)', async () => {
    const f = await seedFixture();
    // A moderate patch is outside the ring's severities; a partner-wide manual approval admits it.
    const moderate = await insertOutstandingPatch(f.orgId, f.deviceId, { severity: 'moderate' });
    await withSystemDbAccessContext(() => db.insert(patchApprovals).values({ partnerId: f.partnerId, patchId: moderate.id, ringId: null, status: 'approved' }));
    const { intentIds, dispositions } = await persist(f, planFor(f, [moderate.id]), refsFor(f, [moderate.id]));
    expect(dispositions[0]).toMatchObject({ disposition: 'intent_created', mintedPatchIds: [moderate.id] });
    const row = await readIntent(intentIds[0]!);
    await withSystemDbAccessContext(() => db.update(patchApprovals).set({ status: 'rejected' }).where(and(eq(patchApprovals.partnerId, f.partnerId), eq(patchApprovals.patchId, moderate.id))));
    expect(await releaseDigest(row)).not.toBe(row.effectDigest);
  });

  runDb('an intent for a device that moved org does not release', async () => {
    const f = await seedFixture();
    const { intentIds } = await persist(f);
    const row = await readIntent(intentIds[0]!);
    const otherOrg = await createOrganization({ partnerId: f.partnerId });
    const otherSite = await createSite({ orgId: otherOrg.id });
    await withSystemDbAccessContext(() => db.update(devices).set({ orgId: otherOrg.id, siteId: otherSite.id }).where(eq(devices.id, f.deviceId)));
    expect(await releaseDigest(row)).not.toBe(row.effectDigest);
  });
});

// ---------------------------------------------------------------------------
// 5: the eligibility read is org-pinned
// ---------------------------------------------------------------------------

describe('resolvePatchInstallEligibility tenancy', () => {
  runDb('a cross-org forge of the eligibility read returns zero eligible rows', async () => {
    const f = await seedFixture();
    const stranger = await createOrganization({ partnerId: f.partnerId });
    const genuine = await withSystemDbAccessContext(() => resolvePatchInstallEligibility({ deviceId: f.deviceId, orgId: f.orgId, patchIds: [f.patchId] }));
    expect(genuine.eligible.map((e) => e.patchId)).toEqual([f.patchId]);
    const forged = await withSystemDbAccessContext(() => resolvePatchInstallEligibility({ deviceId: f.deviceId, orgId: stranger.id, patchIds: [f.patchId] }));
    expect(forged.eligible).toEqual([]);
    expect(forged.ineligible).toEqual([{ patchId: f.patchId, reason: 'device_not_in_org' }]);
    // Nothing in this suite ever wrote to the vendor catalog's approval table.
    expect(await countWhere(sql`SELECT COUNT(*) AS c FROM patch_approvals WHERE partner_id = ${f.partnerId}::uuid`)).toBe(0);
  });
});
