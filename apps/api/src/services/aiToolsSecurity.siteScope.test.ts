import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

const { queueCommand } = vi.hoisted(() => ({ queueCommand: vi.fn(async () => ({ id: 'cmd-1', status: 'sent' })) }));
vi.mock('./commandQueue', () => ({
  queueCommand,
  CommandTypes: { ENCRYPT_FILE: 'encrypt_file', QUARANTINE_FILE: 'quarantine_file', SECURE_DELETE_FILE: 'secure_delete_file' },
}));
vi.mock('./securityPosture', () => ({
  getLatestSecurityPostureForDevice: vi.fn(),
  listLatestSecurityPosture: vi.fn(),
}));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('./sensitiveDataKeys', () => ({
  resolveSensitiveDataKeySelection: vi.fn(() => ({ keyRef: 'k', keyVersion: 'v', provider: 'p', keyFingerprint: 'f' })),
}));

import { db } from '../db';
import { registerSecurityTools } from './aiToolsSecurity';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerSecurityTools(reg);
  const tool = reg.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.handler;
}

function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
    canAccessSite: (s) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  };
}

// resolveSiteAllowedDeviceIds selects { id, siteId } from devices keyed by org.
function selectAllowedDevices(rows: Array<{ id: string; siteId: string | null }>) {
  return { from: () => ({ where: () => Promise.resolve(rows) }) };
}

describe('remediate_sensitive_data — site scoping (destructive device commands)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies the whole request when ANY requested finding is on an out-of-site device', async () => {
    let call = 0;
    mockDb.select.mockImplementation((cols?: unknown) => {
      // First select: load findings by id (no siteId column).
      if (cols && typeof cols === 'object' && 'filePath' in (cols as object)) {
        return { from: () => ({ where: () => Promise.resolve([
          { id: 'f1', orgId: 'org-1', deviceId: 'd-allowed', scanId: 's1', filePath: '/a', status: 'open' },
          { id: 'f2', orgId: 'org-1', deviceId: 'd-forbidden', scanId: 's1', filePath: '/b', status: 'open' },
        ]) }) };
      }
      call++;
      // resolveSiteAllowedDeviceIds: d-allowed is in site-A, d-forbidden is not.
      return selectAllowedDevices([
        { id: 'd-allowed', siteId: 'site-A' },
        { id: 'd-forbidden', siteId: 'site-FORBIDDEN' },
      ]);
    });
    const r = await handlerFor('remediate_sensitive_data')(
      { findingIds: ['f1', 'f2'], action: 'secure_delete', confirm: true },
      makeAuth(['site-A']),
    );
    expect(r).toContain('access denied');
    expect(queueCommand).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('unrestricted caller is unaffected (no regression)', async () => {
    mockDb.select.mockImplementation(() => ({
      from: () => ({ where: () => Promise.resolve([
        { id: 'f1', orgId: 'org-1', deviceId: 'd1', scanId: 's1', filePath: '/a', status: 'open' },
      ]) }),
    }));
    mockDb.update.mockReturnValue({ set: () => ({ where: () => Promise.resolve() }) });
    const r = await handlerFor('remediate_sensitive_data')(
      { findingIds: ['f1'], action: 'quarantine', confirm: true },
      makeAuth(undefined),
    );
    expect(r).not.toContain('access denied');
    expect(queueCommand).toHaveBeenCalledTimes(1);
  });
});

describe('get_sensitive_data_overview — site narrowing (device-keyed PII reads)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('findings view: site-restricted caller with no in-scope devices gets empty results, without reading findings', async () => {
    let findingsRead = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object) && Object.keys(cols as object).length === 2) {
        // resolveSiteAllowedDeviceIds — all org devices are in a forbidden site.
        return selectAllowedDevices([{ id: 'd1', siteId: 'site-FORBIDDEN' }]);
      }
      findingsRead = true;
      return { from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'leak', filePath: '/secret' }]) }) }) }) }) };
    });
    const r = await handlerFor('get_sensitive_data_overview')({ view: 'findings' }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.totalReturned).toBe(0);
    expect(parsed.findings).toEqual([]);
    expect(findingsRead).toBe(false);
  });

  it('scans view: site-restricted caller with no in-scope devices gets empty results', async () => {
    let scansRead = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object) && Object.keys(cols as object).length === 2) {
        return selectAllowedDevices([{ id: 'd1', siteId: 'site-FORBIDDEN' }]);
      }
      scansRead = true;
      return { from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'scan', status: 'completed' }]) }) }) }) }) };
    });
    const r = await handlerFor('get_sensitive_data_overview')({ view: 'scans' }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.totalReturned).toBe(0);
    expect(scansRead).toBe(false);
  });

  it('unrestricted caller reads normally (no regression)', async () => {
    mockDb.select.mockImplementation(() => ({
      from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'leak', filePath: '/secret' }]) }) }) }) }),
    }));
    const r = await handlerFor('get_sensitive_data_overview')({ view: 'findings' }, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.totalReturned).toBe(1);
  });
});
