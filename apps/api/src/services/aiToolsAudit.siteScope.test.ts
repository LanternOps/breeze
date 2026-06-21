import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));

import { db } from '../db';
import { registerAuditTools } from './aiToolsAudit';
import { SITE_SCOPE_EMPTY_NOTE } from './aiToolsSiteScope';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerAuditTools(reg);
  return reg.get(name)!.handler;
}
function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds, canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as unknown as AuthContext;
}
function isDeviceResolverSelect(cols: unknown): boolean {
  return (
    !!cols && typeof cols === 'object' &&
    'id' in (cols as object) && 'siteId' in (cols as object) &&
    Object.keys(cols as object).length === 2
  );
}
function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'groupBy', 'offset']) {
    p[m] = () => p;
  }
  return p;
}

describe('query_change_log — site narrowing (no deviceId branch)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller does NOT receive change-log rows for a device in a forbidden site', async () => {
    let changeScanRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      changeScanRan = true;
      return chain([
        { timestamp: null, changeType: 'software', changeAction: 'added', subject: 's', beforeValue: null, afterValue: null, details: null, hostname: 'forbidden-host', deviceId: 'd-siteB' },
      ]);
    });

    const r = await handlerFor('query_change_log')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.changes).toEqual([]);
    expect(parsed.total).toBe(0);
    expect(parsed.showing).toBe(0);
    expect(changeScanRan).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('forbidden-host');
  });

  it('unrestricted caller enumerates change log normally (no regression)', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'count' in (cols as object) && Object.keys(cols as object).length === 1) {
        return chain([{ count: 1 }]);
      }
      return chain([
        { timestamp: null, changeType: 'software', changeAction: 'added', subject: 's', beforeValue: null, afterValue: null, details: null, hostname: 'h1', deviceId: 'd1' },
      ]);
    });
    const r = await handlerFor('query_change_log')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.showing).toBe(1);
    expect(parsed.total).toBe(1);
  });
});

describe('query_audit_log — device-typed row site narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  // The site-narrowing SQL predicate is opaque to the mock, so these tests
  // assert the handler resolves the allowed device set (the resolver SELECT)
  // before scanning — proving the narrowing path runs for restricted callers.
  it('site-restricted caller resolves the allowed device set and applies a scan predicate', async () => {
    let resolverRan = false;
    let scanWhere: unknown;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        resolverRan = true;
        return {
          from: () => ({
            where: () =>
              Promise.resolve([
                { id: 'd-inscope', siteId: 'site-A' },
                { id: 'd-forbidden', siteId: 'site-B' },
              ]),
          }),
        };
      }
      const p: any = Promise.resolve([
        { id: 'a1', timestamp: null, actorType: 'user', actorEmail: 'x', action: 'agent.command.script', resourceType: 'device', resourceName: 'in-scope', result: 'ok', details: null },
      ]);
      for (const m of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'limit', 'groupBy', 'offset']) p[m] = () => p;
      p.where = (w: unknown) => {
        scanWhere = w;
        return p;
      };
      return p;
    });

    const r = await handlerFor('query_audit_log')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(resolverRan).toBe(true);
    expect(scanWhere).toBeDefined();
  });

  it('site-restricted caller with explicit out-of-scope device returns denied/empty', async () => {
    let scanRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return {
          from: () => ({
            where: () => Promise.resolve([{ id: 'd-inscope', siteId: 'site-A' }]),
          }),
        };
      }
      scanRan = true;
      return chain([
        { id: 'a1', timestamp: null, actorType: 'user', actorEmail: 'x', action: 'a', resourceType: 'device', resourceName: 'forbidden', result: 'ok', details: null },
      ]);
    });

    const r = await handlerFor('query_audit_log')(
      { resourceType: 'device', resourceId: 'd-forbidden' },
      makeAuth(['site-A']),
    );
    const parsed = JSON.parse(r);
    expect(parsed.entries).toEqual([]);
    expect(parsed.showing).toBe(0);
    expect(parsed.scopeNote).toBe(SITE_SCOPE_EMPTY_NOTE);
    expect(scanRan).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('forbidden');
  });

  it('unrestricted caller queries audit log normally (no regression)', async () => {
    let resolverRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        resolverRan = true;
        return { from: () => ({ where: () => Promise.resolve([]) }) };
      }
      return chain([
        { id: 'a1', timestamp: null, actorType: 'user', actorEmail: 'x', action: 'a', resourceType: 'device', resourceName: 'r', result: 'ok', details: null },
      ]);
    });
    const r = await handlerFor('query_audit_log')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.showing).toBe(1);
    expect(resolverRan).toBe(false);
  });

  // R3b residual: a NON-device row may reference a device via `details.deviceId`.
  // An explicit lookup by a `resourceId` that is a known out-of-scope fleet
  // device is denied outright (regardless of resourceType), and the scan is
  // never reached. Both resolver SELECTs (allowed + forbidden) share the
  // `{id, siteId}` shape; `canAccessSite` derives the in/out-of-scope split.
  it('explicit resourceId that is a known out-of-scope device is denied/empty (any resourceType)', async () => {
    let scanRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return {
          from: () => ({
            where: () =>
              Promise.resolve([
                { id: 'd-inscope', siteId: 'site-A' },
                { id: 'd-forbidden', siteId: 'site-B' },
              ]),
          }),
        };
      }
      scanRan = true;
      return chain([
        { id: 'a1', timestamp: null, actorType: 'user', actorEmail: 'x', action: 'a', resourceType: 'remote_session', resourceName: 'leak', result: 'ok', details: { deviceId: 'd-forbidden' } },
      ]);
    });

    const r = await handlerFor('query_audit_log')(
      { resourceId: 'd-forbidden' },
      makeAuth(['site-A']),
    );
    const parsed = JSON.parse(r);
    expect(parsed.entries).toEqual([]);
    expect(parsed.showing).toBe(0);
    expect(parsed.scopeNote).toBe(SITE_SCOPE_EMPTY_NOTE);
    expect(scanRan).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('leak');
  });
});
