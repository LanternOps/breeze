import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./commandQueue', () => ({
  queueCommandForExecution: vi.fn(async () => ({ command: { id: 'c1', status: 'sent' } })),
}));
vi.mock('./logRedaction', () => ({ redactAgentLogRow: (r: any) => ({ message: r.message, fields: r.fields }) }));

import { db } from '../db';
import { registerAgentLogTools } from './aiToolsAgentLogs';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };
function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerAgentLogTools(reg);
  return reg.get(name)!.handler;
}
function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds, canAccessSite: (s) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  };
}

describe('set_agent_log_level — site scoping (per-device write)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies a device in a forbidden site', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'd1', siteId: 'site-B' }]) }) }) });
    const r = await handlerFor('set_agent_log_level')({ deviceId: 'd1', level: 'debug' }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
  });

  it('unrestricted caller is unaffected', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'd1', siteId: 'site-Z' }]) }) }) });
    const r = await handlerFor('set_agent_log_level')({ deviceId: 'd1', level: 'debug' }, makeAuth(undefined));
    expect(r).not.toContain('access denied');
  });
});

describe('search_agent_logs — site narrowing (list)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty for a site-restricted caller with no in-scope devices, without reading logs', async () => {
    let logRead = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      // resolveSiteAllowedDeviceIds selects { id, siteId }
      if (cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-FORBIDDEN' }]) }) };
      }
      logRead = true;
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) };
    });
    const r = await handlerFor('search_agent_logs')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.count).toBe(0);
    expect(logRead).toBe(false);
  });
});
