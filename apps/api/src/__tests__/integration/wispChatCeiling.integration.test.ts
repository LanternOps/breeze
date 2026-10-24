/**
 * Wisp W04 Task 4 — the delegation ceiling on a CHAT tool call, against real
 * Postgres (resolveGrantCeiling reads the grant, its pinned revision and the
 * grantor's LIVE partner + org memberships).
 *
 * Partner P with orgs A and B; grantor U is a partner technician (org_access
 * 'all') whose partner role reaches both. Grant G is scoped to org A. The chat
 * gate (`enforceWispCeiling`, wired into `createSessionPreToolUse`) must keep a
 * Wisp turn inside G even though U's own session could reach B, refuse the
 * next call once G is revoked, and follow U's org-level membership in A
 * (org-axis precedence) the moment it narrows.
 *
 * Placement is load-bearing: `src/__tests__/integration/**` +
 * `.integration.test.ts` puts it in the blocking Integration Tests job.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiSessions, wispGrantRevisions, wispGrants } from '../../db/schema';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import {
  enforceWispCeiling,
  lookupWispGrant,
  WISP_REFUSAL_MESSAGES,
  type WispSessionGrant,
} from '../../services/wisp/chatCeiling';
import { attachSession, getOrCreateThread } from '../../services/wisp/threads';
import { createSessionPreToolUse } from '../../services/aiAgentSdk';
import type { ActiveSession } from '../../services/streamingSessionManager';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';

// The per-tool rate limiter is Redis-backed and not what this suite measures.
vi.mock('../../services/aiGuardrails', async (orig) => ({
  ...(await orig<typeof import('../../services/aiGuardrails')>()),
  checkToolRateLimit: vi.fn(async () => null),
}));

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};

const BROAD_KEYS = ['ai_sessions:use', 'devices:read', 'devices:execute'];

beforeEach(() => {
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const perm = (key: string) => {
  const [resource, action] = key.split(':') as [string, string];
  return { resource, action };
};

async function seed(options: { grantOrg: 'A' | 'partner' } = { grantOrg: 'A' }) {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const grantor = await createUser({ partnerId: partner.id, email: `wisp-chat-${randomUUID()}@wisp.test` });
  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, BROAD_KEYS.map(perm));
  await assignUserToPartner(grantor.id, partner.id, partnerRole.id, 'all');

  const scopeOrgId = options.grantOrg === 'A' ? orgA.id : null;
  const snapshot: WispCeilingSnapshot = {
    version: 1,
    permissionKeys: BROAD_KEYS,
    orgIds: options.grantOrg === 'A' ? [orgA.id] : [orgA.id, orgB.id],
    siteIds: null,
    toolAllowlist: null,
    deniedTools: [],
    partnerWide: options.grantOrg !== 'A',
  };
  const pinned = await withDbAccessContext(SYSTEM_CTX, async () => {
    const [g] = await db.insert(wispGrants).values({
      partnerId: partner.id, orgId: scopeOrgId, grantorUserId: grantor.id,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    }).returning({ id: wispGrants.id });
    const [r] = await db.insert(wispGrantRevisions).values({
      grantId: g!.id, partnerId: partner.id, revision: 1, ceilingSnapshot: snapshot,
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: r!.id }).where(eq(wispGrants.id, g!.id));
    return { grantId: g!.id, revisionId: r!.id };
  });

  // The chat session row, pinned to G and linked to G's thread (as createSession does).
  const sessionId = await withDbAccessContext(SYSTEM_CTX, async () => {
    const [s] = await db.insert(aiSessions).values({
      orgId: orgA.id, userId: grantor.id, model: 'claude-sonnet-5-5',
      wispGrantId: pinned.grantId, wispGrantRevisionId: pinned.revisionId,
    }).returning({ id: aiSessions.id });
    return s!.id;
  });

  // U's own reach, built the way aiSessionLiveAuthority builds a partner session's.
  const toolAuth = {
    user: { id: grantor.id, email: grantor.email, name: 'Grantor', isPlatformAdmin: false },
    token: null,
    partnerId: partner.id,
    orgId: null,
    scope: 'partner',
    partnerOrgAccess: 'all',
    accessibleOrgIds: [orgA.id, orgB.id],
    ...buildOrgAccessClosures([orgA.id, orgB.id]),
  } as AuthContext;

  return { partner, orgA, orgB, grantor, pinned, sessionId, toolAuth };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function linkThread(t: Seeded): Promise<WispSessionGrant> {
  const thread = await getOrCreateThread(t.pinned.grantId);
  await attachSession(thread.id, t.sessionId);
  return { grantId: t.pinned.grantId, revisionId: t.pinned.revisionId, threadId: thread.id };
}

function chatSession(t: Seeded, wispGrant: WispSessionGrant | null): ActiveSession {
  return {
    breezeSessionId: t.sessionId,
    orgId: t.orgA.id,
    deviceId: null,
    auth: t.toolAuth,
    toolAuth: t.toolAuth,
    wispGrant,
    auditSnapshot: null,
    allowedTools: undefined,
    tenantTools: new Map(),
    approvalMode: 'per_step',
    isPaused: false,
    activePlanId: null,
    approvedPlanSteps: new Map(),
    currentPlanStepIndex: 0,
    toolUseIdQueue: [],
    eventBus: { publish: vi.fn() },
    abortController: new AbortController(),
  } as unknown as ActiveSession;
}

const deviceRead = (orgId?: string) => ({ deviceId: randomUUID(), ...(orgId ? { orgId } : {}) });

describe('enforceWispCeiling — a chat tool call stays inside the grant (real Postgres)', () => {
  it('under grant G, a Tier-1 read targeting org B is refused with wisp_outside_ceiling/org', async () => {
    const t = await seed();
    const grant = await linkThread(t);
    const r = await enforceWispCeiling({
      grant, toolName: 'get_device_details', input: deviceRead(t.orgB.id),
      sessionOrgId: t.orgA.id, sessionId: t.sessionId, toolAuth: t.toolAuth,
    });
    expect(r).toMatchObject({ ok: false, refusal: { code: 'wisp_outside_ceiling', detail: 'org' } });
  });

  it('the same user without a grant keeps the ungated path: createSessionPreToolUse never consults the ceiling and allows the read', async () => {
    const t = await seed();
    const pre = createSessionPreToolUse(chatSession(t, null));
    const r = await pre('get_device_details', deviceRead(t.orgB.id));
    expect(r).toEqual({ allowed: true });
  });

  it('under grant G, a Tier-1 read inside the ceiling is allowed and toolAuth.accessibleOrgIds === [orgA]', async () => {
    const t = await seed();
    const grant = await linkThread(t);
    const r = await enforceWispCeiling({
      grant, toolName: 'get_device_details', input: deviceRead(),
      sessionOrgId: t.orgA.id, sessionId: t.sessionId, toolAuth: t.toolAuth,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.toolAuth.accessibleOrgIds).toEqual([t.orgA.id]);
    expect(r.toolAuth.canAccessOrg(t.orgB.id)).toBe(false);
    // An org-scoped grant never carries partner breadth.
    expect(r.toolAuth.partnerOrgAccess).toBe('selected');
    expect(r.toolAuth.wispGrant).toEqual({ grantId: t.pinned.grantId, grantRevisionId: t.pinned.revisionId, sessionId: t.sessionId });

    // Through the real chat gate: B refused with the user-visible reason, A allowed under the narrowed auth.
    const pre = createSessionPreToolUse(chatSession(t, grant));
    await expect(pre('get_device_details', deviceRead(t.orgB.id))).resolves.toEqual({ allowed: false, error: WISP_REFUSAL_MESSAGES.org });
    const allowed = await pre('get_device_details', deviceRead());
    expect(allowed).toMatchObject({ allowed: true });
    expect(allowed.allowed && allowed.toolAuth?.accessibleOrgIds).toEqual([t.orgA.id]);
  });

  it('revoking G (status revoked) makes the next call refuse with wisp_grant_inactive', async () => {
    const t = await seed();
    const grant = await linkThread(t);
    const pre = createSessionPreToolUse(chatSession(t, grant));
    await expect(pre('get_device_details', deviceRead())).resolves.toMatchObject({ allowed: true });

    await withDbAccessContext(SYSTEM_CTX, () =>
      db.update(wispGrants).set({ status: 'revoked', revokedAt: new Date() }).where(eq(wispGrants.id, t.pinned.grantId)));

    const r = await enforceWispCeiling({
      grant, toolName: 'get_device_details', input: deviceRead(),
      sessionOrgId: t.orgA.id, sessionId: t.sessionId, toolAuth: t.toolAuth,
    });
    expect(r).toMatchObject({ ok: false, refusal: { code: 'wisp_grant_inactive', detail: 'inactive' } });
    await expect(pre('get_device_details', deviceRead())).resolves.toEqual({ allowed: false, error: WISP_REFUSAL_MESSAGES.inactive });
  });

  it("narrowing the grantor's org-level membership in org A refuses the next Tier-1 call in org A with wisp_outside_ceiling/permission", async () => {
    // Partner-wide grant: org B (no membership) is the control.
    const t = await seed({ grantOrg: 'partner' });
    const grant = await linkThread(t);
    const pre = createSessionPreToolUse(chatSession(t, grant));
    await expect(pre('get_device_details', deviceRead())).resolves.toMatchObject({ allowed: true });

    // U gets an org-A role that can still use AI but cannot read devices.
    const narrowRole = await createRole({ scope: 'organization', orgId: t.orgA.id });
    await grantRolePermissions(narrowRole.id, [perm('ai_sessions:use'), perm('alerts:read')]);
    await assignUserToOrganization(t.grantor.id, t.orgA.id, narrowRole.id);

    const r = await enforceWispCeiling({
      grant, toolName: 'get_device_details', input: deviceRead(),
      sessionOrgId: t.orgA.id, sessionId: t.sessionId, toolAuth: t.toolAuth,
    });
    expect(r).toMatchObject({ ok: false, refusal: { code: 'wisp_outside_ceiling', detail: 'permission' } });
    await expect(pre('get_device_details', deviceRead())).resolves.toEqual({ allowed: false, error: WISP_REFUSAL_MESSAGES.permission });

    // Org B keeps the partner-axis term — and org A is out of that call's reach.
    const inB = await enforceWispCeiling({
      grant, toolName: 'get_device_details', input: deviceRead(t.orgB.id),
      sessionOrgId: t.orgA.id, sessionId: t.sessionId, toolAuth: t.toolAuth,
    });
    expect(inB.ok).toBe(true);
    expect(inB.ok && inB.toolAuth.accessibleOrgIds).toEqual([t.orgB.id]);
    expect(inB.ok && inB.toolAuth.partnerOrgAccess).toBe('selected');
  });
});

describe('lookupWispGrant — the session row decides, and an unlinked pin fails closed (real Postgres)', () => {
  it('returns the pinned grant and thread for a linked session, null for an ordinary one', async () => {
    const t = await seed();
    await expect(lookupWispGrant(t.sessionId)).rejects.toMatchObject({ code: 'wisp_session_unavailable', reason: 'thread_unlinked' });
    const grant = await linkThread(t);
    await expect(lookupWispGrant(t.sessionId)).resolves.toEqual(grant);

    const plainId = await withDbAccessContext(SYSTEM_CTX, async () => {
      const [s] = await db.insert(aiSessions).values({ orgId: t.orgA.id, userId: t.grantor.id, model: 'claude-sonnet-5-5' })
        .returning({ id: aiSessions.id });
      return s!.id;
    });
    await expect(lookupWispGrant(plainId)).resolves.toBeNull();
    await expect(lookupWispGrant(randomUUID())).rejects.toMatchObject({ reason: 'session_not_found' });
  });
});
