/**
 * Wisp W02 (#9908) — `wisp_grants` / `wisp_grant_revisions` against real
 * Postgres (migrations/2027-01-04-100100-wisp-grants.sql).
 *
 * `rls-coverage.integration.test.ts` proves the tables are REGISTERED. This
 * file is the functional proof: it forges cross-partner and non-grantor writes
 * and watches Postgres refuse them, drives the admin tighten/revoke-only
 * trigger and the append-only revisions, then runs the grant service and the
 * run admission gate through the real RLS-backed pool with a real step-up
 * grant in the test Redis.
 *
 * Placement is load-bearing: `src/__tests__/integration/**` +
 * `.integration.test.ts` puts it in the blocking Integration Tests job.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  aiAgentRuns,
  aiAgents,
  devices,
  partners,
  partnerUsers,
  permissions,
  rolePermissions,
  users,
  wispGrantRevisions,
  wispGrants,
} from '../../db/schema';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';
import type { AuthContext } from '../../middleware/auth';
import { mintStepUpGrant, wispGrantResourceDigest } from '../../services/mfaStepUpGrant';
import { assertWithinCeiling, resolveGrantCeiling } from '../../services/wisp/grantAuthority';
import { checkAgentReleaseAuthority } from '../../services/actionIntents/agentReleaseAuthority';
import type { ActionIntent } from '../../db/schema/actionIntents';
import {
  createGrant,
  GrantLimitReachedError,
  previewGrantCeiling,
  refreshGrant,
  revokeGrant,
  WispGrantError,
} from '../../services/wisp/grants';
import { invalidateEntitlementCache, upsertEntitlementRow } from '../../services/entitlements';
import { reconcileActiveGrants, reconcileGrantsForUser } from '../../services/wisp/grantLifecycle';
import {
  createAndEnqueueAgentRun,
  GrantDepthExceededError,
  registerAgentRunEnqueuer,
} from '../../services/aiAgents/runService';
import { cascadeDeleteOrg, cascadeDeletePartner } from '../../services/tenantCascade';
import { getTestDb } from './setup';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
  userEpochs,
} from './db-utils';
import { usePlatformAiKeyPlaceholder } from './helpers/platformAiKey';

usePlatformAiKeyPlaceholder();

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};

function partnerContext(partnerId: string, orgIds: string[], userId: string | null): DbAccessContext {
  return {
    scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId],
    userId, currentPartnerId: partnerId,
  };
}

function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [],
    userId: null, currentPartnerId: partnerId,
  };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

const snapshot = (orgIds: string[], permissionKeys = ['ai_sessions:use', 'devices:read']): WispCeilingSnapshot => ({
  version: 1, permissionKeys, orgIds, siteIds: null, toolAllowlist: null, deniedTools: [],
});

/** A grant + revision 1 + pointer, written in system scope (the fixture path). */
async function seedGrant(opts: {
  partnerId: string; grantorUserId: string; orgId?: string | null; orgIds: string[];
  status?: 'active' | 'paused' | 'revoked' | 'expired'; pausedReason?: string | null; expiresAt?: Date;
}): Promise<{ grantId: string; revisionId: string }> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [grant] = await db.insert(wispGrants).values({
      partnerId: opts.partnerId,
      orgId: opts.orgId ?? null,
      grantorUserId: opts.grantorUserId,
      status: opts.status ?? 'active',
      pausedReason: (opts.pausedReason ?? (opts.status === 'paused' ? 'user_paused' : null)) as never,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 30 * 86_400_000),
    }).returning({ id: wispGrants.id });
    const [revision] = await db.insert(wispGrantRevisions).values({
      grantId: grant!.id, partnerId: opts.partnerId, revision: 1,
      ceilingSnapshot: snapshot(opts.orgIds), factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: revision!.id }).where(eq(wispGrants.id, grant!.id));
    return { grantId: grant!.id, revisionId: revision!.id };
  });
}

async function readGrant(grantId: string) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () => db.select().from(wispGrants).where(eq(wispGrants.id, grantId)).limit(1));
  return row!;
}

interface Tenant {
  partner: { id: string };
  org: { id: string };
  org2: { id: string };
  grantor: { id: string; email: string };
  admin: { id: string };
  grantorRoleId: string;
}

/** A partner with two orgs, a grantor (ai_sessions:use + devices:read + tickets:write, org_access all) and a partner admin. */
async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const org2 = await createOrganization({ partnerId: partner.id });
  const grantor = await createUser({ partnerId: partner.id, email: `wisp-grantor-${randomUUID()}@wisp.test` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, [
    { resource: 'ai_sessions', action: 'use' },
    { resource: 'devices', action: 'read' },
    { resource: 'tickets', action: 'write' },
  ]);
  await assignUserToPartner(grantor.id, partner.id, role.id, 'all');
  const admin = await createUser({ partnerId: partner.id, email: `wisp-admin-${randomUUID()}@wisp.test` });
  const adminRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(adminRole.id, [{ resource: '*', action: '*' }]);
  await assignUserToPartner(admin.id, partner.id, adminRole.id, 'all');
  return {
    partner: { id: partner.id }, org: { id: org.id }, org2: { id: org2.id },
    grantor: { id: grantor.id, email: grantor.email }, admin: { id: admin.id }, grantorRoleId: role.id,
  };
}

function grantorAuth(t: Tenant, sid: string): AuthContext {
  const orgIds = [t.org.id, t.org2.id];
  return {
    principal: { kind: 'user_session' },
    user: { id: t.grantor.id, email: t.grantor.email, name: 'Grantor', isPlatformAdmin: false },
    token: { sid, mfa: true } as never,
    partnerId: t.partner.id,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: orgIds,
    partnerOrgAccess: 'all',
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => orgIds.includes(id),
  } as AuthContext;
}

const asGrantor = <T>(t: Tenant, fn: () => Promise<T>) =>
  withDbAccessContext(partnerContext(t.partner.id, [t.org.id, t.org2.id], t.grantor.id), fn);

async function mintWispStepUp(t: Tenant, sid: string, orgId: string | null, ceilingHash: string): Promise<string> {
  const epochs = await userEpochs(t.grantor.id);
  const id = await mintStepUpGrant({
    userId: t.grantor.id, operation: 'wisp_grant', authEpoch: epochs.authEpoch, mfaEpoch: epochs.mfaEpoch, sid,
    resourceDigest: wispGrantResourceDigest({ grantorUserId: t.grantor.id, partnerId: t.partner.id, orgId, requestedCeilingHash: ceilingHash }),
  });
  if (!id) throw new Error('mintStepUpGrant returned null (is the test Redis up?)');
  return id;
}

// resolveGrantCeiling refuses every grant while Wisp is off; the suite runs with it on.
beforeEach(() => {
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe('wisp_grants RLS + ownership (2027-01-04-100100)', () => {
  it('cross-partner forge: partner B context inserting a grant with partner_id = A → 42501', async () => {
    const t = await seedTenant();
    const partnerB = await createPartner();
    await expectSqlState(() => withDbAccessContext(partnerContext(partnerB.id, [], t.grantor.id), () =>
      db.insert(wispGrants).values({ partnerId: t.partner.id, grantorUserId: t.grantor.id, expiresAt: new Date(Date.now() + 1e9) })), '42501');
  });

  it('non-grantor insert: partner A context with userId = admin inserting grantor_user_id = grantor → 42501', async () => {
    const t = await seedTenant();
    await expectSqlState(() => withDbAccessContext(partnerContext(t.partner.id, [t.org.id], t.admin.id), () =>
      db.insert(wispGrants).values({ partnerId: t.partner.id, grantorUserId: t.grantor.id, expiresAt: new Date(Date.now() + 1e9) })), '42501');
  });

  it('the grantor may insert their own grant in their partner context', async () => {
    const t = await seedTenant();
    const rows = await asGrantor(t, () =>
      db.insert(wispGrants).values({ partnerId: t.partner.id, grantorUserId: t.grantor.id, expiresAt: new Date(Date.now() + 1e9) }).returning({ id: wispGrants.id }));
    expect(rows).toHaveLength(1);
  });

  it('org of another partner: composite (org_id, partner_id) FK rejects → 23503', async () => {
    const t = await seedTenant();
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(wispGrants).values({ partnerId: t.partner.id, orgId: orgB.id, grantorUserId: t.grantor.id, expiresAt: new Date(Date.now() + 1e9) })), '23503');
  });

  it('a grantor of another partner: composite (grantor_user_id, partner_id) FK rejects → 23503', async () => {
    const t = await seedTenant();
    const partnerB = await createPartner();
    const outsider = await createUser({ partnerId: partnerB.id, email: `wisp-outsider-${randomUUID()}@wisp.test` });
    await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(wispGrants).values({ partnerId: t.partner.id, grantorUserId: outsider.id, expiresAt: new Date(Date.now() + 1e9) })), '23503');
  });

  it('second live grant for the same (grantor, scope) → 23505 on wisp_grants_one_live_per_scope_uq; a revoked one does not block', async () => {
    const t = await seedTenant();
    await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id] });
    await expectSqlState(() => seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id] }), '23505');
    // A different scope (org-scoped) is a different live slot.
    await expect(seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgId: t.org.id, orgIds: [t.org.id] })).resolves.toBeDefined();
    // A revoked grant leaves the slot free.
    const other = await seedTenant();
    await seedGrant({ partnerId: other.partner.id, grantorUserId: other.grantor.id, orgIds: [other.org.id], status: 'revoked' });
    await expect(seedGrant({ partnerId: other.partner.id, grantorUserId: other.grantor.id, orgIds: [other.org.id] })).resolves.toBeDefined();
  });

  it('partner admin (userId ≠ grantor) may UPDATE status → revoked', async () => {
    const t = await seedTenant();
    const { grantId } = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id] });
    await withDbAccessContext(partnerContext(t.partner.id, [t.org.id], t.admin.id), () =>
      db.update(wispGrants).set({ status: 'revoked', revokedAt: new Date(), revokedByUserId: t.admin.id }).where(eq(wispGrants.id, grantId)));
    expect((await readGrant(grantId)).status).toBe('revoked');
  });

  it('partner admin cannot widen: UPDATE expires_at / current_revision_id → 42501 from wisp_grants_update_guard', async () => {
    const t = await seedTenant();
    const { grantId } = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id] });
    const adminCtx = partnerContext(t.partner.id, [t.org.id], t.admin.id);
    await expectSqlState(() => withDbAccessContext(adminCtx, () =>
      db.update(wispGrants).set({ expiresAt: new Date(Date.now() + 365 * 86_400_000) }).where(eq(wispGrants.id, grantId))), '42501');
    await expectSqlState(() => withDbAccessContext(adminCtx, () =>
      db.update(wispGrants).set({ currentRevisionId: null }).where(eq(wispGrants.id, grantId))), '42501');
  });

  it('partner admin MAY update budget_cents_per_day and floor_tick_minutes (w00 A6); floor_tick_minutes 10 or 241 → 23514', async () => {
    const t = await seedTenant();
    const { grantId } = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id] });
    const adminCtx = partnerContext(t.partner.id, [t.org.id], t.admin.id);
    await withDbAccessContext(adminCtx, () =>
      db.update(wispGrants).set({ budgetCentsPerDay: 500, floorTickMinutes: 60 }).where(eq(wispGrants.id, grantId)));
    expect(await readGrant(grantId)).toMatchObject({ budgetCentsPerDay: 500, floorTickMinutes: 60 });
    for (const floorTickMinutes of [10, 241]) {
      await expectSqlState(() => withDbAccessContext(adminCtx, () =>
        db.update(wispGrants).set({ floorTickMinutes }).where(eq(wispGrants.id, grantId))), '23514');
    }
  });

  it('nobody can substitute the grantor: UPDATE grantor_user_id → 42501 (admin and system alike)', async () => {
    const t = await seedTenant();
    const { grantId } = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id] });
    await expectSqlState(() => withDbAccessContext(partnerContext(t.partner.id, [t.org.id], t.admin.id), () =>
      db.update(wispGrants).set({ grantorUserId: t.admin.id }).where(eq(wispGrants.id, grantId))), '42501');
    await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () =>
      db.update(wispGrants).set({ grantorUserId: t.admin.id }).where(eq(wispGrants.id, grantId))), '42501');
  });

  it('partner admin cannot resume: UPDATE status paused → active → 42501', async () => {
    const t = await seedTenant();
    const { grantId } = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id], status: 'paused', pausedReason: 'user_paused' });
    await expectSqlState(() => withDbAccessContext(partnerContext(t.partner.id, [t.org.id], t.admin.id), () =>
      db.update(wispGrants).set({ status: 'active', pausedReason: null, pausedAt: null }).where(eq(wispGrants.id, grantId))), '42501');
  });

  it('the grantor cannot relabel a system pause as user_paused, nor resume it directly → 42501', async () => {
    const t = await seedTenant();
    const { grantId } = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id], status: 'paused', pausedReason: 'budget_exhausted' });
    await expectSqlState(() => asGrantor(t, () =>
      db.update(wispGrants).set({ pausedReason: 'user_paused' }).where(eq(wispGrants.id, grantId))), '42501');
    await expectSqlState(() => asGrantor(t, () =>
      db.update(wispGrants).set({ status: 'active', pausedReason: null }).where(eq(wispGrants.id, grantId))), '42501');
  });

  it('a revoked grant cannot change status again → 42501', async () => {
    const t = await seedTenant();
    const { grantId } = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id], status: 'revoked' });
    await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () =>
      db.update(wispGrants).set({ status: 'active' }).where(eq(wispGrants.id, grantId))), '42501');
  });

  it('grants are revoked, never deleted by a user: DELETE in partner context → 42501', async () => {
    const t = await seedTenant();
    const { grantId } = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id] });
    await expectSqlState(() => asGrantor(t, () => db.delete(wispGrants).where(eq(wispGrants.id, grantId))), '42501');
  });

  it('revisions are append-only: UPDATE → 42501; DELETE as partner → 42501; system DELETE of the grant cascades the revisions', async () => {
    const t = await seedTenant();
    const { grantId, revisionId } = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id] });
    await expectSqlState(() => asGrantor(t, () =>
      db.update(wispGrantRevisions).set({ ceilingSnapshot: snapshot([t.org.id, t.org2.id]) }).where(eq(wispGrantRevisions.id, revisionId))), '42501');
    await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () =>
      db.update(wispGrantRevisions).set({ revision: 9 }).where(eq(wispGrantRevisions.id, revisionId))), '42501');
    await expectSqlState(() => asGrantor(t, () => db.delete(wispGrantRevisions).where(eq(wispGrantRevisions.id, revisionId))), '42501');
    await withDbAccessContext(SYSTEM_CTX, () => db.delete(wispGrants).where(eq(wispGrants.id, grantId)));
    const left = await withDbAccessContext(SYSTEM_CTX, () => db.select().from(wispGrantRevisions).where(eq(wispGrantRevisions.grantId, grantId)));
    expect(left).toEqual([]);
  });

  it('only the grantor appends a revision: partner admin INSERT → 42501', async () => {
    const t = await seedTenant();
    const { grantId } = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id] });
    await expectSqlState(() => withDbAccessContext(partnerContext(t.partner.id, [t.org.id], t.admin.id), () =>
      db.insert(wispGrantRevisions).values({
        grantId, partnerId: t.partner.id, revision: 2, ceilingSnapshot: snapshot([t.org.id]), factorProof: { method: 'x', verifiedAt: 'y' },
      })), '42501');
  });

  it('an org-scoped token cannot SELECT a grant of its own partner (partner-axis, no org branch)', async () => {
    const t = await seedTenant();
    await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgId: t.org.id, orgIds: [t.org.id] });
    const rows = await withDbAccessContext(orgContext(t.org.id, t.partner.id), () => db.select().from(wispGrants));
    expect(rows).toEqual([]);
    const revs = await withDbAccessContext(orgContext(t.org.id, t.partner.id), () => db.select().from(wispGrantRevisions));
    expect(revs).toEqual([]);
  });

  it('a run cannot pin a grant of another partner (ai_agent_runs_grant_tenant_guard → 23503)', async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const foreign = await seedGrant({ partnerId: other.partner.id, grantorUserId: other.grantor.id, orgIds: [other.org.id] });
    const [agent] = await withSystemDbAccessContext(() => db.insert(aiAgents).values({
      partnerId: t.partner.id, orgId: null, kind: 'triage', name: 'Triage', enabled: true, mode: 'shadow', model: null,
      toolAllowlist: [], protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      limits: {}, triggers: { alertSeverities: ['critical'] }, recipients: { userIds: [], roleIds: [] }, instructions: null,
      cooldownSeconds: 0, createdBy: t.admin.id,
    } as never).returning({ id: aiAgents.id }));
    await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () => db.insert(aiAgentRuns).values({
      agentId: agent!.id, orgId: t.org.id, triggerKind: 'manual', dedupeKey: `x:${randomUUID()}`, modeAtStart: 'shadow',
      policySnapshot: {} as never, status: 'queued', grantId: foreign.grantId, grantRevisionId: foreign.revisionId,
    } as never)), '23503');
  });
});

// ---------------------------------------------------------------------------

describe('grant lifecycle through the service (real step-up in test Redis)', () => {
  it('grantor creates (revision 1), refreshes (revision 2, revision 1 row byte-identical), revokes', async () => {
    const t = await seedTenant();
    const sid = randomUUID();
    const auth = grantorAuth(t, sid);
    const scope = { partnerId: t.partner.id, orgId: null };

    const preview = await asGrantor(t, () => previewGrantCeiling({ auth, scope }));
    expect(new Set(preview.ceilingSnapshot.orgIds)).toEqual(new Set([t.org.id, t.org2.id]));
    const created = await asGrantor(t, async () => createGrant({ auth, scope, stepUpGrantId: await mintWispStepUp(t, sid, null, preview.ceilingHash) }));
    expect(created).toMatchObject({ status: 'active', grantorUserId: t.grantor.id, budgetCentsPerDay: 200, floorTickMinutes: 30 });
    const [rev1Before] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(wispGrantRevisions).where(eq(wispGrantRevisions.id, created.currentRevisionId!)));
    expect(rev1Before).toMatchObject({ revision: 1 });
    expect(Object.keys(rev1Before!.factorProof).sort()).toEqual(['method', 'verifiedAt']);

    const refreshed = await asGrantor(t, async () =>
      refreshGrant({ auth, grantId: created.id, stepUpGrantId: await mintWispStepUp(t, sid, null, preview.ceilingHash) }));
    expect(refreshed.currentRevisionId).not.toBe(created.currentRevisionId);
    const revs = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(wispGrantRevisions).where(eq(wispGrantRevisions.grantId, created.id)));
    expect(revs.map((r) => r.revision).sort()).toEqual([1, 2]);
    const rev1After = revs.find((r) => r.revision === 1)!;
    expect(JSON.stringify(rev1After)).toBe(JSON.stringify(rev1Before));

    await asGrantor(t, () => revokeGrant({ auth, grantId: created.id }));
    expect(await readGrant(created.id)).toMatchObject({ status: 'revoked', revokedByUserId: t.grantor.id });
  });

  it('createGrant with a step-up minted for a different requestedCeilingHash → step_up_required and no row', async () => {
    const t = await seedTenant();
    const sid = randomUUID();
    const auth = grantorAuth(t, sid);
    const stepUp = await mintWispStepUp(t, sid, null, 'f'.repeat(64));
    await expect(asGrantor(t, () => createGrant({ auth, scope: { partnerId: t.partner.id, orgId: null }, stepUpGrantId: stepUp })))
      .rejects.toMatchObject({ code: 'step_up_required' });
    const rows = await withDbAccessContext(SYSTEM_CTX, () => db.select().from(wispGrants).where(eq(wispGrants.partnerId, t.partner.id)));
    expect(rows).toEqual([]);
  });

  it('resolveGrantCeiling after the grantor role loses tickets:write drops the key from permissionKeys without pausing', async () => {
    // A snapshot that pins tickets:write, so its live removal is observable.
    const other = await seedTenant();
    const pinned = await withDbAccessContext(SYSTEM_CTX, async () => {
      const [g] = await db.insert(wispGrants).values({ partnerId: other.partner.id, grantorUserId: other.grantor.id, expiresAt: new Date(Date.now() + 1e9) }).returning({ id: wispGrants.id });
      const [r] = await db.insert(wispGrantRevisions).values({
        grantId: g!.id, partnerId: other.partner.id, revision: 1,
        ceilingSnapshot: snapshot([other.org.id], ['ai_sessions:use', 'devices:read', 'tickets:write']),
        factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
      }).returning({ id: wispGrantRevisions.id });
      await db.update(wispGrants).set({ currentRevisionId: r!.id }).where(eq(wispGrants.id, g!.id));
      return { grantId: g!.id, revisionId: r!.id };
    });
    expect((await resolveGrantCeiling(pinned.grantId, pinned.revisionId)).permissionKeys.has('tickets:write')).toBe(true);
    const [ticketsWrite] = await getTestDb().select({ id: permissions.id }).from(permissions)
      .where(and(eq(permissions.resource, 'tickets'), eq(permissions.action, 'write'))).limit(1);
    await getTestDb().delete(rolePermissions).where(and(eq(rolePermissions.roleId, other.grantorRoleId), eq(rolePermissions.permissionId, ticketsWrite!.id)));
    const after = await resolveGrantCeiling(pinned.grantId, pinned.revisionId);
    expect(after.permissionKeys.has('tickets:write')).toBe(false);
    expect(after.permissionKeys.has('devices:read')).toBe(true);
    expect((await readGrant(pinned.grantId)).status).toBe('active');
  });

  it('reconcileGrantsForUser pauses with grantor_suspended after users.status = disabled, and resumes after re-activation', async () => {
    const t = await seedTenant();
    const { grantId } = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id] });

    await getTestDb().update(users).set({ status: 'disabled' }).where(eq(users.id, t.grantor.id));
    expect(await reconcileGrantsForUser(t.grantor.id)).toMatchObject({ paused: 1 });
    expect(await readGrant(grantId)).toMatchObject({ status: 'paused', pausedReason: 'grantor_suspended' });

    await getTestDb().update(users).set({ status: 'active' }).where(eq(users.id, t.grantor.id));
    expect(await reconcileGrantsForUser(t.grantor.id)).toMatchObject({ resumed: 1 });
    expect(await readGrant(grantId)).toMatchObject({ status: 'active', pausedReason: null });
  });

  it('reconcileActiveGrants expires a grant whose expires_at passed, and never resumes a user_paused grant', async () => {
    const t = await seedTenant();
    const expired = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id], expiresAt: new Date(Date.now() - 60_000) });
    const userPaused = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgId: t.org.id, orgIds: [t.org.id], status: 'paused', pausedReason: 'user_paused' });
    const out = await reconcileActiveGrants(new Date());
    expect(out.expired).toBeGreaterThanOrEqual(1);
    expect((await readGrant(expired.grantId)).status).toBe('expired');
    expect(await readGrant(userPaused.grantId)).toMatchObject({ status: 'paused', pausedReason: 'user_paused' });
  });
});

describe('grant service edge cases against real Postgres', () => {
  it('a grantor narrowed to selected-with-no-orgs is PAUSED, even though the hidden Quick Support org is still "reachable"', async () => {
    const t = await seedTenant();
    await createOrganization({ partnerId: t.partner.id, type: 'quick_support' });
    const { grantId, revisionId } = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id, t.org2.id] });
    await getTestDb().update(partnerUsers).set({ orgAccess: 'selected', orgIds: [] }).where(eq(partnerUsers.userId, t.grantor.id));
    await expect(resolveGrantCeiling(grantId, revisionId)).rejects.toMatchObject({ kind: 'paused' });
    expect(await reconcileGrantsForUser(t.grantor.id)).toMatchObject({ paused: 1 });
    expect(await readGrant(grantId)).toMatchObject({ status: 'paused', pausedReason: 'grantor_access_lost' });
  });

  it('a partner-wide preview never pins the Quick Support org', async () => {
    const t = await seedTenant();
    const qs = await createOrganization({ partnerId: t.partner.id, type: 'quick_support' });
    const preview = await asGrantor(t, () => previewGrantCeiling({ auth: grantorAuth(t, randomUUID()), scope: { partnerId: t.partner.id, orgId: null } }));
    expect(preview.ceilingSnapshot.orgIds).not.toContain(qs.id);
    expect(preview.ceilingSnapshot.partnerWide).toBe(true);
  });

  it('two concurrent createGrant calls for the same scope: exactly one succeeds, the other is already_active', async () => {
    const t = await seedTenant();
    const sid = randomUUID();
    const auth = grantorAuth(t, sid);
    const scope = { partnerId: t.partner.id, orgId: null };
    const preview = await asGrantor(t, () => previewGrantCeiling({ auth, scope }));
    const [a, b] = [await mintWispStepUp(t, sid, null, preview.ceilingHash), await mintWispStepUp(t, sid, null, preview.ceilingHash)];
    const results = await Promise.allSettled([
      asGrantor(t, () => createGrant({ auth, scope, stepUpGrantId: a })),
      asGrantor(t, () => createGrant({ auth, scope, stepUpGrantId: b })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'already_active' });
    const live = await withDbAccessContext(SYSTEM_CTX, () => db.select().from(wispGrants).where(eq(wispGrants.partnerId, t.partner.id)));
    expect(live).toHaveLength(1);
  });

  it('a *:* partner admin is a valid grantor, and the ceiling honours the wildcard', async () => {
    const t = await seedTenant();
    const sid = randomUUID();
    const admin = (await getTestDb().select().from(users).where(eq(users.id, t.admin.id)).limit(1))[0]!;
    const auth = { ...grantorAuth(t, sid), user: { id: admin.id, email: admin.email, name: 'Admin', isPlatformAdmin: false } } as AuthContext;
    const adminCtx = partnerContext(t.partner.id, [t.org.id, t.org2.id], admin.id);
    const scope = { partnerId: t.partner.id, orgId: null };
    const preview = await withDbAccessContext(adminCtx, () => previewGrantCeiling({ auth, scope }));
    expect(preview.ceilingSnapshot.permissionKeys).toEqual(['*:*']);
    const epochs = await userEpochs(admin.id);
    const stepUp = await mintStepUpGrant({
      userId: admin.id, operation: 'wisp_grant', authEpoch: epochs.authEpoch, mfaEpoch: epochs.mfaEpoch, sid,
      resourceDigest: wispGrantResourceDigest({ grantorUserId: admin.id, partnerId: t.partner.id, orgId: null, requestedCeilingHash: preview.ceilingHash }),
    });
    const created = await withDbAccessContext(adminCtx, () => createGrant({ auth, scope, stepUpGrantId: stepUp! }));
    const ceiling = await resolveGrantCeiling(created.id, created.currentRevisionId!);
    expect(ceiling.permissionKeys.has('*:*')).toBe(true);
    expect(() => assertWithinCeiling(ceiling, { permission: 'scripts:execute', orgId: t.org.id })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('W01 entitlement wiring through the real resolver (A21, fail closed)', () => {
  const setWisp = (partnerId: string, state: 'enabled' | 'disabled', limits: { maxGrants: number; budgetCentsPerDayCeiling: number; minFloorTickMinutes: number } | null) =>
    upsertEntitlementRow({ partnerId, featureKey: 'wisp', source: 'manual', state, limits, expiresAt: null, reason: 'wisp W02 integration', updatedBy: null });

  async function createScoped(t: Tenant, sid: string, orgId: string | null) {
    const auth = grantorAuth(t, sid);
    const scope = { partnerId: t.partner.id, orgId };
    const preview = await asGrantor(t, () => previewGrantCeiling({ auth, scope }));
    return asGrantor(t, async () => createGrant({ auth, scope, stepUpGrantId: await mintWispStepUp(t, sid, orgId, preview.ceilingHash) }));
  }

  const grantsOf = (partnerId: string) =>
    withDbAccessContext(SYSTEM_CTX, () => db.select().from(wispGrants).where(eq(wispGrants.partnerId, partnerId)));

  it('enforces the partner\'s maxGrants from partner_entitlements: the second live grant → GrantLimitReachedError, no row', async () => {
    const t = await seedTenant();
    await setWisp(t.partner.id, 'enabled', { maxGrants: 1, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 });
    const sid = randomUUID();
    await createScoped(t, sid, null);
    const err = await createScoped(t, sid, t.org.id).catch((e) => e);
    expect(err).toBeInstanceOf(GrantLimitReachedError);
    expect(err).toMatchObject({ maxGrants: 1, active: 1 });
    expect(await grantsOf(t.partner.id)).toHaveLength(1);
  });

  it('the plan default applies with no row: a pro partner is enabled and capped at 25, so a create succeeds', async () => {
    const t = await seedTenant();
    await expect(createScoped(t, randomUUID(), null)).resolves.toMatchObject({ status: 'active' });
  });

  it('a disabled wisp entitlement refuses creation (entitlement_required); the existing grant stays active and still refreshes', async () => {
    const t = await seedTenant();
    const sid = randomUUID();
    const existing = await createScoped(t, sid, null);
    await setWisp(t.partner.id, 'disabled', null);

    const err = await createScoped(t, sid, t.org.id).catch((e) => e);
    expect(err).toBeInstanceOf(WispGrantError);
    expect(err).toMatchObject({ code: 'entitlement_required' });
    expect((await grantsOf(t.partner.id)).map((g) => g.id)).toEqual([existing.id]);

    const auth = grantorAuth(t, sid);
    const preview = await asGrantor(t, () => previewGrantCeiling({ auth, scope: { partnerId: t.partner.id, orgId: null } }));
    const refreshed = await asGrantor(t, async () =>
      refreshGrant({ auth, grantId: existing.id, stepUpGrantId: await mintWispStepUp(t, sid, null, preview.ceilingHash) }));
    expect(refreshed).toMatchObject({ id: existing.id, status: 'active' });
    expect(refreshed.currentRevisionId).not.toBe(existing.currentRevisionId);
  });

  it('a free-plan partner (wisp default-disabled, no row) cannot create a grant', async () => {
    const t = await seedTenant();
    await withSystemDbAccessContext(() => db.update(partners).set({ plan: 'free' }).where(eq(partners.id, t.partner.id)));
    invalidateEntitlementCache(t.partner.id);
    await expect(createScoped(t, randomUUID(), null)).rejects.toMatchObject({ code: 'entitlement_required' });
    expect(await grantsOf(t.partner.id)).toHaveLength(0);
  });
});

describe('run admission under a grant (Wisp design §4.3, §4.5)', () => {
  beforeEach(() => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
    registerAgentRunEnqueuer(async (runId) => ({ enqueued: true, jobId: `agent-run:${runId}` }));
  });
  afterEach(() => {
    registerAgentRunEnqueuer(null);
  });

  async function seedAgentAndDevice(t: Tenant): Promise<{ deviceId: string }> {
    const site = await createSite({ orgId: t.org.id });
    const unique = randomUUID().slice(0, 8);
    const [device] = await withSystemDbAccessContext(() => db.insert(devices).values({
      orgId: t.org.id, siteId: site.id, agentId: `wisp-agent-${unique}`, hostname: `wisp-host-${unique}`,
      osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
    }).returning({ id: devices.id }));
    await withSystemDbAccessContext(() => db.insert(aiAgents).values({
      partnerId: t.partner.id, orgId: null, kind: 'triage', name: 'Wisp Triage', enabled: true, mode: 'shadow', model: null,
      toolAllowlist: ['query_devices', 'manage_ai_agents'],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
      triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
      recipients: { userIds: [], roleIds: [] }, instructions: null, cooldownSeconds: 0, createdBy: t.admin.id,
    } as never));
    return { deviceId: device!.id };
  }

  it('a run admitted under the grant carries grant_id/grant_revision_id and the intersected allowlist; a same-grant child is admitted; another grant throws GrantDepthExceededError', async () => {
    const t = await seedTenant();
    const { deviceId } = await seedAgentAndDevice(t);
    const g1 = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id] });

    const first = await createAndEnqueueAgentRun({
      orgId: t.org.id, kind: 'triage', triggerKind: 'manual', deviceId, dedupeKey: `manual:${randomUUID()}`,
      grant: { grantId: g1.grantId, grantRevisionId: g1.revisionId },
    });
    if (!first.created) throw new Error(`expected admission, got ${first.skipped}`);
    const [row] = await withSystemDbAccessContext(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, first.run.id)));
    expect(row).toMatchObject({ grantId: g1.grantId, grantRevisionId: g1.revisionId });
    // manage_ai_agents is AGENT_HUMAN_ONLY — never delegable.
    expect(row!.policySnapshot.effective.toolAllowlist).toEqual(['query_devices']);

    const child = await createAndEnqueueAgentRun({
      orgId: t.org.id, kind: 'triage', triggerKind: 'manual', deviceId, dedupeKey: `manual:${randomUUID()}`,
      grant: { grantId: g1.grantId, grantRevisionId: g1.revisionId, requestedByRunId: first.run.id },
    });
    expect(child.created).toBe(true);

    const g2 = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgId: t.org.id, orgIds: [t.org.id] });
    await expect(createAndEnqueueAgentRun({
      orgId: t.org.id, kind: 'triage', triggerKind: 'manual', deviceId, dedupeKey: `manual:${randomUUID()}`,
      grant: { grantId: g2.grantId, grantRevisionId: g2.revisionId, requestedByRunId: first.run.id },
    })).rejects.toBeInstanceOf(GrantDepthExceededError);
  });

  it('a revoked grant skips grant_inactive and writes no run', async () => {
    const t = await seedTenant();
    const { deviceId } = await seedAgentAndDevice(t);
    const g = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id], status: 'revoked' });
    await expect(createAndEnqueueAgentRun({
      orgId: t.org.id, kind: 'triage', triggerKind: 'manual', deviceId, dedupeKey: `manual:${randomUUID()}`,
      grant: { grantId: g.grantId, grantRevisionId: g.revisionId },
    })).resolves.toEqual({ created: false, skipped: 'grant_inactive' });
    const runs = await withSystemDbAccessContext(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.orgId, t.org.id)));
    expect(runs).toEqual([]);
  });

  async function admitUnderGrant(t: Tenant, deviceId: string, g: { grantId: string; revisionId: string }) {
    const r = await createAndEnqueueAgentRun({
      orgId: t.org.id, kind: 'triage', triggerKind: 'manual', deviceId, dedupeKey: `manual:${randomUUID()}`,
      grant: { grantId: g.grantId, grantRevisionId: g.revisionId },
    });
    if (!r.created) throw new Error(`expected admission, got ${r.skipped}`);
    return r.run;
  }

  it('the grant pin is immutable after admission: clearing it → 42501 (ai_agent_runs_grant_tenant_guard)', async () => {
    const t = await seedTenant();
    const { deviceId } = await seedAgentAndDevice(t);
    const g = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id] });
    const run = await admitUnderGrant(t, deviceId, g);
    await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () =>
      db.update(aiAgentRuns).set({ grantId: null, grantRevisionId: null }).where(eq(aiAgentRuns.id, run.id))), '42501');
  });

  it('release under the real ceiling: paused → grant_inactive; revoked → grant_ended; org left the ceiling → grant_ceiling_violation(org)', async () => {
    const t = await seedTenant();
    const { deviceId } = await seedAgentAndDevice(t);
    const g = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id, t.org2.id] });
    const run = await admitUnderGrant(t, deviceId, g);
    const intent = {
      id: randomUUID(), orgId: t.org.id, partnerId: t.partner.id, requestingAgentRunId: run.id,
      originPrincipalKind: 'ai_agent', originPrincipalId: run.agentId, source: 'ai_agent',
      actionName: 'query_devices', arguments: {}, riskTier: 3, scopeKind: null, scopeDeviceId: null, scopeTicketId: null,
    } as unknown as ActionIntent;

    // The org leaves the grantor's live reach (still has org2, so not a pause).
    await getTestDb().update(partnerUsers).set({ orgAccess: 'selected', orgIds: [t.org2.id] }).where(eq(partnerUsers.userId, t.grantor.id));
    await expect(checkAgentReleaseAuthority(intent)).resolves.toMatchObject({ ok: false, errorCode: 'grant_ceiling_violation', details: { code: 'org' } });
    await getTestDb().update(partnerUsers).set({ orgAccess: 'all', orgIds: null }).where(eq(partnerUsers.userId, t.grantor.id));

    await withDbAccessContext(SYSTEM_CTX, () => db.update(wispGrants).set({ status: 'paused', pausedReason: 'user_paused', pausedAt: new Date() }).where(eq(wispGrants.id, g.grantId)));
    await expect(checkAgentReleaseAuthority(intent)).resolves.toMatchObject({ ok: false, errorCode: 'grant_inactive' });

    await withDbAccessContext(SYSTEM_CTX, () => db.update(wispGrants).set({ status: 'revoked', pausedReason: null, revokedAt: new Date() }).where(eq(wispGrants.id, g.grantId)));
    await expect(checkAgentReleaseAuthority(intent)).resolves.toMatchObject({ ok: false, errorCode: 'grant_ended' });
  });
});

// ---------------------------------------------------------------------------
// Erasure: the grants ↔ revisions FK cycle is broken for the partner-axis sweep
// (wisp_grants_current_revision_fk ON DELETE SET NULL (current_revision_id),
// CASCADE_ORDER_SET_NULL_EDGE_BREAKS), and the org cascade reaches org-scoped
// grants after the runs that pin them.
// ---------------------------------------------------------------------------

describe('erasure with grants present', () => {
  it('cascadeDeleteOrg removes the org\'s org-scoped grant (and its revisions), keeps the partner-wide grant', async () => {
    const t = await seedTenant();
    const orgScoped = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgId: t.org.id, orgIds: [t.org.id] });
    const partnerWide = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id, t.org2.id] });
    const stats = await cascadeDeleteOrg(t.org.id, t.admin.id);
    expect(stats.tablesDeleted.wisp_grants).toBe(1);
    const left = await withDbAccessContext(SYSTEM_CTX, () => db.select({ id: wispGrants.id }).from(wispGrants).where(eq(wispGrants.partnerId, t.partner.id)));
    expect(left.map((r) => r.id)).toEqual([partnerWide.grantId]);
    const revs = await withDbAccessContext(SYSTEM_CTX, () => db.select().from(wispGrantRevisions).where(eq(wispGrantRevisions.grantId, orgScoped.grantId)));
    expect(revs).toEqual([]);
  });

  it('cascadeDeleteOrg succeeds with a run pinned to the org-scoped grant (runs go before the grant; no FK blocks erasure)', async () => {
    const t = await seedTenant();
    const g = await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgId: t.org.id, orgIds: [t.org.id] });
    const [agent] = await withSystemDbAccessContext(() => db.insert(aiAgents).values({
      partnerId: t.partner.id, orgId: null, kind: 'triage', name: 'Triage', enabled: true, mode: 'shadow', model: null,
      toolAllowlist: [], protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      limits: {}, triggers: { alertSeverities: ['critical'] }, recipients: { userIds: [], roleIds: [] }, instructions: null,
      cooldownSeconds: 0, createdBy: t.admin.id,
    } as never).returning({ id: aiAgents.id }));
    await withDbAccessContext(SYSTEM_CTX, () => db.insert(aiAgentRuns).values({
      agentId: agent!.id, orgId: t.org.id, triggerKind: 'manual', dedupeKey: `x:${randomUUID()}`, modeAtStart: 'shadow',
      policySnapshot: {} as never, status: 'completed', grantId: g.grantId, grantRevisionId: g.revisionId,
    } as never));
    await expect(cascadeDeleteOrg(t.org.id, t.admin.id)).resolves.toBeDefined();
    const left = await withDbAccessContext(SYSTEM_CTX, () => db.select().from(wispGrants).where(eq(wispGrants.id, g.grantId)));
    expect(left).toEqual([]);
  });

  it('cascadeDeletePartner erases grants and revisions without tripping the FK cycle', async () => {
    const t = await seedTenant();
    await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgIds: [t.org.id] });
    await seedGrant({ partnerId: t.partner.id, grantorUserId: t.grantor.id, orgId: t.org2.id, orgIds: [t.org2.id] });
    await expect(cascadeDeletePartner(t.partner.id, randomUUID())).resolves.toBeDefined();
    const grantsLeft = await withDbAccessContext(SYSTEM_CTX, () => db.select().from(wispGrants).where(eq(wispGrants.partnerId, t.partner.id)));
    const revsLeft = await withDbAccessContext(SYSTEM_CTX, () => db.select().from(wispGrantRevisions).where(eq(wispGrantRevisions.partnerId, t.partner.id)));
    expect(grantsLeft).toEqual([]);
    expect(revsLeft).toEqual([]);
  });
});
