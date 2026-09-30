import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
vi.mock('../../db', () => ({ db: { select: (...a: unknown[]) => selectMock(...a) } }));
vi.mock('../../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.org_id', displayName: 'devices.display_name', hostname: 'devices.hostname' },
}));

import { attachDeviceNames, restoreModeFromTargetConfig } from './deviceNames';

const chain = (rows: unknown[]) => ({ from: () => ({ where: () => Promise.resolve(rows) }) });

describe('attachDeviceNames (#7213)', () => {
  beforeEach(() => selectMock.mockReset());

  it('adds displayName, falling back to hostname, and null when unknown', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 'd1', displayName: 'Front Desk', hostname: 'fd-01' },
      { id: 'd2', displayName: null, hostname: 'srv-02' },
    ]));
    const out = await attachDeviceNames('org-1', [{ deviceId: 'd1' }, { deviceId: 'd2' }, { deviceId: 'd3' }, { deviceId: 'd1' }]);
    expect(out.map((r) => r.deviceName)).toEqual(['Front Desk', 'srv-02', null, 'Front Desk']);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('skips the query when there are no rows', async () => {
    expect(await attachDeviceNames('org-1', [])).toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('degrades to null names if the lookup fails', async () => {
    selectMock.mockImplementationOnce(() => { throw new Error('boom'); });
    const out = await attachDeviceNames('org-1', [{ deviceId: 'd1' }]);
    expect(out[0]?.deviceName).toBeNull();
  });
});

describe('restoreModeFromTargetConfig', () => {
  it('classifies instant boot, VM restore, and plain restores', () => {
    expect(restoreModeFromTargetConfig({ mode: 'instant_boot', vmName: 'x' })).toBe('instant_boot');
    expect(restoreModeFromTargetConfig({ hypervisor: 'hyperv', vmName: 'x' })).toBe('vm');
    expect(restoreModeFromTargetConfig({ commandType: 'backup_restore' })).toBeNull();
    expect(restoreModeFromTargetConfig(null)).toBeNull();
  });

  it('classifies a rebuild-engine job (targetConfig.mode rebuild_vhdx) as rebuild, not a plain full restore', () => {
    expect(restoreModeFromTargetConfig({
      mode: 'rebuild_vhdx',
      engine: 'rebuild',
      outputPath: 'C:\\Rebuild\\srv-01.vhdx',
      recoveryId: 'rec-1',
    })).toBe('rebuild');
  });
});
