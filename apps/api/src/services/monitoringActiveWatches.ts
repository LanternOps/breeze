import { resolveMonitoringConfigForDisplay } from '../routes/agents/helpers';
import { captureException } from './sentry';

/**
 * #8287: `service_process_check_results` is append-only and keyed by nothing
 * that ties a row to the policy/monitor that produced it. When a watch is
 * removed the agent just stops reporting, so the last row (e.g. `not_found`)
 * would render as a live problem until the retention job ages it out.
 *
 * Read-side fix: the device-facing views only show results for watches in the
 * device's CURRENTLY RESOLVED monitoring config — the same set delivered to the
 * agent (`resolveMonitoringConfigForDisplay`: caller's own RLS context, cache read-only). No data is deleted;
 * raw history (`GET /monitoring/results`, retention) is unchanged.
 */

/** Case-insensitive on name: Windows service/process names are case-insensitive. */
export function watchKey(watchType: string, name: string): string {
  return `${watchType}:${name.toLowerCase()}`;
}

/**
 * Keys of the watches currently configured for the device, or `null` when the
 * answer is unknown (resolution omitted / threw). `null` means "do not filter"
 * — failing open shows possibly-stale rows, failing closed would hide real
 * alerts on a transient resolver error.
 */
export async function loadActiveWatchKeys(deviceId: string, orgId: string): Promise<Set<string> | null> {
  try {
    const config = await resolveMonitoringConfigForDisplay(deviceId, orgId);
    if (!config) {
      console.warn('[monitoring] active watches unresolved; showing unfiltered results', { deviceId });
      return null;
    }
    return new Set(config.watches.map((w) => watchKey(w.watch_type, w.name)));
  } catch (err) {
    console.error('[monitoring] could not resolve active watches; showing unfiltered results', { deviceId, error: err });
    captureException(err, undefined, { area: 'monitoring', op: 'active-watches' }, { fingerprint: ['monitoring', 'active-watches'] });
    return null;
  }
}

export function filterToActiveWatches<T extends { watchType: string; name: string }>(
  rows: T[],
  activeKeys: Set<string> | null,
): T[] {
  if (!activeKeys) return rows;
  return rows.filter((r) => activeKeys.has(watchKey(r.watchType, r.name)));
}
