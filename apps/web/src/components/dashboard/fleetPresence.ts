import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { DeviceStats } from './types';

/**
 * Whether the fleet denominator behind a rollup card is known and non-zero.
 *
 * - `present` — at least one device is enrolled, so an aggregate of zero is a
 *   real finding ("we looked and found nothing").
 * - `none`    — zero devices enrolled. An aggregate of zero means nothing.
 * - `loading` — device count not settled yet; render neutral rather than
 *   flashing an all-clear that may be retracted a tick later.
 * - `unknown` — /devices/stats failed or is permission-hidden, so coverage
 *   can't be proven either way.
 */
export type FleetPresence = 'present' | 'none' | 'loading' | 'unknown';

/**
 * Rollup cards must not render an affirmative "all clear" unless this returns
 * `present`: with zero (or an unknown number of) devices reporting, "nothing
 * found" and "we never looked" are opposite facts that otherwise render
 * identically. See #3613 (and #3536 for the same fix on the Alerts page).
 */
export function fleetPresence(devices: DashboardQueryState<DeviceStats>): FleetPresence {
  // Data wins over the in-flight flags: a background poll keeps the last
  // known count, and that count is still the best answer we have.
  if (devices.data) return devices.data.total > 0 ? 'present' : 'none';
  if (devices.isLoading) return 'loading';
  // Error with nothing cached, or a 403/404 permission-hide.
  return 'unknown';
}
