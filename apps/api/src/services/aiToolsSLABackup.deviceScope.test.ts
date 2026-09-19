import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Backup-SLA tools — EXACT-DEVICE axis (#6096 I3/I5).
 *
 * I3: `configure_backup_sla` declared `deviceArgs: ['targetDevices']`, which
 * only guards the argument when it is PRESENT. Creating or updating a config
 * without naming devices (or naming only groups) sailed through, so a run
 * bound to one device could rewrite the org's backup SLA policy.
 *
 * I5: `query_backup_sla` spread the whole config row — including
 * `targetDevices`, a roster of device UUIDs — even on the zero-in-scope path
 * whose entire point is to disclose nothing about devices out of reach.
 */
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

import { db } from '../db';
import { registerSLABackupTools } from './aiToolsSLABackup';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerSLABackupTools(reg);
  return reg.get(name)!.handler;
}

function makeAuth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: 'p1', orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    canAccessSite: () => true,
    ...over,
  } as unknown as AuthContext;
}
/** Device-bound run: one device + its site. */
const deviceBound = () => makeAuth({
  allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'],
  canAccessSite: (s?: string | null) => s === 'site-1',
} as Partial<AuthContext>);
/** Device-LESS analysis run: frozen device set, NO site axis. */
const deviceLess = () => makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: undefined, canAccessSite: undefined } as Partial<AuthContext>);
const siteOnly = () => makeAuth({
  allowedSiteIds: ['site-1'], canAccessSite: (s?: string | null) => s === 'site-1',
} as Partial<AuthContext>);
const unrestricted = () => makeAuth();

const CONFIG = {
  id: 'cfg-1', orgId: 'org-1', name: 'Nightly', rpoTargetMinutes: 60, rtoTargetMinutes: 120,
  targetDevices: ['dev-1', 'dev-2', 'dev-3'], targetGroups: ['grp-1'],
  alertOnBreach: true, isActive: true,
};

/** Generic chainable query mock that resolves to `result`. */
function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'groupBy', 'offset']) p[m] = () => p;
  return p;
}
function isDeviceResolverSelect(cols: unknown): boolean {
  return !!cols && typeof cols === 'object' && 'id' in (cols as object)
    && 'siteId' in (cols as object) && Object.keys(cols as object).length === 2;
}

beforeEach(() => vi.clearAllMocks());

describe('configure_backup_sla — org-wide governance ceiling (#6096 I3)', () => {
  beforeEach(() => {
    mockDb.insert.mockReturnValue({ values: () => ({ returning: () => Promise.resolve([CONFIG]) }) });
    mockDb.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([CONFIG]) }) }) });
    mockDb.select.mockImplementation(() => chain([{ id: 'cfg-1' }]));
  });

  it('denies create with NO targetDevices argument for a device-bound run', async () => {
    const r = JSON.parse(await handlerFor('configure_backup_sla')(
      { action: 'create', name: 'X', rpoTargetMinutes: 60, rtoTargetMinutes: 120, targetGroups: ['grp-1'] },
      deviceBound(),
    ));
    expect(r.error).toMatch(/site-restricted|restricted/i);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('denies create for a device-LESS analysis run (no site axis at all)', async () => {
    const r = JSON.parse(await handlerFor('configure_backup_sla')(
      { action: 'create', name: 'X', rpoTargetMinutes: 60, rtoTargetMinutes: 120 },
      deviceLess(),
    ));
    expect(r.error).toMatch(/site-restricted|restricted/i);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('denies update with no device argument for a site-restricted human', async () => {
    const r = JSON.parse(await handlerFor('configure_backup_sla')(
      { action: 'update', configId: 'cfg-1', rpoTargetMinutes: 15 },
      siteOnly(),
    ));
    expect(r.error).toMatch(/site-restricted|restricted/i);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('still lets an unrestricted caller create (no regression)', async () => {
    const r = JSON.parse(await handlerFor('configure_backup_sla')(
      { action: 'create', name: 'X', rpoTargetMinutes: 60, rtoTargetMinutes: 120 },
      unrestricted(),
    ));
    expect(r.success).toBe(true);
    expect(mockDb.insert).toHaveBeenCalled();
  });
});

describe('query_backup_sla — the device roster is never disclosed (#6096 I5)', () => {
  function mockConfigs(inScopeDeviceIds: string[]) {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve(inScopeDeviceIds.map((id) => ({ id, siteId: 'site-1' }))) }) };
      }
      return chain([CONFIG]);
    });
  }

  it('omits targetDevices/targetGroups on the zero-in-scope path', async () => {
    mockConfigs([]);
    const parsed = JSON.parse(await handlerFor('query_backup_sla')({}, siteOnly()));
    expect(parsed.configs[0].targetDeviceCount).toBe(3);
    expect(parsed.configs[0].targetDevices).toBeUndefined();
    expect(parsed.configs[0].targetGroups).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain('dev-2');
  });

  it('omits them on the normal path too (device-bound run)', async () => {
    mockConfigs(['dev-1']);
    const parsed = JSON.parse(await handlerFor('query_backup_sla')({}, deviceBound()));
    expect(parsed.configs[0].targetDevices).toBeUndefined();
    expect(parsed.configs[0].targetGroups).toBeUndefined();
    expect(parsed.configs[0].targetDeviceCount).toBe(3);
    expect(parsed.configs[0].targetGroupCount).toBe(1);
    expect(JSON.stringify(parsed)).not.toContain('dev-2');
  });

  it('keeps the rest of the config row intact', async () => {
    mockConfigs(['dev-1']);
    const parsed = JSON.parse(await handlerFor('query_backup_sla')({}, unrestricted()));
    expect(parsed.configs[0].id).toBe('cfg-1');
    expect(parsed.configs[0].name).toBe('Nightly');
    expect(parsed.configs[0].targetDevices).toBeUndefined();
  });
});
