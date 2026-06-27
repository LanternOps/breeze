import type { ConditionHandler } from '../registry';
import type { ConditionResult } from '../types';
import { getDevice } from '../utils';

/**
 * Read the offline duration (in minutes) from a condition, tolerating both the
 * canonical `durationMinutes` field and the legacy `duration` field emitted by
 * the config-policy alert-rule editor under the `status` alias.
 */
function resolveDurationMinutes(condition: unknown): number {
  const c = (condition ?? {}) as Record<string, unknown>;
  const value = typeof c.durationMinutes === 'number' ? c.durationMinutes
    : typeof c.duration === 'number' ? c.duration
    : undefined;
  return value && value > 0 ? value : 5;
}

export const offlineHandler: ConditionHandler = {
  type: 'offline',
  // `status` is the legacy type emitted by the config-policy alert-rule editor
  // for "Device Offline" rules. Already-saved rows carry `{type:'status', duration:N}`.
  aliases: ['status'],

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const device = await getDevice(deviceId);

    if (!device) {
      return { passed: false, description: 'Device not found' };
    }

    const durationMinutes = resolveDurationMinutes(condition);
    const offlineThreshold = new Date(Date.now() - durationMinutes * 60 * 1000);

    // Honor the rule's own duration: the device counts as offline only once its
    // last heartbeat is older than `durationMinutes`. We intentionally do NOT
    // short-circuit on `device.status === 'offline'` — that flag is set by the
    // global ~5-min offline detector and would fire every rule at ~5 min,
    // ignoring longer per-rule durations (issue #1982). `lastSeenAt` is the
    // authoritative last-heartbeat timestamp; a null value means we have no
    // baseline to measure a duration against, so we don't fire.
    const isOffline = device.lastSeenAt !== null && device.lastSeenAt < offlineThreshold;

    return {
      passed: isOffline,
      description: `Device offline for ${durationMinutes}min`
    };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    if (c.durationMinutes !== undefined && typeof c.durationMinutes !== 'number') {
      errors.push(`${path}.durationMinutes: Must be a number`);
    }

    // Legacy `status`-alias rows use `duration` instead of `durationMinutes`.
    if (c.duration !== undefined && typeof c.duration !== 'number') {
      errors.push(`${path}.duration: Must be a number`);
    }

    return errors;
  }
};
