import { beforeEach, expect, it, vi } from 'vitest';
import { WORKLOAD_INVENTORY_DEFAULTS } from '@breeze/shared';

const m = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('./settings', () => ({ getDeviceWorkloadInventorySettings: m.get }));
import { buildResolvedWorkloadInventoryConfigUpdate, toWorkloadInventoryConfigUpdate } from './configUpdate';

beforeEach(() => {
  m.get.mockReset();
});

it('sends explicit defaults (enabled: false) when no policy applies, so removing a policy turns collection off', async () => {
  m.get.mockResolvedValue({ orgId: 'org-1', settings: WORKLOAD_INVENTORY_DEFAULTS });
  expect(await buildResolvedWorkloadInventoryConfigUpdate('device-1')).toEqual({
    enabled: false,
    docker_enabled: true,
    podman_enabled: true,
    hyperv_enabled: true,
    proxmox_enabled: true,
    interval_minutes: 60,
  });
});

it('maps every setting to its snake_case wire key', () => {
  expect(
    toWorkloadInventoryConfigUpdate({
      enabled: true,
      dockerEnabled: false,
      podmanEnabled: true,
      hypervEnabled: false,
      proxmoxEnabled: true,
      intervalMinutes: 30,
    }),
  ).toEqual({
    enabled: true,
    docker_enabled: false,
    podman_enabled: true,
    hyperv_enabled: false,
    proxmox_enabled: true,
    interval_minutes: 30,
  });
});

it('rejects when the resolver fails, so the heartbeat omits the key instead of sending defaults', async () => {
  m.get.mockRejectedValue(new Error('policy read failed'));
  await expect(buildResolvedWorkloadInventoryConfigUpdate('device-1')).rejects.toThrow('policy read failed');
});
