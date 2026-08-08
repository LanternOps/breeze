import { describe, expect, it, vi } from 'vitest';

// The route modules under this directory register their handlers at import
// time; the registration itself needs no database, Redis, or env secrets, so
// those transitive imports are mocked exactly like the sibling route tests.
vi.mock('../../db', () => ({
  db: {},
  hasDbAccessContext: () => true,
  withDbAccessContext: async (_ctx: unknown, fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../../config/env', () => ({
  PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
}));
vi.mock('../../middleware/partnerApiAuth', () => ({
  partnerApiAuthMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  requirePartnerApiScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../services/auditEvents', () => ({
  writeAuditEventAsync: vi.fn(),
  requestLikeFromSnapshot: (value: unknown) => value,
}));

import { partnerApiRoutes } from './index';

/**
 * The Partner API was read-only by construction until #3243 — every route was
 * a `.get()`, and "this surface cannot mutate tenancy" was verifiable with a
 * grep. Issue #3243 deliberately gave it a write side (unattended tenancy
 * provisioning for migrations and integrations), which destroyed that cheap
 * invariant. This allowlist is its stronger replacement: every non-GET route
 * registered under `partnerApiRoutes` must appear here as a deliberate,
 * reviewable line, so a future write route cannot slip in as a side effect of
 * an unrelated change — it fails CI instead of relying on a reviewer noticing.
 *
 * Same idiom as `CORE_ORG_CASCADE_DELETE_ORDER`, `runActionAllowlist.ts`, and
 * the RLS coverage allowlists.
 *
 * Adding an entry requires the same scrutiny the #3243 thread applied:
 * create/update only (org/site/key DELETION stays human + MFA on the main
 * API), a dedicated `:write` scope, per-principal write rate limiting, and
 * audit attribution to the service principal.
 */
const PARTNER_API_NON_GET_ROUTE_ALLOWLIST: readonly string[] = [
  // #3243 — unattended tenancy provisioning (partner service principal).
  'POST /enrollment-keys', // enrollment-keys:write; TTL cap enforced; raw key returned once
  'POST /organizations', // organizations:write; partner.maxOrganizations quota enforced
  'POST /sites', // sites:write; orgId must be in the principal's accessible set
];

describe('partner API write surface', () => {
  function nonGetRoutes(): string[] {
    const seen = new Set<string>();
    for (const route of partnerApiRoutes.routes) {
      // 'ALL' entries are `.use()` middleware registrations, not endpoints.
      if (route.method === 'GET' || route.method === 'ALL') continue;
      seen.add(`${route.method} ${route.path}`);
    }
    return [...seen].sort();
  }

  it('every non-GET route is explicitly allowlisted', () => {
    expect(nonGetRoutes()).toEqual([...PARTNER_API_NON_GET_ROUTE_ALLOWLIST].sort());
  });

  it('catches an unlisted write route being added to the surface', () => {
    // Prove the enumeration actually sees new registrations: temporarily
    // register a write route the allowlist does not contain and assert the
    // comparison would fail. Registered on a throwaway clone-like path check
    // via the live router, then verified present in the enumeration.
    const before = nonGetRoutes();
    partnerApiRoutes.post('/__write-surface-canary__', (c) => c.text('never'));
    try {
      const after = nonGetRoutes();
      expect(after).toContain('POST /__write-surface-canary__');
      expect(after).not.toEqual([...PARTNER_API_NON_GET_ROUTE_ALLOWLIST].sort());
      expect(after.length).toBe(before.length + 1);
    } finally {
      // Hono has no route deregistration; scrub the canary from the internal
      // route table so this test cannot leak state into sibling suites that
      // import the same module instance.
      const routes = partnerApiRoutes.routes as Array<{ path: string }>;
      for (let i = routes.length - 1; i >= 0; i -= 1) {
        if (routes[i]?.path === '/__write-surface-canary__') routes.splice(i, 1);
      }
    }
  });
});
