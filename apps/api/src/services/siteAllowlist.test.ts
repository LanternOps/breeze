import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// aiToolsSiteScope imports the db handle at module load; none of the helpers
// under test here touch it.
vi.mock('../db', () => ({ db: {} }));

import { canAccessSite, type UserPermissions } from './permissions';
import {
  siteScopeCondition,
  deviceSiteDenied,
  scopeDeviceIdsToCaller,
  resolveSiteAllowedDeviceIds,
} from './aiToolsSiteScope';
import { normalizeSiteAllowlist } from './siteAllowlist';
import { runSiteScopeCondition } from './aiAgentRunSiteScope';
import { siteAccessCheck, type AuthContext } from '../middleware/auth';
import { devices } from '../db/schema/devices';

/**
 * #6790 — the site-scope helpers must FAIL CLOSED on a malformed allowlist.
 *
 * The type says `string[] | undefined`: undefined = unrestricted, an array is
 * the allowlist. Any other runtime value (a raw DB `null` from a future
 * builder that skips `permissions.ts`'s `|| undefined`, a non-array) is an
 * invariant breach and must deny every site — never collapse into
 * "unrestricted" through a truthiness check.
 */

const dialect = new PgDialect();
const render = (cond: SQL | undefined) => (cond ? dialect.sqlToQuery(cond) : undefined);

// Deliberately typed-around: these are the invariant-breach values.
const MALFORMED: unknown[] = [null, 'site-A', 42, {}];

const perms = (allowedSiteIds: unknown) =>
  ({ allowedSiteIds } as unknown as UserPermissions);
const auth = (allowedSiteIds: unknown) =>
  ({ allowedSiteIds } as unknown as AuthContext);

describe('permissions.canAccessSite', () => {
  it('undefined allowlist is unrestricted', () => {
    expect(canAccessSite(perms(undefined), 'site-A')).toBe(true);
  });
  it('an array allowlist admits only its members', () => {
    expect(canAccessSite(perms(['site-A']), 'site-A')).toBe(true);
    expect(canAccessSite(perms(['site-A']), 'site-B')).toBe(false);
    expect(canAccessSite(perms([]), 'site-A')).toBe(false);
  });
  it.each(MALFORMED)('a malformed allowlist (%j) denies every site', (raw) => {
    expect(canAccessSite(perms(raw), 'site-A')).toBe(false);
  });
});

describe('middleware siteAccessCheck', () => {
  it.each(MALFORMED)('a malformed allowlist (%j) denies every site', (raw) => {
    const can = siteAccessCheck(raw as string[] | undefined);
    expect(can('site-A')).toBe(false);
    expect(can(null)).toBe(false);
  });
});

describe('aiToolsSiteScope.siteScopeCondition', () => {
  it('undefined allowlist adds no narrowing', () => {
    expect(siteScopeCondition(auth(undefined), devices.siteId)).toBeUndefined();
  });
  it('an array allowlist narrows to its members', () => {
    const q = render(siteScopeCondition(auth(['site-A']), devices.siteId));
    expect(q?.sql).toMatch(/"site_id" in \(\$1\)/);
    expect(q?.params).toEqual(['site-A']);
  });
  it.each(MALFORMED)('a malformed allowlist (%j) matches nothing', (raw) => {
    const q = render(siteScopeCondition(auth(raw), devices.siteId));
    expect(q).toBeDefined();
    expect(q?.sql).toBe('false');
  });
});

describe('aiAgentRunSiteScope.runSiteScopeCondition', () => {
  it('undefined allowlist adds no narrowing', () => {
    expect(runSiteScopeCondition(auth(undefined))).toBeUndefined();
  });
  it('an empty array matches nothing', () => {
    expect(render(runSiteScopeCondition(auth([])))?.sql).toBe('false');
  });
  it('an array allowlist binds its members', () => {
    const q = render(runSiteScopeCondition(auth(['site-A', 'site-B'])));
    expect(q?.sql).toContain('EXISTS');
    expect(q?.params).toEqual(expect.arrayContaining(['site-A', 'site-B']));
  });
  it.each(MALFORMED)('a malformed allowlist (%j) matches nothing (no throw)', (raw) => {
    expect(render(runSiteScopeCondition(auth(raw)))?.sql).toBe('false');
  });
});

describe('normalizeSiteAllowlist', () => {
  it('passes undefined through as unrestricted', () => {
    expect(normalizeSiteAllowlist(undefined)).toBeUndefined();
  });
  it('passes an array through unchanged', () => {
    const ids = ['site-A'];
    expect(normalizeSiteAllowlist(ids)).toBe(ids);
    expect(normalizeSiteAllowlist([])).toEqual([]);
  });
  it.each(MALFORMED)('maps a malformed value (%j) to an empty allowlist', (raw) => {
    expect(normalizeSiteAllowlist(raw)).toEqual([]);
  });
});

describe('aiToolsSiteScope gates on a null allowlist', () => {
  // A null allowlist paired with a closure built from the same value — the
  // shape a builder that skipped permissions.ts's `|| undefined` would produce.
  const nullAuth = () =>
    ({
      allowedSiteIds: null,
      canAccessSite: siteAccessCheck(null as unknown as undefined),
    } as unknown as AuthContext);

  it('deviceSiteDenied denies every site', () => {
    expect(deviceSiteDenied(nullAuth(), 'site-A')).toBe(true);
    expect(deviceSiteDenied(nullAuth(), null)).toBe(true);
  });

  it('deviceSiteDenied denies even when the closure would admit the site', () => {
    const a = { allowedSiteIds: null, canAccessSite: () => true } as unknown as AuthContext;
    expect(deviceSiteDenied(a, 'site-A')).toBe(true);
  });

  it('deviceSiteDenied still honors a well-formed allowlist', () => {
    const a = {
      allowedSiteIds: ['site-A'],
      canAccessSite: siteAccessCheck(['site-A']),
    } as unknown as AuthContext;
    expect(deviceSiteDenied(a, 'site-A')).toBe(false);
    expect(deviceSiteDenied(a, 'site-B')).toBe(true);
    expect(deviceSiteDenied(auth(undefined), 'site-B')).toBe(false);
  });

  it('device-set resolvers do not read a null allowlist as unrestricted', async () => {
    // An unrestricted caller returns null WITHOUT a query; a restricted caller
    // queries the org's devices. The mocked db has no `select`, so reaching
    // the query rejects — proof the null allowlist was treated as restricted.
    await expect(resolveSiteAllowedDeviceIds('org-1', nullAuth())).rejects.toThrow();
    await expect(scopeDeviceIdsToCaller(nullAuth(), 'org-1', ['dev-1'])).rejects.toThrow();
    await expect(resolveSiteAllowedDeviceIds('org-1', auth(undefined))).resolves.toBeNull();
  });
});
