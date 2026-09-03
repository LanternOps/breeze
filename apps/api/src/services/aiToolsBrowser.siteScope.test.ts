import { describe, it, expect, vi, beforeEach } from 'vitest';

const { assertDeviceExecuteAllowedMock } = vi.hoisted(() => ({
  assertDeviceExecuteAllowedMock: vi.fn(async () => undefined),
}));

// aiToolsBrowser imports the db hub (which pulls commandQueue), so the db mock
// must expose the context helpers too — same shape as aiTools.verifyDeviceAccess.test.ts.
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('./eventBus', () => ({ publishEvent: vi.fn(async () => undefined) }));
vi.mock('./partnerTrust.commands', async () => ({
  ...(await vi.importActual<typeof import('./partnerTrust.commands')>('./partnerTrust.commands')),
  assertDeviceExecuteAllowed: assertDeviceExecuteAllowedMock,
}));

import { db } from '../db';
import { policyWithinSiteWriteScope, registerBrowserTools } from './aiToolsBrowser';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { TrustDeniedError } from './partnerTrust.commands';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerBrowserTools(reg);
  const tool = reg.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.handler;
}

function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
    canAccessSite: (siteId) => (!allowedSiteIds ? true : !!siteId && allowedSiteIds.includes(siteId)),
  };
}

describe('policyWithinSiteWriteScope (AI-tools browser)', () => {
  it('allows any policy for an unrestricted caller', () => {
    expect(policyWithinSiteWriteScope(makeAuth(undefined), 'org', null)).toBe(true);
    expect(policyWithinSiteWriteScope(makeAuth(undefined), 'site', ['site-Z'])).toBe(true);
  });

  it('denies non-site target types for a site-restricted caller', () => {
    const auth = makeAuth(['site-A']);
    expect(policyWithinSiteWriteScope(auth, 'org', null)).toBe(false);
    expect(policyWithinSiteWriteScope(auth, 'group', ['g1'])).toBe(false);
    expect(policyWithinSiteWriteScope(auth, 'device', ['d1'])).toBe(false);
    expect(policyWithinSiteWriteScope(auth, 'tag', ['t1'])).toBe(false);
  });

  it('denies a site policy with an empty target list for a restricted caller', () => {
    expect(policyWithinSiteWriteScope(makeAuth(['site-A']), 'site', [])).toBe(false);
    expect(policyWithinSiteWriteScope(makeAuth(['site-A']), 'site', null)).toBe(false);
  });

  it('allows a site policy only when every target site is in the allowlist', () => {
    const auth = makeAuth(['site-A', 'site-B']);
    expect(policyWithinSiteWriteScope(auth, 'site', ['site-A'])).toBe(true);
    expect(policyWithinSiteWriteScope(auth, 'site', ['site-A', 'site-B'])).toBe(true);
    expect(policyWithinSiteWriteScope(auth, 'site', ['site-A', 'site-C'])).toBe(false);
  });
});

describe('manage_browser_policy — site write scope (mutations)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create: site-restricted caller cannot create an org-wide policy', async () => {
    const handler = handlerFor('manage_browser_policy');
    const result = await handler(
      { action: 'create', name: 'P', targetType: 'org', targetIds: [] },
      makeAuth(['site-A']),
    );
    expect(result).toContain('error');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('create: site-restricted caller cannot target a forbidden site', async () => {
    const handler = handlerFor('manage_browser_policy');
    const result = await handler(
      { action: 'create', name: 'P', targetType: 'site', targetIds: ['site-B'] },
      makeAuth(['site-A']),
    );
    expect(result).toContain('error');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('update: site-restricted caller cannot edit a policy outside their site scope', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'p1', orgId: 'org-1', targetType: 'org', targetIds: null }]) }) }),
    });
    const handler = handlerFor('manage_browser_policy');
    const result = await handler(
      { action: 'update', policyId: 'p1', name: 'X' },
      makeAuth(['site-A']),
    );
    expect(result).toContain('error');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('apply: site-restricted caller cannot apply a policy outside their site scope', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'p1', orgId: 'org-1', targetType: 'org', targetIds: null, isActive: true }]) }) }),
    });
    const handler = handlerFor('manage_browser_policy');
    const result = await handler(
      { action: 'apply', policyId: 'p1' },
      makeAuth(['site-A']),
    );
    expect(result).toContain('error');
  });

  it('create: unrestricted caller is unaffected (org policy allowed)', async () => {
    const returning = vi.fn(() => Promise.resolve([{ id: 'new', name: 'P' }]));
    mockDb.insert.mockReturnValue({ values: () => ({ returning }) });
    const handler = handlerFor('manage_browser_policy');
    const result = await handler(
      { action: 'create', name: 'P', targetType: 'org', targetIds: [] },
      makeAuth(undefined),
    );
    expect(result).not.toContain('"error"');
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('apply: trust denial returns the tool error shape without inserting', async () => {
    mockDb.select
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([{
          id: 'p1', orgId: 'org-1', name: 'Policy', targetType: 'org', targetIds: null, isActive: true,
          allowedExtensions: [], blockedExtensions: [], requiredExtensions: [], settings: {},
        }]) }) }),
      })
      .mockReturnValueOnce({
        from: () => ({ where: () => Promise.resolve([{ id: 'd1', hostname: 'host-1' }]) }),
      });
    assertDeviceExecuteAllowedMock.mockRejectedValueOnce(
      new TrustDeniedError('TRUST_PROBATION', 'Partner verification is required.', 'd1', 'apply_browser_policy'),
    );

    const result = await handlerFor('manage_browser_policy')(
      { action: 'apply', policyId: 'p1' },
      makeAuth(undefined),
    );

    expect(JSON.parse(result)).toEqual({
      error: 'TRUST_PROBATION',
      message: 'Remote control and device changes are not available until this account is verified.',
    });
    expect(assertDeviceExecuteAllowedMock).toHaveBeenCalledWith('d1', 'apply_browser_policy', 'u1');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('apply: queues the same command when trust allows execution', async () => {
    mockDb.select
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([{
          id: 'p1', orgId: 'org-1', name: 'Policy', targetType: 'org', targetIds: null, isActive: true,
          allowedExtensions: [], blockedExtensions: [], requiredExtensions: [], settings: {},
        }]) }) }),
      })
      .mockReturnValueOnce({
        from: () => ({ where: () => Promise.resolve([{ id: 'd1', hostname: 'host-1' }]) }),
      });
    mockDb.insert.mockReturnValue({
      values: () => ({ returning: () => Promise.resolve([{ id: 'cmd-1', deviceId: 'd1' }]) }),
    });

    const result = JSON.parse(await handlerFor('manage_browser_policy')(
      { action: 'apply', policyId: 'p1' },
      makeAuth(undefined),
    ));

    expect(result.success).toBe(true);
    expect(result.queuedCommands).toBe(1);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });
});

describe('get_browser_security — read site narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty results for a site-restricted caller with no in-scope devices, without querying extension rows', () => {
    // The org-device lookup (resolveSiteAllowedDeviceIds) returns devices that
    // are all in a forbidden site, so the allowed set is empty → the handler
    // must short-circuit to zeros and never run the extension/violation reads.
    let extensionQueryRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      // First call: the device lookup { id, siteId }.
      if (!cols || (typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object))) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-FORBIDDEN' }]) }) };
      }
      extensionQueryRan = true;
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) };
    });

    const handler = handlerFor('get_browser_security');
    return handler({ orgId: 'org-1' }, makeAuth(['site-A'])).then((result) => {
      const parsed = JSON.parse(result);
      expect(parsed.summary.total).toBe(0);
      expect(parsed.extensions).toEqual([]);
      expect(extensionQueryRan).toBe(false);
    });
  });
});
