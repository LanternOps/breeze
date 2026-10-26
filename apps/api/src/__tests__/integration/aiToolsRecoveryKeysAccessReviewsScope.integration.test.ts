/**
 * Integration test — W11 (#6781) manage_recovery_keys, manage_access_reviews and manage_audit_baselines honour the
 * org axis, the site axis and the exact-device axis against real Postgres as the unprivileged `breeze_app` role.
 *
 * Entry point: `executeTool`, so the central `deviceArgs` gate runs before the handler exactly as in production.
 * The human approval step lives in the chat layer (unit-tested in aiGuardrails.*); this suite pins the class each
 * write is raised at and then tests the scope behaviour that runs AFTER approval. Proven against stored rows:
 *   - recovery keys: an out-of-site or foreign device is refused before any command is queued; key material and
 *     the identity of who revealed a key never appear in the output (byte scan); `reveal` does not exist;
 *   - access reviews: another org's review is not found and its item is unchanged; a decision is recorded only
 *     (the member keeps the membership); a reviewer outside the review's scope is refused;
 *   - audit baselines: an apply request naming an out-of-site device is refused and writes no row; compliance
 *     counts only the devices the caller can see.
 * Every refusal has a CONTROL that lands the same call for the caller the guard admits.
 * Only the device command queue (`aiQueueCommand`) and the drift-evaluation enqueue are stubbed.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  aiQueueCommand: vi.fn(async (..._a: unknown[]) => ({ id: crypto.randomUUID() })),
  enqueueDrift: vi.fn(async (..._a: unknown[]) => 'job-id'),
}));
vi.mock('../../services/aiDispatch', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  aiQueueCommand: mocks.aiQueueCommand,
}));
vi.mock('../../jobs/auditBaselineJobs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueAuditDriftEvaluation: mocks.enqueueDrift,
}));

import type { DbAccessContext } from '../../db';
import { withDbAccessContext } from '../../db';
import {
  accessReviewItems, accessReviews, auditBaselineApplyApprovals, auditBaselineResults, auditBaselines,
  deviceRecoveryKeys, devices, organizationUsers, recoveryKeyAccessEvents,
} from '../../db/schema';
import { executeTool } from '../../services/aiTools';
import { checkGuardrails } from '../../services/aiGuardrails';
import { validateToolInput } from '../../services/aiToolSchemas';
import { clearPermissionCache } from '../../services/permissions';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner, createRole, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
type Who = 'restricted' | 'orgAdmin' | 'otherOrg';
const KEY_SENTINEL = 'ENCRYPTED-KEY-SENTINEL-W11';
const REVEALER_EMAIL = 'revealer-sentinel@example.com';

function makeAuth(userId: string, partnerId: string, orgId: string, allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    partnerId, orgId, scope: 'organization', accessibleOrgIds: [orgId],
    orgCondition: (col: any) => eq(col, orgId),
    canAccessOrg: (id: string) => id === orgId,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'w11-keys-reviews' },
  } as unknown as AuthContext;
}

interface Fixture {
  partnerId: string; orgA: string; orgB: string; siteA: string; siteB: string;
  devA: string; devB: string; devOther: string; keyA: string;
  adminA: string; memberA: string; adminB: string;
  baselineA: string; baselineB: string;
  auth: Record<Who, AuthContext>;
}

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const [row] = await getTestDb().insert(devices).values({
    orgId, siteId, agentId: `w11-keys-${randomUUID()}`, hostname: `w11k-${randomUUID().slice(0, 8)}`,
    osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '1.0.0', status: 'online',
  }).returning({ id: devices.id });
  return row!.id;
}

async function seedFixture(): Promise<Fixture> {
  const db = getTestDb();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id, name: 'W11 keys A' });
  const siteB = await createSite({ orgId: orgA.id, name: 'W11 keys B' });
  const siteOther = await createSite({ orgId: orgB.id, name: 'W11 keys other' });
  const roleA = await createRole({ scope: 'organization', orgId: orgA.id, partnerId: partner.id });
  const roleB = await createRole({ scope: 'organization', orgId: orgB.id, partnerId: partner.id });
  const member = async (orgId: string, roleId: string, tag: string) => {
    const u = await createUser({ partnerId: partner.id, orgId, email: `w11-${tag}-${randomUUID()}@example.com` });
    await db.insert(organizationUsers).values({ userId: u.id, orgId, roleId });
    return u.id;
  };
  const adminA = await member(orgA.id, roleA.id, 'admin-a');
  const memberA = await member(orgA.id, roleA.id, 'member-a');
  const adminB = await member(orgB.id, roleB.id, 'admin-b');

  const devA = await seedDevice(orgA.id, siteA.id);
  const devB = await seedDevice(orgA.id, siteB.id);
  const devOther = await seedDevice(orgB.id, siteOther.id);
  const [key] = await db.insert(deviceRecoveryKeys).values({
    deviceId: devA, orgId: orgA.id, keyType: 'bitlocker_recovery_password', volumeMount: 'C:',
    encryptedKey: KEY_SENTINEL, keyFingerprint: 'f'.repeat(64), status: 'active',
  } as typeof deviceRecoveryKeys.$inferInsert).returning({ id: deviceRecoveryKeys.id });
  await db.insert(recoveryKeyAccessEvents).values({ keyId: key!.id, deviceId: devA, orgId: orgA.id, userId: adminA, userEmail: REVEALER_EMAIL, action: 'revealed' });

  const baseline = async (orgId: string) => {
    const [row] = await db.insert(auditBaselines).values({
      orgId, name: `Windows CIS ${orgId.slice(0, 4)}`, osType: 'windows', profile: 'cis_l1',
      settings: { 'auditpol:logon': 'success_and_failure' }, isActive: true,
    }).returning({ id: auditBaselines.id });
    return row!.id;
  };
  const baselineA = await baseline(orgA.id);
  const baselineB = await baseline(orgB.id);
  const result = (deviceId: string, orgId: string, baselineId: string, compliant: boolean) => ({
    deviceId, orgId, baselineId, compliant, score: compliant ? 100 : 40, deviations: compliant ? [] : [{ setting: 'auditpol:logon', expected: 'success_and_failure', actual: 'no_auditing', reason: 'mismatch' }], checkedAt: new Date(),
  });
  await db.insert(auditBaselineResults).values([
    result(devA, orgA.id, baselineA, true), result(devB, orgA.id, baselineA, false), result(devOther, orgB.id, baselineB, false),
  ]);

  return {
    partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, siteA: siteA.id, siteB: siteB.id,
    devA, devB, devOther, keyA: key!.id, adminA, memberA, adminB, baselineA, baselineB,
    auth: {
      restricted: makeAuth(memberA, partner.id, orgA.id, [siteA.id]),
      orgAdmin: makeAuth(adminA, partner.id, orgA.id),
      otherOrg: makeAuth(adminB, partner.id, orgB.id),
    },
  };
}

function ctxFor(f: Fixture, who: Who, auth: AuthContext = f.auth[who]): DbAccessContext {
  return buildDbAccessContext({ scope: 'organization', orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: f.partnerId, userId: auth.user.id });
}

async function run(f: Fixture, who: Who, tool: string, input: Record<string, unknown>, auth: AuthContext = f.auth[who]) {
  const raw = await withDbAccessContext(ctxFor(f, who, auth), () => executeTool(tool, input, auth));
  return { raw, body: JSON.parse(raw) as Record<string, any> };
}

let f: Fixture;
beforeEach(async () => {
  clearPermissionCache();
  mocks.aiQueueCommand.mockClear();
  mocks.enqueueDrift.mockClear();
  f = await seedFixture();
});

describe('manage_recovery_keys', () => {
  runDb('rotate and collect are raised supervised, and reveal does not exist in any form', () => {
    expect(checkGuardrails('manage_recovery_keys', { action: 'rotate' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    expect(checkGuardrails('manage_recovery_keys', { action: 'collect' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    expect(validateToolInput('manage_recovery_keys', { action: 'reveal', deviceId: f.devA }).success).toBe(false);
  });

  runDb('an out-of-site device and a foreign device are refused before any command (CONTROL: in-site rotate and collect queue)', async () => {
    for (const action of ['rotate', 'collect']) {
      const outOfSite = await run(f, 'restricted', 'manage_recovery_keys', { action, deviceId: f.devB });
      expect(outOfSite.body.error, outOfSite.raw).toBeTruthy();
      const foreign = await run(f, 'otherOrg', 'manage_recovery_keys', { action, deviceId: f.devA });
      expect(foreign.body.error, foreign.raw).toBeTruthy();
    }
    expect(mocks.aiQueueCommand).not.toHaveBeenCalled();
    const rotate = await run(f, 'restricted', 'manage_recovery_keys', { action: 'rotate', deviceId: f.devA });
    expect(rotate.body, rotate.raw).toMatchObject({ queued: true, volumeMount: 'C:' });
    const collect = await run(f, 'restricted', 'manage_recovery_keys', { action: 'collect', deviceId: f.devA });
    expect(collect.body.queued, collect.raw).toBe(true);
    expect(mocks.aiQueueCommand.mock.calls.map((c) => [c[2], c[3]])).toEqual([[f.devA, 'encryption_rotate_key'], [f.devA, 'encryption_collect_keys']]);
  });

  runDb('the list never carries key material or who revealed a key (byte scan of the raw output)', async () => {
    const out = await run(f, 'orgAdmin', 'manage_recovery_keys', { action: 'list', deviceId: f.devA });
    expect(out.body.keys, out.raw).toHaveLength(1);
    expect(out.body.accessHistory).toEqual([expect.objectContaining({ keyId: f.keyA, action: 'revealed' })]);
    expect(out.raw).not.toContain(KEY_SENTINEL);
    expect(out.raw).not.toContain(REVEALER_EMAIL);
    expect(out.raw).not.toContain(f.adminA);
    // No reveal ledger row was written by the read.
    expect(await getTestDb().select().from(recoveryKeyAccessEvents).where(eq(recoveryKeyAccessEvents.keyId, f.keyA))).toHaveLength(1);
  });
});

describe('manage_access_reviews', () => {
  async function createReview(): Promise<{ reviewId: string; itemFor: (userId: string) => Promise<string> }> {
    const out = await run(f, 'orgAdmin', 'manage_access_reviews', { action: 'create', name: 'Q4 review' });
    expect(out.body.created, out.raw).toBe(true);
    const reviewId = out.body.id as string;
    return {
      reviewId,
      itemFor: async (userId) => (await getTestDb().select({ id: accessReviewItems.id }).from(accessReviewItems)
        .where(and(eq(accessReviewItems.reviewId, reviewId), eq(accessReviewItems.userId, userId))))[0]!.id,
    };
  }

  runDb('create is supervised, decide_item t2; complete does not exist', () => {
    expect(checkGuardrails('manage_access_reviews', { action: 'create' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    expect(checkGuardrails('manage_access_reviews', { action: 'decide_item' }).tier).toBe(2);
    expect(validateToolInput('manage_access_reviews', { action: 'complete', reviewId: randomUUID() }).success).toBe(false);
  });

  runDb('create snapshots the org\'s members; a reviewer outside the org is refused (CONTROL: an in-org reviewer lands)', async () => {
    const foreignReviewer = await run(f, 'orgAdmin', 'manage_access_reviews', { action: 'create', name: 'x', reviewerId: f.adminB });
    expect(foreignReviewer.body.code, foreignReviewer.raw).toBe('VALIDATION_ERROR');
    const ok = await run(f, 'orgAdmin', 'manage_access_reviews', { action: 'create', name: 'x', reviewerId: f.memberA });
    expect(ok.body.itemCount, ok.raw).toBe(2);
    const [row] = await getTestDb().select().from(accessReviews).where(eq(accessReviews.id, ok.body.id));
    expect(row).toMatchObject({ orgId: f.orgA, partnerId: null, reviewerId: f.memberA, status: 'pending' });
  });

  runDb('an item decision on another org\'s review is not found and the item is unchanged (CONTROL: the org records it)', async () => {
    const { reviewId, itemFor } = await createReview();
    const itemId = await itemFor(f.memberA);
    const foreign = await run(f, 'otherOrg', 'manage_access_reviews', { action: 'decide_item', reviewId, itemId, decision: 'revoked' });
    const missing = await run(f, 'otherOrg', 'manage_access_reviews', { action: 'decide_item', reviewId: randomUUID(), itemId, decision: 'revoked' });
    expect(foreign.body.code, foreign.raw).toBe('NOT_FOUND');
    expect(foreign.raw).toBe(missing.raw);
    const before = (await getTestDb().select().from(accessReviewItems).where(eq(accessReviewItems.id, itemId)))[0]!;
    expect(before.decision).toBe('pending');
    const own = await run(f, 'orgAdmin', 'manage_access_reviews', { action: 'decide_item', reviewId, itemId, decision: 'revoked', notes: 'left' });
    expect(own.body.updated, own.raw).toBe(true);
    const after = (await getTestDb().select().from(accessReviewItems).where(eq(accessReviewItems.id, itemId)))[0]!;
    expect(after).toMatchObject({ decision: 'revoked', reviewedBy: f.adminA });
    // Recorded only: the member keeps the membership until a person completes the review in the web app.
    expect(await getTestDb().select().from(organizationUsers).where(and(eq(organizationUsers.orgId, f.orgA), eq(organizationUsers.userId, f.memberA)))).toHaveLength(1);
  });

  runDb('a site-restricted session is refused outright (CONTROL: the unrestricted admin lists)', async () => {
    await createReview();
    expect((await run(f, 'restricted', 'manage_access_reviews', { action: 'list' })).body.code).toBe('ACCESS_DENIED');
    const admin = await run(f, 'orgAdmin', 'manage_access_reviews', { action: 'list' });
    expect(admin.body.reviews, admin.raw).toHaveLength(1);
    expect((await run(f, 'otherOrg', 'manage_access_reviews', { action: 'list' })).body.reviews).toEqual([]);
  });
});

describe('manage_audit_baselines', () => {
  runDb('an apply request naming an out-of-site device is refused and writes nothing (CONTROL: in-site writes a pending row)', async () => {
    const refused = await run(f, 'restricted', 'manage_audit_baselines', { action: 'request_apply', baselineId: f.baselineA, deviceIds: [f.devA, f.devB] });
    expect(refused.body.error, refused.raw).toBeTruthy();
    const foreign = await run(f, 'otherOrg', 'manage_audit_baselines', { action: 'request_apply', baselineId: f.baselineA, deviceIds: [f.devOther] });
    expect(foreign.body.code, foreign.raw).toBe('NOT_FOUND');
    expect(await getTestDb().select().from(auditBaselineApplyApprovals)).toHaveLength(0);
    const ok = await run(f, 'restricted', 'manage_audit_baselines', { action: 'request_apply', baselineId: f.baselineA, deviceIds: [f.devA] });
    expect(ok.body, ok.raw).toMatchObject({ requested: true, status: 'pending', eligibleDeviceIds: [f.devA] });
    const [row] = await getTestDb().select().from(auditBaselineApplyApprovals);
    expect(row).toMatchObject({ orgId: f.orgA, baselineId: f.baselineA, requestedBy: f.memberA, status: 'pending', approvedBy: null });
  });

  runDb('compliance counts only the devices the caller can see (CONTROL: the unrestricted admin sees both)', async () => {
    const restricted = await run(f, 'restricted', 'manage_audit_baselines', { action: 'compliance' });
    expect(restricted.body, restricted.raw).toMatchObject({ devices: 1, compliant: 1, nonCompliant: 0 });
    const admin = await run(f, 'orgAdmin', 'manage_audit_baselines', { action: 'compliance' });
    expect(admin.body, admin.raw).toMatchObject({ devices: 2, compliant: 1, nonCompliant: 1 });
    expect(admin.raw).not.toContain(f.baselineB);
  });

  runDb('device results of an out-of-site device are refused (CONTROL: in-site deviations come back)', async () => {
    const hidden = await run(f, 'restricted', 'manage_audit_baselines', { action: 'device_results', deviceId: f.devB });
    expect(hidden.body.error, hidden.raw).toBeTruthy();
    const own = await run(f, 'orgAdmin', 'manage_audit_baselines', { action: 'device_results', deviceId: f.devB });
    expect(own.body.baselines?.[0]?.deviations?.[0], own.raw).toMatchObject({ setting: 'auditpol:logon', actual: 'no_auditing' });
  });

  runDb('a restricted session cannot create a baseline (CONTROL: the admin creates one and the old one deactivates)', async () => {
    const refused = await run(f, 'restricted', 'manage_audit_baselines', { action: 'create', name: 'L2', osType: 'windows', profile: 'cis_l2' });
    expect(refused.body.code, refused.raw).toBe('ACCESS_DENIED');
    const ok = await run(f, 'orgAdmin', 'manage_audit_baselines', { action: 'create', name: 'L2', osType: 'windows', profile: 'cis_l2' });
    expect(ok.body.created, ok.raw).toBe(true);
    const active = await getTestDb().select({ id: auditBaselines.id }).from(auditBaselines)
      .where(and(eq(auditBaselines.orgId, f.orgA), eq(auditBaselines.isActive, true)));
    expect(active.map((r) => r.id)).toEqual([ok.body.baseline.id]);
    expect(mocks.enqueueDrift).toHaveBeenCalledWith(f.orgA);
    // The other org's active baseline is untouched.
    expect((await getTestDb().select({ a: auditBaselines.isActive }).from(auditBaselines).where(inArray(auditBaselines.id, [f.baselineB])))[0]!.a).toBe(true);
  });
});
