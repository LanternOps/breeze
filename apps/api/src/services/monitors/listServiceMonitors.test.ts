import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';

const mocks = vi.hoisted(() => ({ select: vi.fn(), resolve: vi.fn(), denied: vi.fn() }));
vi.mock('../../db', () => ({ db: { select: mocks.select } }));
vi.mock('./monitorResolver', () => ({ resolveMonitorsForDevice: mocks.resolve }));
vi.mock('../aiToolsSiteScope', () => ({
  siteScopeCondition: vi.fn(), deviceScopeCondition: vi.fn(), deviceSiteDenied: mocks.denied,
}));

import { listEffectiveServiceMonitors, SERVICE_MONITOR_LIST_DEVICE_CAP } from './listServiceMonitors';

const auth = { canAccessOrg: (id: string) => id === 'o1', orgCondition: () => undefined } as unknown as AuthContext;
/** Device query: select().from().where().orderBy().limit(). Definition query: select().from().where(). */
const deviceQuery = (rows: unknown[]) => ({
  from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }),
});
const definitionQuery = (rows: unknown[]) => ({ from: () => ({ where: async () => rows }) });

beforeEach(() => { vi.resetAllMocks(); mocks.denied.mockReturnValue(false); });

describe('effective service monitor AI listing', () => {
  it('reads device-effective overrides and retains disabled attachments', async () => {
    mocks.select.mockReturnValueOnce(deviceQuery([{ id: 'd1', orgId: 'o1', siteId: 's1' }]))
      .mockReturnValueOnce(definitionQuery([{
        id: 'm1', name: 'Spooler', kind: 'service', enabled: true,
        condition: { serviceName: 'Spooler', consecutiveFailures: 2 },
      }]));
    mocks.resolve.mockResolvedValue({
      kind: 'resolved',
      monitors: [{ monitorId: 'm1', enabled: false, sourcePolicyId: 'p1', overrides: { consecutiveFailures: 5 } }],
    });
    expect(await listEffectiveServiceMonitors(auth, 'p1')).toEqual({
      truncated: false,
      monitors: [expect.objectContaining({
        deviceId: 'd1', monitorId: 'm1', sourcePolicyId: 'p1', enabled: false,
        condition: { serviceName: 'Spooler', consecutiveFailures: 5 },
      })],
    });
  });

  it('omits non-service/process definitions the device resolves', async () => {
    mocks.select.mockReturnValueOnce(deviceQuery([{ id: 'd1', orgId: 'o1', siteId: 's1' }]))
      .mockReturnValueOnce(definitionQuery([{ id: 'cpu', name: 'CPU', kind: 'cpu', enabled: true, condition: {} }]));
    mocks.resolve.mockResolvedValue({
      kind: 'resolved', monitors: [{ monitorId: 'cpu', enabled: true, sourcePolicyId: 'p1', overrides: null }],
    });
    expect((await listEffectiveServiceMonitors(auth)).monitors).toEqual([]);
  });

  it('does not resolve foreign-org or forbidden-site devices', async () => {
    mocks.select.mockReturnValueOnce(deviceQuery([{ id: 'd1', orgId: 'o2', siteId: 's1' }, { id: 'd2', orgId: 'o1', siteId: 's2' }]));
    mocks.denied.mockReturnValue(true);
    expect((await listEffectiveServiceMonitors(auth)).monitors).toEqual([]);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('filters winning source policies without querying definitions', async () => {
    mocks.select.mockReturnValueOnce(deviceQuery([{ id: 'd1', orgId: 'o1', siteId: 's1' }]));
    mocks.resolve.mockResolvedValue({ kind: 'resolved', monitors: [{ monitorId: 'm1', sourcePolicyId: 'other', enabled: true, overrides: null }] });
    expect((await listEffectiveServiceMonitors(auth, 'p1')).monitors).toEqual([]);
    expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  it('surfaces resolver failures and a vanished device instead of a silent empty list', async () => {
    mocks.select.mockReturnValue(deviceQuery([{ id: 'd1', orgId: 'o1', siteId: 's1' }]));
    mocks.resolve.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(listEffectiveServiceMonitors(auth)).rejects.toThrow('database unavailable');
    mocks.resolve.mockResolvedValueOnce({ kind: 'device_missing' });
    await expect(listEffectiveServiceMonitors(auth)).rejects.toThrow(/retry/);
  });

  it('reports truncation when more devices exist than the resolution cap', async () => {
    const many = Array.from({ length: SERVICE_MONITOR_LIST_DEVICE_CAP + 1 }, (_, i) => ({ id: `d${i}`, orgId: 'o1', siteId: 's1' }));
    mocks.select.mockReturnValueOnce(deviceQuery(many));
    mocks.resolve.mockResolvedValue({ kind: 'resolved', monitors: [] });
    const result = await listEffectiveServiceMonitors(auth);
    expect(result.truncated).toBe(true);
    expect(mocks.resolve).toHaveBeenCalledTimes(SERVICE_MONITOR_LIST_DEVICE_CAP);
  });
});
