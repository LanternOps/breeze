/**
 * #4342 W4 — the transcript-retention previews under a REAL request DB context
 * (`breeze_app` pool, forced RLS). The route unit tests mock `db`; these pin
 * what only Postgres can show: a partner preview counts only the partner's
 * visible orgs (never another partner's, never an org outside a restricted
 * token), skips an org whose own window is tighter, and an org token cannot
 * aim the org preview at another org.
 */
import './setup';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { inArray } from 'drizzle-orm';

type TestAuth = {
  scope: 'organization' | 'partner';
  orgId: string | null;
  partnerId: string | null;
  accessibleOrgIds: string[];
  userId: string;
};
const current = vi.hoisted(() => ({ auth: null as TestAuth | null }));

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const { withDbAccessContext: withCtx } = await import('../../db');
  const { inArray: inArr } = await import('drizzle-orm');
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => {
      const a = current.auth!;
      c.set('auth', {
        scope: a.scope,
        orgId: a.orgId,
        partnerId: a.partnerId,
        accessibleOrgIds: a.accessibleOrgIds,
        user: { id: a.userId, email: 'preview@data.test' },
        token: { mfa: true },
        canAccessOrg: (orgId: string) => a.accessibleOrgIds.includes(orgId),
        orgCondition: (col: any) => inArr(col, a.accessibleOrgIds),
      });
      return withCtx(
        actual.buildDbAccessContext({
          scope: a.scope,
          orgId: a.orgId,
          accessibleOrgIds: a.accessibleOrgIds,
          partnerId: a.partnerId,
          userId: a.userId,
        }),
        () => next(),
      );
    },
    requirePermission: () => (_c: any, next: any) => next(),
    requireMfa: () => (_c: any, next: any) => next(),
  };
});

import { aiDataPolicies, aiSessions } from '../../db/schema';
import { aiDataPolicyRoutes } from '../../routes/ai/dataPolicy';
import { partnerAiDataPolicyRoutes } from '../../routes/partnerAiDataPolicy';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const DAY_MS = 24 * 60 * 60 * 1000;
const old = new Date(Date.now() - 400 * DAY_MS);

const app = () => {
  const h = new Hono();
  h.route('/ai', aiDataPolicyRoutes);
  h.route('/partner/ai/data-policy', partnerAiDataPolicyRoutes);
  return h;
};

async function eligibleSessions(orgId: string, n: number) {
  await getTestDb().insert(aiSessions).values(
    Array.from({ length: n }, () => ({
      orgId, model: 'claude-test', status: 'closed' as const, createdAt: old, lastActivityAt: old, updatedAt: old,
    })),
  );
}

describe('transcript-retention previews under a real request DB context', () => {
  let p1: string;
  let p2: string;
  let o1: string;
  let o1b: string;
  let o1c: string;
  let o2: string;
  let userId: string;

  beforeEach(async () => {
    p1 = (await createPartner()).id;
    p2 = (await createPartner()).id;
    o1 = (await createOrganization({ partnerId: p1 })).id;
    o1b = (await createOrganization({ partnerId: p1 })).id;
    o1c = (await createOrganization({ partnerId: p1 })).id;
    o2 = (await createOrganization({ partnerId: p2 })).id;
    userId = (await createUser({ partnerId: p1, orgId: o1, email: `preview-${Date.now()}@data.test` })).id;
    await eligibleSessions(o1, 1);
    await eligibleSessions(o1b, 2);
    await eligibleSessions(o1c, 4);
    await eligibleSessions(o2, 8);
    // o1c's own window (30) is tighter than the previewed 365: unaffected by the partner value.
    await getTestDb().insert(aiDataPolicies).values({ orgId: o1c, transcriptRetentionDays: 30 });
  });

  it('partner preview sums only the partner\'s visible orgs and skips a tighter org row', async () => {
    current.auth = { scope: 'partner', orgId: null, partnerId: p1, accessibleOrgIds: [o1, o1b, o1c], userId };
    const res = await app().request('/partner/ai/data-policy/transcript-retention-preview?days=365');
    expect(res.status).toBe(200);
    // o1 (1) + o1b (2); o1c skipped (tighter row); p2's o2 (8) never counted.
    expect(await res.json()).toEqual({ eligible: 3, capped: false, enforced: false });
  });

  it('a restricted partner token counts only the orgs it can see', async () => {
    current.auth = { scope: 'partner', orgId: null, partnerId: p1, accessibleOrgIds: [o1b], userId };
    const res = await app().request('/partner/ai/data-policy/transcript-retention-preview?days=365');
    expect(await res.json()).toEqual({ eligible: 2, capped: false, enforced: false });
  });

  it('org preview counts the caller\'s org; an org token cannot aim it at another org', async () => {
    current.auth = { scope: 'organization', orgId: o1, partnerId: null, accessibleOrgIds: [o1], userId };
    const own = await app().request('/ai/data-policy/transcript-retention-preview?days=365');
    expect(await own.json()).toEqual({ eligible: 1, capped: false, enforced: false });
    const foreign = await app().request(`/ai/data-policy/transcript-retention-preview?days=365&orgId=${o2}`);
    if (foreign.status === 200) {
      // Org tokens ignore `orgId`: still their own org only, never o2's 8.
      expect(await foreign.json()).toEqual({ eligible: 1, capped: false, enforced: false });
    } else {
      expect(foreign.status).toBe(403);
    }
  });

  it('a partner token cannot preview another partner\'s org', async () => {
    current.auth = { scope: 'partner', orgId: null, partnerId: p1, accessibleOrgIds: [o1, o1b, o1c], userId };
    const res = await app().request(`/ai/data-policy/transcript-retention-preview?days=365&orgId=${o2}`);
    expect(res.status).toBe(403);
  });

  it('the count itself is RLS-bound: a context without the org sees zero', async () => {
    // Even if the route's org check were removed, the request context hides o2's sessions.
    current.auth = { scope: 'partner', orgId: null, partnerId: p1, accessibleOrgIds: [o1], userId };
    const { withDbAccessContext } = await import('../../db');
    const { buildDbAccessContext } = await import('../../middleware/auth');
    const { countTranscriptPreview, technicianStubPredicate, transcriptCutoffIso } = await import(
      '../../services/aiTranscriptRetentionPredicates'
    );
    const now = new Date();
    const r = await withDbAccessContext(
      buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: [o1], partnerId: p1, userId }),
      () => countTranscriptPreview(technicianStubPredicate(o2, transcriptCutoffIso(365, now), now)),
    );
    expect(r).toEqual({ eligible: 0, capped: false });
    // Sanity: the privileged connection does see them.
    const all = await getTestDb().select({ id: aiSessions.id }).from(aiSessions).where(inArray(aiSessions.orgId, [o2]));
    expect(all).toHaveLength(8);
  });
});
