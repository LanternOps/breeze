import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('./commandQueue', () => ({
  CommandTypes: { VAULT_SYNC: 'vault_sync' },
  queueCommandForExecution: vi.fn(async () => ({ command: { id: 'c1', status: 'sent' } })),
}));

import { db } from '../db';
import { registerVaultTools } from './aiToolsVault';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
};

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerVaultTools(reg);
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
    canAccessSite: (siteId) => (!allowedSiteIds ? true : !!siteId && allowedSiteIds.includes(siteId)),
  };
}

// Helper: stub a single-row device lookup { id, hostname, status, siteId, orgId }
function stubDeviceRow(row: Record<string, unknown> | undefined) {
  mockDb.select.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }) }),
  });
}

describe('get_vault_status — site scoping (cross-site secret/device read)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies a device in a forbidden site for a site-restricted caller (no vault read)', async () => {
    let vaultRead = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      // device lookup first
      if (cols && typeof cols === 'object' && 'hostname' in (cols as object)) {
        return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'd1', hostname: 'h', status: 'online', siteId: 'site-B' }]) }) }) };
      }
      vaultRead = true;
      return { from: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }) };
    });
    const result = await handlerFor('get_vault_status')({ deviceId: 'd1' }, makeAuth(['site-A']));
    expect(result).toContain('access denied');
    expect(vaultRead).toBe(false);
  });

  it('allows a device within the site allowlist', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'hostname' in (cols as object)) {
        return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'd1', hostname: 'h', status: 'online', siteId: 'site-A' }]) }) }) };
      }
      return { from: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }) };
    });
    const result = await handlerFor('get_vault_status')({ deviceId: 'd1' }, makeAuth(['site-A']));
    const parsed = JSON.parse(result);
    expect(parsed.deviceId).toBe('d1');
  });

  it('unrestricted caller is unaffected (any site allowed)', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'hostname' in (cols as object)) {
        return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'd1', hostname: 'h', status: 'online', siteId: 'site-Z' }]) }) }) };
      }
      return { from: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }) };
    });
    const result = await handlerFor('get_vault_status')({ deviceId: 'd1' }, makeAuth(undefined));
    const parsed = JSON.parse(result);
    expect(parsed.deviceId).toBe('d1');
  });
});

describe('trigger_vault_sync — site scoping (vault → device)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies a vault whose device is in a forbidden site', async () => {
    // First select: vault row { id, deviceId, isActive }. Then deviceIdSiteDenied
    // selects { siteId } for the device.
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call++;
      if (call === 1) return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'v1', deviceId: 'd1', isActive: true }]) }) }) };
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ siteId: 'site-B' }]) }) }) };
    });
    mockDb.update.mockReturnValue({ set: () => ({ where: () => Promise.resolve() }) });
    const result = await handlerFor('trigger_vault_sync')({ vaultId: 'v1' }, makeAuth(['site-A']));
    expect(result).toContain('access denied');
  });

  it('unrestricted caller is unaffected', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'v1', deviceId: 'd1', isActive: true }]) }) }),
    });
    mockDb.update.mockReturnValue({ set: () => ({ where: () => Promise.resolve() }) });
    const result = await handlerFor('trigger_vault_sync')({ vaultId: 'v1' }, makeAuth(undefined));
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
  });
});

describe('configure_vault create — site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies creating a vault on a device in a forbidden site', async () => {
    stubDeviceRow({ id: 'd1', orgId: 'org-1', siteId: 'site-B' });
    const result = await handlerFor('configure_vault')(
      { action: 'create', deviceId: 'd1', vaultPath: '/v' },
      makeAuth(['site-A']),
    );
    expect(result).toContain('access denied');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});
