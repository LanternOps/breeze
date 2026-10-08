import type { WorkloadInventoryInlineSettings } from '@breeze/shared';
import { getDeviceWorkloadInventorySettings } from './settings';

/** Wire payload for `configUpdate.workload_inventory_settings` (spec §7.2). */
export interface WorkloadInventoryConfigUpdate {
  enabled: boolean;
  docker_enabled: boolean;
  podman_enabled: boolean;
  hyperv_enabled: boolean;
  proxmox_enabled: boolean;
  interval_minutes: number;
}

export function toWorkloadInventoryConfigUpdate(
  settings: WorkloadInventoryInlineSettings,
): WorkloadInventoryConfigUpdate {
  return {
    enabled: settings.enabled,
    docker_enabled: settings.dockerEnabled,
    podman_enabled: settings.podmanEnabled,
    hyperv_enabled: settings.hypervEnabled,
    proxmox_enabled: settings.proxmoxEnabled,
    interval_minutes: settings.intervalMinutes,
  };
}

/**
 * Resolves the device's effective settings into the agent wire payload.
 * Defaults (enabled: false) are returned when no policy applies. Throws on any
 * resolver error — the heartbeat omits the key rather than send defaults that
 * could switch a running collection off.
 */
export async function buildResolvedWorkloadInventoryConfigUpdate(
  deviceId: string,
): Promise<WorkloadInventoryConfigUpdate> {
  const { settings } = await getDeviceWorkloadInventorySettings(deviceId);
  return toWorkloadInventoryConfigUpdate(settings);
}
