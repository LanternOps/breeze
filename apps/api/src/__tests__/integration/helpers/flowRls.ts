/**
 * Shared real-Postgres fixtures for the flow RLS suites (Tool Catalog W03
 * flowsPartnerRls, W04 flowRunsPartnerRls / flowRunnerEndToEnd): the DB
 * access contexts a request, a partner token and the system run under, the
 * AuthContext shapes the flow services take, and the SQLSTATE assertion.
 */
import { expect } from 'vitest';
import type { DbAccessContext } from '../../../db';
import { buildOrgAccessClosures, type AuthContext } from '../../../middleware/auth';
import { pgErrorCode } from '../../../utils/pgErrors';

export const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

export function partnerContext(partnerId: string, orgIds: string[], userId: string | null = null): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId, currentPartnerId: partnerId };
}

/** Org sessions carry their partner id (the SELECT branch keys on it) but never pass breeze_has_partner_access. */
export function orgContext(orgId: string, partnerId: string, userId: string | null = null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId, currentPartnerId: partnerId };
}

/** A minimal org AuthContext (no principal): what the W03 draft service reads. */
export function orgAuth(orgId: string, partnerId: string, userId: string): AuthContext {
  return {
    scope: 'organization', orgId, partnerId, partnerOrgAccess: null, accessibleOrgIds: [orgId],
    canAccessOrg: (id: string) => id === orgId, user: { id: userId, email: 'flows-it@example.com' },
  } as unknown as AuthContext;
}

export function partnerAuth(partnerId: string, orgIds: string[], userId: string): AuthContext {
  return {
    scope: 'partner', orgId: null, partnerId, partnerOrgAccess: 'all', accessibleOrgIds: orgIds,
    canAccessOrg: (id: string) => orgIds.includes(id), user: { id: userId, email: 'flows-it@example.com' },
  } as unknown as AuthContext;
}

/**
 * An interactive org user session — the shape authMiddleware produces for a
 * browser login (enableFlow / startManualRun require `principal.kind ===
 * 'user_session'`). No `allowedSiteIds` on the token: a site ceiling, when a
 * case needs one, comes from the user's real organization_users row.
 */
export function interactiveOrgAuth(orgId: string, partnerId: string, user: { id: string; email: string }, roleId = 'role'): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: 'Flow IT', isPlatformAdmin: false },
    token: { sub: user.id, email: user.email, roleId, orgId, partnerId, scope: 'organization', type: 'access', mfa: true },
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    partnerOrgAccess: null,
    orgCondition,
    canAccessOrg,
  } as unknown as AuthContext;
}

/** An interactive partner-staff session; `orgAccess` mirrors partner_users.org_access. */
export function interactivePartnerAuth(
  partnerId: string,
  orgIds: string[],
  user: { id: string; email: string },
  orgAccess: 'all' | 'selected' = 'all',
  roleId = 'role',
): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures(orgIds);
  return {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: 'Flow IT', isPlatformAdmin: false },
    token: { sub: user.id, email: user.email, roleId, orgId: null, partnerId, scope: 'partner', type: 'access', mfa: true },
    partnerId,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: orgIds,
    partnerOrgAccess: orgAccess,
    orgCondition,
    canAccessOrg,
  } as unknown as AuthContext;
}

export async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<unknown> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
  return raised;
}

/** The message Postgres raised (drizzle wraps the driver error; the text is on `.cause`). */
export function pgMessage(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string } } | null;
  return `${e?.cause?.message ?? ''} ${e?.message ?? ''}`;
}
