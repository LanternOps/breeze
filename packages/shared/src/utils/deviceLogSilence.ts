/**
 * "Heartbeating but shipping no logs" device condition (#7067, split out of
 * #4073). A device can heartbeat normally while its log-shipping channel is
 * dead (disabled, failing, or never reaching the endpoint) — the server has
 * no way to tell that apart from a device that is legitimately quiet unless
 * it tracks the latest log-ingest time itself.
 *
 * `devices.last_log_at` is stamped by the agent-logs ingest route
 * (apps/api/src/routes/agents/logs.ts), throttled so a batch that moved the
 * value by less than 5 minutes costs no write. This condition does not raise
 * an alert by itself (that is a separate, opt-in alert-policy question) — it
 * only makes the state queryable and displayable, following the same
 * shape as `isAgentUpdateStuck` (agentUpdateAttempt.ts) for #4073.
 *
 * Shared so the API (which derives the flag for responses) and the web
 * client (which derives it for display) use one definition.
 */

/**
 * A heartbeating device with no log-ingest activity for at least this long is
 * "log silent". Wide enough that routine quiet periods (an agent whose log
 * level legitimately emits little) don't false-positive, while still well
 * under the kind of multi-day silence that went unnoticed in #4073.
 */
export const DEVICE_LOG_SILENCE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

type Timestamp = Date | string | null | undefined;

function toTime(value: Timestamp): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when the device is online (heartbeating) and has not shipped a log in
 * at least DEVICE_LOG_SILENCE_THRESHOLD_MS.
 *
 * A device that has never shipped a log (`lastLogAt` is null — new agents,
 * agents predating this column, or a device that has simply never had
 * anything to log) is treated as silent only once it has been enrolled long
 * enough that a log would be expected by now; otherwise a freshly enrolled
 * device would read as silent purely because the column hasn't been stamped
 * yet.
 */
export function isDeviceLogSilent(
  device: {
    status: string | null | undefined;
    lastLogAt: Timestamp;
    enrolledAt?: Timestamp;
  },
  now: Date = new Date(),
): boolean {
  if (device.status !== 'online') return false;

  const nowMs = now.getTime();
  const lastLogMs = toTime(device.lastLogAt);
  if (lastLogMs !== null) {
    return nowMs - lastLogMs >= DEVICE_LOG_SILENCE_THRESHOLD_MS;
  }

  const enrolledMs = toTime(device.enrolledAt);
  if (enrolledMs === null) return true;
  return nowMs - enrolledMs >= DEVICE_LOG_SILENCE_THRESHOLD_MS;
}
