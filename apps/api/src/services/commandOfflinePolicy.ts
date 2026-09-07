import { CommandTypes } from './commandTypes';

/**
 * Whether a device command may wait for an offline device, and for how long
 * (#5128 §A). `reject` = the caller needs a live socket now and gets today's
 * `device_offline` error; `queue` = persist the row with a delivery deadline
 * and let the agent's next heartbeat claim it.
 */
export type OfflinePolicy = { kind: 'reject' } | { kind: 'queue'; deliverWithinMs: number };

/** TTL class = how long a queued row may wait for the device (OD-1). */
export type DeliveryTtlClass = 'live' | 'standard' | 'short' | 'power_state';

/**
 * A `reject` command is only ever enqueued against a device we just observed
 * online, so its row still gets a (short) deadline: a row that raced a
 * disconnect must not linger as `pending` forever.
 */
export const REJECT_RACE_GRACE_MS = 5 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

export class UnregisteredCommandTypeError extends Error {
  constructor(public readonly commandType: string) {
    super(
      `Command type "${commandType}" has no entry in COMMAND_OFFLINE_POLICY_REGISTRY ` +
        '(services/commandOfflinePolicy.ts) — register it with a TTL class before dispatching it'
    );
    this.name = 'UnregisteredCommandTypeError';
  }
}

function envHours(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function deliveryTtlMs(cls: DeliveryTtlClass): number {
  switch (cls) {
    case 'live':
      return REJECT_RACE_GRACE_MS;
    case 'standard':
      return envHours('DEVICE_COMMAND_QUEUE_TTL_HOURS', 168) * HOUR_MS;
    case 'short':
      return envHours('DEVICE_COMMAND_QUEUE_SHORT_TTL_HOURS', 24) * HOUR_MS;
    case 'power_state':
      return envHours('DEVICE_COMMAND_QUEUE_POWER_STATE_TTL_HOURS', 24) * HOUR_MS;
  }
}

/**
 * Gates the `queue` arm for callers that hard-rejected offline devices before
 * #5128 (patch executor, automations, scan/rollback, AI tools). Scripts,
 * software installs and the generic device-command routes already queued and
 * are NOT gated. Defaults on once W3/W4 ship; removed the release after.
 */
export function isOfflineQueueEnabled(): boolean {
  return process.env.DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED === 'true';
}

const C = CommandTypes;

/**
 * Interactive / read-now types: the caller is holding a socket or waiting on a
 * synchronous answer, so an offline device is a hard `device_offline`.
 */
const LIVE: readonly string[] = [
  C.LIST_PROCESSES,
  C.GET_PROCESS,
  C.KILL_PROCESS,
  C.LIST_SERVICES,
  C.GET_SERVICE,
  C.START_SERVICE,
  C.STOP_SERVICE,
  C.RESTART_SERVICE,
  C.EVENT_LOGS_LIST,
  C.EVENT_LOGS_QUERY,
  C.EVENT_LOG_GET,
  C.TASKS_LIST,
  C.TASK_GET,
  C.TASK_RUN,
  C.TASK_ENABLE,
  C.TASK_DISABLE,
  C.TASK_HISTORY,
  C.REGISTRY_KEYS,
  C.REGISTRY_VALUES,
  C.REGISTRY_GET,
  C.REGISTRY_SET,
  C.REGISTRY_DELETE,
  C.REGISTRY_KEY_CREATE,
  C.REGISTRY_KEY_DELETE,
  C.FILE_LIST,
  C.FILE_READ,
  C.FILE_WRITE,
  C.FILE_DELETE,
  C.FILE_MKDIR,
  C.FILE_RENAME,
  C.FILE_COPY,
  C.FILE_TRASH_LIST,
  C.FILE_TRASH_RESTORE,
  C.FILE_TRASH_PURGE,
  C.FILE_LIST_DRIVES,
  C.TERMINAL_START,
  C.TERMINAL_DATA,
  C.TERMINAL_RESIZE,
  C.TERMINAL_STOP,
  // Cancels a command the agent is running RIGHT NOW; queueing one is meaningless.
  C.SCRIPT_CANCEL,
  C.TAKE_SCREENSHOT,
  C.COMPUTER_ACTION,
  C.COLLECT_BOOT_PERFORMANCE,
  C.VSS_STATUS,
  C.VSS_WRITER_LIST,
  C.MSSQL_DISCOVER,
  C.HYPERV_DISCOVER,
  C.HYPERV_VM_STATE,
  C.VM_RESTORE_ESTIMATE,
  C.VAULT_STATUS,
  // Addressed to a RELAY agent on the target's LAN — that relay must be online.
  C.WAKE_ON_LAN,
  C.CAPTURE_PPROF,
  // Non-CommandTypes literals whose only dispatch path is `executeCommand`,
  // which waits for the result synchronously (`waitForCommandResult`) — the one
  // combination the design forbids pairing with `queue` (#5128 §A). The two
  // agent-binary types are additionally refused by `queueCommand` outright
  // (AGENT_BINARY_UPDATE_COMMAND_TYPES, #4093), so `live` is the only
  // self-consistent class for them.
  'network_discovery',
  'update_agent',
  'update_watchdog',
  'restart_agent',
  // Session-bound: a PAM elevation grant and a remote-desktop stream stop are
  // meaningless once the session they belong to is gone.
  'actuate_elevation',
  'desktop_stream_stop',
];

/**
 * Backup / restore / verification stay hard-gated in v1 (#5128 "Out of scope":
 * they own a scheduler and a per-device execution slot from #4923). Classifying
 * them `live` here is what keeps them rejecting once the feature flag flips on
 * in W4 — the flag alone would otherwise let them queue.
 */
const BACKUP_AND_RESTORE: readonly string[] = [
  C.BACKUP_RUN,
  C.BACKUP_STOP,
  C.BACKUP_RESTORE,
  C.BACKUP_VERIFY,
  C.BACKUP_TEST_RESTORE,
  C.BACKUP_CLEANUP,
  C.MSSQL_BACKUP,
  C.MSSQL_RESTORE,
  C.MSSQL_VERIFY,
  C.HYPERV_BACKUP,
  C.HYPERV_RESTORE,
  C.VM_RESTORE_FROM_BACKUP,
  C.VM_INSTANT_BOOT,
  C.BMR_RECOVER,
];

/**
 * Config / inventory syncs that converge: a stale one has no value once a newer
 * push supersedes it, so they expire in a day rather than a week (OD-1).
 */
const SHORT: readonly string[] = [
  C.REFRESH_INVENTORY,
  C.SET_LOG_LEVEL,
  C.PERIPHERAL_POLICY_SYNC,
  C.PERIPHERAL_POLICY_SYNC_V2,
  C.MANAGE_STARTUP_ITEM,
  C.COLLECT_AUDIT_POLICY,
  C.SECURITY_COLLECT_STATUS,
  C.COLLECT_RELIABILITY_METRICS,
  C.SYSTEM_STATE_COLLECT,
  C.HARDWARE_PROFILE,
  C.ENCRYPTION_COLLECT_KEYS,
  C.HYPERV_CHECKPOINT,
  // Agent-version management: pinned to the version running now, so a week-old
  // rollback or self-update is the wrong instruction by the time it lands.
  C.AGENT_ROLLBACK_V1,
  'update',
  'set_auto_update',
  // Policy push that converges: the next sync supersedes a stale one.
  'apply_browser_policy',
];

/**
 * Disruptive power-state changes. Short TTL AND the claim-time barrier in
 * `commandClaimEligibility.ts` (claimed alone, nothing else in flight).
 * `schedule_reboot` shares the TTL — a scheduled restart delivered a week late
 * is wrong — but not the barrier: it only asks the agent to schedule, and the
 * agent owns the delay and user deferral from there.
 */
const POWER_STATE: readonly string[] = ['reboot', 'shutdown', C.REBOOT_SAFE_MODE, 'schedule_reboot'];

/**
 * Command type literals the API writes that are NOT members of `CommandTypes`:
 * the generic device-command route enums (`routes/devices/schemas.ts`), the
 * fleet-findings dispatch map, and the reboot handlers. They are listed here
 * explicitly so the fail-closed registry cannot throw on a reboot.
 * ('wake' is the route-facing spelling; the route rewrites it to `wake_on_lan`
 * before it reaches the seam, but both are classified so either spelling is
 * safe.)
 */
const EXTRA_ROUTE_TYPES: readonly string[] = [
  'reboot',
  'shutdown',
  'reboot_safe_mode',
  'schedule_reboot',
  'update',
  'set_auto_update',
  'wake',
  'network_discovery',
  'update_agent',
  'update_watchdog',
  'restart_agent',
  'actuate_elevation',
  'desktop_stream_stop',
  'apply_browser_policy',
];

// Build the registry from CommandTypes so a NEW type cannot be added without
// also being classified. A type added to CommandTypes but to none of the lists
// lands in `standard`, the safe default for fire-and-forget work — a type that
// must NOT queue has to be listed in LIVE (or BACKUP_AND_RESTORE).
const registry: Record<string, DeliveryTtlClass> = {};
for (const type of Object.values(CommandTypes)) registry[type] = 'standard';
for (const type of EXTRA_ROUTE_TYPES) registry[type] = 'standard';
for (const type of LIVE) registry[type] = 'live';
for (const type of BACKUP_AND_RESTORE) registry[type] = 'live';
for (const type of SHORT) registry[type] = 'short';
for (const type of POWER_STATE) registry[type] = 'power_state';
registry.wake = 'live';

export const COMMAND_OFFLINE_POLICY_REGISTRY: Readonly<Record<string, DeliveryTtlClass>> = Object.freeze(registry);

export function defaultOfflinePolicy(type: string): OfflinePolicy {
  const cls = COMMAND_OFFLINE_POLICY_REGISTRY[type];
  if (!cls) throw new UnregisteredCommandTypeError(type);
  if (cls === 'live') return { kind: 'reject' };
  return { kind: 'queue', deliverWithinMs: deliveryTtlMs(cls) };
}

/**
 * Resolves the policy for one enqueue. An explicit `requested` policy always
 * wins — but the type is still looked up first so an unregistered type throws
 * whichever way it was called.
 */
export function resolveOfflinePolicy(
  type: string,
  requested: OfflinePolicy | undefined,
  opts: { previouslyRejected: boolean }
): OfflinePolicy {
  const def = defaultOfflinePolicy(type);
  if (requested) return requested;
  if (def.kind === 'queue' && opts.previouslyRejected && !isOfflineQueueEnabled()) return { kind: 'reject' };
  return def;
}

export function deliverByFor(policy: OfflinePolicy, now: Date = new Date()): Date {
  const ms = policy.kind === 'queue' ? policy.deliverWithinMs : REJECT_RACE_GRACE_MS;
  return new Date(now.getTime() + ms);
}
