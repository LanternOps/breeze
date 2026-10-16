/**
 * When Home refetches the alerts slice that backs the header StatusPill
 * (#8890). The fleet strip fetches `/mobile/summary` on its own, so the pill
 * used to disagree with it after alerts were resolved through chat: the slice
 * only refetched on tab focus, and a chat turn never changes focus.
 *
 * Pure module (no React Native imports) so the rule is testable.
 */
export type AlertRefreshTrigger = 'focus' | 'foreground' | 'turn_done';

/** Collapses back-to-back triggers (focus + foreground fire together on resume). */
export const ALERT_REFRESH_MIN_GAP_MS = 1500;

export function shouldRefreshAlerts(
  _trigger: AlertRefreshTrigger,
  msSinceLastFetch: number,
): boolean {
  return msSinceLastFetch >= ALERT_REFRESH_MIN_GAP_MS;
}
