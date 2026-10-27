/**
 * Audit rows for the restart decisions people make on the device (#10190 W05,
 * #10181).
 *
 * The agent's heartbeat carries `rebootStatus.lastUserAction`
 * `{ action, atUnixMs, renderer }`: the most recent decision the person at the
 * keyboard made on the restart prompt (Postpone or Restart now). The agent
 * re-sends it on EVERY beat while the restart stays scheduled, so this module
 * turns that repeating snapshot into one audit row per decision:
 *
 *   - Dedupe: Redis `SET reboot-user-action:<deviceId>:<atUnixMs> 1 EX 604800
 *     NX`. Only the beat whose SET succeeds writes the row. The 7-day expiry
 *     outlives the 24 h acceptance window below by a wide margin, so a key can
 *     never expire while the agent could still re-send its decision.
 *   - Freshness: a decision older than 24 h, or dated more than 5 minutes
 *     ahead of the server clock, is ignored before Redis is touched. The 24 h
 *     cut keeps a device whose dedupe key was lost (Redis flush or failover)
 *     from re-auditing an old decision as new; the 5-minute skew tolerates an
 *     ordinary clock drift but refuses a timestamp that cannot be a real
 *     decision.
 *   - Redis down or erroring means SKIP (warned, throttled), never "write
 *     anyway": a flapping Redis must not turn every beat into a duplicate row.
 *     The cost is that a decision reported only while Redis is down is not
 *     audited if the agent stops re-sending it before Redis is back.
 *
 * Attribution: `actorType: 'agent'` with the agent's id, like the heartbeat's
 * own `agent.heartbeat.state_change` rows. The person at the keyboard is not
 * an authenticated principal; what the server knows is that the device's
 * agent reported the decision. Rows land on the device (resourceId), so the
 * device Activities tab and the Audit Log show them.
 *
 * Durability is the audit writer's: once the key is claimed the row is handed
 * to `writeAuditEvent`, whose failed inserts go to its in-process retry queue.
 * A row that queue later drops is not retried here (the key stays claimed),
 * the same as every other audit row.
 *
 * Never throws: it runs off the heartbeat's response path and a failure here
 * must not turn a valid beat into an error.
 */
import { writeAuditEvent, type RequestLike } from './auditEvents';
import { getRedis } from './redis';
import { captureException } from './sentry';

export const REBOOT_USER_ACTION_DEDUPE_TTL_SECONDS = 604_800;
export const REBOOT_USER_ACTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const REBOOT_USER_ACTION_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const FAULT_LOG_INTERVAL_MS = 60_000;

export const REBOOT_USER_ACTION_AUDIT_ACTIONS = {
  postponed: 'device.reboot.user_postponed',
  restart_now: 'device.reboot.user_restart_now',
} as const;

export interface RebootUserAction {
  action: keyof typeof REBOOT_USER_ACTION_AUDIT_ACTIONS;
  /** When the person decided, agent clock, Unix milliseconds. */
  atUnixMs: number;
  renderer: 'assist' | 'native' | 'headless';
}

export interface RebootUserActionContext {
  /** The agent heartbeat request: the source of the IP / user-agent attribution. */
  c: RequestLike;
  /** The authenticated agent's id: the row's actorId. */
  agentId?: string;
  /** From the same `rebootStatus` snapshot: the schedule after the decision. */
  scheduledAt?: string;
  deferralsUsed?: number;
  maxDeferrals?: number;
  now?: Date;
}

/** 'written' = handed to the audit writer (see Durability above). */
export type RebootUserActionOutcome =
  | 'written'
  | 'duplicate'
  | 'stale'
  | 'future'
  | 'redis_unavailable'
  | 'redis_error'
  | 'audit_error';

export function rebootUserActionKey(deviceId: string, atUnixMs: number): string {
  return `reboot-user-action:${deviceId}:${atUnixMs}`;
}

/** At most one log line per interval, carrying the count it suppressed. */
function logThrottle(log: (message: string) => void) {
  let lastAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  return {
    emit(message: string): void {
      const now = Date.now();
      if (now - lastAt < FAULT_LOG_INTERVAL_MS) {
        suppressed += 1;
        return;
      }
      const skipped = suppressed;
      lastAt = now;
      suppressed = 0;
      log(message + (skipped ? ` (${skipped} similar suppressed)` : ''));
    },
    reset(): void {
      lastAt = Number.NEGATIVE_INFINITY;
      suppressed = 0;
    },
  };
}

// Heartbeats arrive fleet-wide, so an outage would otherwise log once per beat
// per device with a pending decision. Separate throttles keep one class of
// fault from hiding the other.
const redisFaults = logThrottle((message) => console.warn(message));
const auditFaults = logThrottle((message) => console.error(message));
const futureDecisions = logThrottle((message) => console.warn(message));
const droppedReports = logThrottle((message) => console.warn(message));

/** Test-only: re-arm the log throttles. */
export function __resetRebootUserActionLogThrottleForTests(): void {
  redisFaults.reset();
  auditFaults.reset();
  futureDecisions.reset();
  droppedReports.reset();
}

/**
 * The beat carried `rebootStatus.lastUserAction` but validation dropped it
 * (`parsed` is undefined): an agent build that sends a shape this API does not
 * accept would otherwise lose every decision without a trace. Logged
 * (throttled, with the device id), same idea as notePromptHostReportDropped.
 * Returns whether it was dropped.
 */
export function noteRebootUserActionDropped(
  deviceId: string,
  rawBody: unknown,
  parsed: RebootUserAction | undefined,
): boolean {
  if (parsed !== undefined || !rawBody || typeof rawBody !== 'object') return false;
  const rebootStatus = (rawBody as { rebootStatus?: unknown }).rebootStatus;
  if (!rebootStatus || typeof rebootStatus !== 'object') return false;
  if ((rebootStatus as { lastUserAction?: unknown }).lastUserAction === undefined) return false;
  droppedReports.emit(
    `[rebootUserAction] heartbeat rebootStatus.lastUserAction from device ${deviceId} failed validation and was `
      + 'dropped; that restart decision is not audited (check the agent build)',
  );
  return true;
}

function describeFault(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function skipForRedis(deviceId: string, reason: string): void {
  redisFaults.emit(
    `[rebootUserAction] restart decision audit skipped (${reason}) for device ${deviceId}; `
      + 'it is written on a later beat if the agent still reports it',
  );
}

/**
 * Write one audit row for a restart decision the first time a beat reports it.
 * Returns what happened (for tests and callers that want to count); never
 * throws.
 */
export async function recordRebootUserAction(
  deviceId: string,
  orgId: string,
  userAction: RebootUserAction,
  context: RebootUserActionContext,
): Promise<RebootUserActionOutcome> {
  const nowMs = (context.now ?? new Date()).getTime();
  // Stale is the expected end of a re-sent decision: silent.
  if (nowMs - userAction.atUnixMs > REBOOT_USER_ACTION_MAX_AGE_MS) return 'stale';
  const aheadMs = userAction.atUnixMs - nowMs;
  if (aheadMs > REBOOT_USER_ACTION_MAX_FUTURE_SKEW_MS) {
    // Never expected: a device clock running fast loses every decision.
    futureDecisions.emit(
      `[rebootUserAction] restart decision from device ${deviceId} is dated ${aheadMs} ms ahead of the server clock `
        + 'and was not audited; check the device time sync',
    );
    return 'future';
  }

  let claimed: unknown;
  try {
    const redis = getRedis();
    if (!redis) {
      skipForRedis(deviceId, 'redis_unavailable');
      return 'redis_unavailable';
    }
    // A client that is not ready would park the command in its offline queue
    // and replay it later; skip instead, the agent re-sends on the next beat.
    if (redis.status !== 'ready') {
      skipForRedis(deviceId, `redis_${redis.status}`);
      return 'redis_unavailable';
    }
    claimed = await redis.set(
      rebootUserActionKey(deviceId, userAction.atUnixMs),
      '1',
      'EX',
      REBOOT_USER_ACTION_DEDUPE_TTL_SECONDS,
      'NX',
    );
  } catch (error) {
    skipForRedis(deviceId, describeFault(error));
    return 'redis_error';
  }
  if (claimed !== 'OK') return 'duplicate';

  try {
    writeAuditEvent(context.c, {
      orgId,
      action: REBOOT_USER_ACTION_AUDIT_ACTIONS[userAction.action],
      resourceType: 'device',
      resourceId: deviceId,
      actorType: 'agent',
      actorId: context.agentId ?? null,
      result: 'success',
      details: {
        renderer: userAction.renderer,
        deferralsUsed: context.deferralsUsed ?? null,
        maxDeferrals: context.maxDeferrals ?? null,
        scheduledAt: context.scheduledAt ?? null,
        // The row's own timestamp is when the beat arrived, up to a heartbeat
        // interval later; this is when the person actually decided.
        decidedAt: new Date(userAction.atUnixMs).toISOString(),
      },
    });
  } catch (error) {
    // The key is already claimed, so this decision is not retried: a writer
    // that throws synchronously is a code fault, not a transient one (a failed
    // DB insert is queued for retry inside the writer and never lands here).
    captureException(error, undefined, { area: 'reboot_user_action_audit' });
    auditFaults.emit(
      `[rebootUserAction] restart decision audit write failed for device ${deviceId}: ${describeFault(error)}`,
    );
    return 'audit_error';
  }
  return 'written';
}
