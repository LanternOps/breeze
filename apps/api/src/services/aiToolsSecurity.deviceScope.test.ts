/**
 * #6096 finding 9 — `get_security_posture` with `deviceId` omitted listed every
 * device's posture in the org (scores, factor details, recommendations). The
 * declarative `deviceArgs` gate only covers the per-device branch, so a
 * device-bound AI run enumerated the whole fleet's security weak points — the
 * sibling tool `get_sensitive_data_overview` in the same file already narrows
 * via `resolveSiteAllowedDeviceIds`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./securityPosture', () => ({
  getLatestSecurityPostureForDevice: vi.fn(),
  listLatestSecurityPosture: vi.fn(),
}));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('./aiDispatch', () => ({ aiExecuteCommand: vi.fn(), aiQueueCommand: vi.fn() }));
vi.mock('./sensitiveDataKeys', () => ({ resolveSensitiveDataKeySelection: vi.fn() }));

import { db } from '../db';
import { listLatestSecurityPosture } from './securityPosture';
import { registerSecurityTools } from './aiToolsSecurity';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerSecurityTools(reg);
  return reg.get(name)!.handler;
}

function auth(allowedDeviceIds?: string[], allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'ai_agent' },
    user: { id: 'u1' },
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedDeviceIds,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as unknown as AuthContext;
}

const POSTURES = [
  { orgId: 'org-1', deviceId: 'dev-1', deviceName: 'own', overallScore: 80, riskLevel: 'low', recommendations: [] },
  { orgId: 'org-1', deviceId: 'dev-2', deviceName: 'SIBLING-HOST', overallScore: 10, riskLevel: 'critical', recommendations: ['SIBLING-WEAKNESS'] },
];

beforeEach(() => {
  vi.clearAllMocks();
  // The service now narrows in SQL, so the fake honours `deviceIds` — a tool
  // that stops passing it gets the sibling row back and the tests go red.
  vi.mocked(listLatestSecurityPosture).mockImplementation(async (filter: any) =>
    (filter?.deviceIds ? POSTURES.filter((p) => filter.deviceIds.includes(p.deviceId)) : POSTURES) as any
  );
  mockDb.select.mockReturnValue({
    from: () => ({ where: () => Promise.resolve([{ id: 'dev-1', siteId: 'site-1' }, { id: 'dev-2', siteId: 'site-1' }]) }),
  });
});

describe('get_security_posture (fleet branch) — exact-device scope', () => {
  it('does not report a sibling device to a device-bound run', async () => {
    const out = JSON.parse(await handlerFor('get_security_posture')({}, auth(['dev-1'], ['site-1'])));
    expect(out.devices.map((d: any) => d.deviceId)).toEqual(['dev-1']);
    expect(out.summary.totalDevices).toBe(1);
    expect(JSON.stringify(out)).not.toContain('SIBLING-WEAKNESS');
  });

  it('does not report it to a device-LESS analysis run either', async () => {
    const out = JSON.parse(await handlerFor('get_security_posture')({}, auth(['dev-1'], undefined)));
    expect(out.devices.map((d: any) => d.deviceId)).toEqual(['dev-1']);
  });

  it('unrestricted caller sees the whole fleet (no regression)', async () => {
    const out = JSON.parse(await handlerFor('get_security_posture')({}, auth(undefined, undefined)));
    expect(out.devices.map((d: any) => d.deviceId)).toEqual(['dev-1', 'dev-2']);
  });

  it('a restricted caller with zero in-scope devices gets an explicit empty result', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve([]) }) });
    const out = JSON.parse(await handlerFor('get_security_posture')({}, auth(['dev-1'], ['site-1'])));
    expect(out.devices).toEqual([]);
    expect(out.note).toBeTruthy();
  });
});

describe('get_security_posture (fleet branch) — narrowing happens in the query', () => {
  it('passes the resolved allowlist as deviceIds so limit bounds the narrowed set', async () => {
    await handlerFor('get_security_posture')({ limit: 5 }, auth(['dev-1'], ['site-1']));
    const filter = vi.mocked(listLatestSecurityPosture).mock.calls[0]![0] as any;
    expect(filter.deviceIds).toEqual(['dev-1']);
    expect(filter.limit).toBe(5);
  });

  it('passes no deviceIds for an unrestricted caller', async () => {
    await handlerFor('get_security_posture')({}, auth(undefined, undefined));
    const filter = vi.mocked(listLatestSecurityPosture).mock.calls[0]![0] as any;
    expect(filter.deviceIds).toBeUndefined();
  });
});
