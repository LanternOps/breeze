/**
 * GET /users/me — partner default locale under an org-scoped RLS context.
 *
 * Regression test for the bug where `partnerDefaultLocale` silently stayed
 * null for org-scoped sessions (the majority of logins). `computeAccessiblePartnerIds`
 * (middleware/auth.ts) returns `[]` for scope='organization', so the `partners`
 * table's `breeze_has_partner_access(id)` SELECT policy filters the row out
 * under the ambient request context — even though the org-scoped JWT carries a
 * non-null partnerId. The fix reads `partners.settings` under a system DB
 * context (`runOutsideDbContext` + `withSystemDbAccessContext`, mirroring the
 * heartbeat probe-config pattern, #1105) so RLS can't hide the row.
 *
 * Drives the real GET /users/me route against the docker postgres as
 * breeze_app, so RLS policies are genuinely enforced (unlike the mocked unit
 * tests in routes/users.test.ts).
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

type AuthCtx = {
  scope: 'partner' | 'organization';
  partnerId: string | null;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  accessiblePartnerIds: string[] | null;
  userId: string;
};

let activeAuthContext: AuthCtx | null = null;

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const { withDbAccessContext } = await import('../../db');
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => {
      if (!activeAuthContext) return c.json({ error: 'Unauthorized' }, 401);
      const ctx = activeAuthContext;
      c.set('auth', {
        scope: ctx.scope,
        partnerId: ctx.partnerId,
        orgId: ctx.orgId,
        accessibleOrgIds: ctx.accessibleOrgIds ?? [],
        user: { id: ctx.userId, email: 'integration@test' },
      });
      // Mirrors authMiddleware's real dispatch: the whole request runs inside
      // withDbAccessContext, so /me's partner-settings read starts out
      // filtered by RLS exactly like production — proving the fix's
      // runOutsideDbContext + withSystemDbAccessContext escalation is what
      // makes the row visible, not an artifact of a permissive test context.
      return withDbAccessContext(
        {
          scope: ctx.scope,
          orgId: ctx.orgId,
          accessibleOrgIds: ctx.accessibleOrgIds,
          accessiblePartnerIds: ctx.accessiblePartnerIds,
          userId: ctx.userId,
          currentPartnerId: ctx.partnerId,
        },
        () => next(),
      );
    },
    hasSatisfiedMfa: () => true,
    requireMfa: () => (_c: any, next: any) => next(),
    requirePermission: () => (_c: any, next: any) => next(),
  };
});

import { db, withSystemDbAccessContext } from '../../db';
import { partners } from '../../db/schema';
import { createPartner, createOrganization, createUser } from './db-utils';

async function buildApp() {
  const { userRoutes } = await import('../../routes/users');
  const { authMiddleware } = await import('../../middleware/auth');
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/users', userRoutes);
  return app;
}

beforeEach(() => {
  activeAuthContext = null;
});

afterEach(() => {
  activeAuthContext = null;
  vi.clearAllMocks();
});

describe('GET /users/me partner default locale (RLS, org scope)', () => {
  it('returns the partner default locale for an org-scoped user via the system DB context escalation', async () => {
    const partner = await createPartner();
    await withSystemDbAccessContext(async () =>
      db.update(partners).set({ settings: { language: 'pt-BR' } }).where(eq(partners.id, partner.id)),
    );
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `me-${Date.now()}@example.com`,
      status: 'active',
      withMembership: true,
    });

    // computeAccessiblePartnerIds(scope='organization', ...) returns [] in
    // production — org-scoped sessions never carry partner-axis RLS access.
    activeAuthContext = {
      scope: 'organization',
      partnerId: partner.id,
      orgId: org.id,
      accessibleOrgIds: [org.id],
      accessiblePartnerIds: [],
      userId: user.id,
    };

    const app = await buildApp();
    const res = await app.request('/users/me');

    expect(res.status).toBe(200);
    const body = await res.json() as { partnerDefaultLocale: string | null };
    expect(body.partnerDefaultLocale).toBe('pt-BR');
  });
});
