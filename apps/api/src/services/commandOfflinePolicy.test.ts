import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandTypes } from './commandTypes';
import { createCommandSchema, bulkCommandSchema } from '../routes/devices/schemas';
import {
  COMMAND_OFFLINE_POLICY_REGISTRY,
  EXPLICITLY_CLASSIFIED_COMMAND_TYPES,
  REJECT_RACE_GRACE_MS,
  UnregisteredCommandTypeError,
  defaultOfflinePolicy,
  deliverByFor,
  deliveryTtlMs,
  isOfflineQueueEnabled,
  resolveOfflinePolicy,
} from './commandOfflinePolicy';

describe('commandOfflinePolicy registry (#5128 W1)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('covers every CommandTypes value (fail-closed)', () => {
    const missing = Object.values(CommandTypes).filter((t) => !(t in COMMAND_OFFLINE_POLICY_REGISTRY));
    expect(missing).toEqual([]);
  });

  it('covers every type the generic device-command routes accept', () => {
    // The route enums carry literals that are NOT in CommandTypes ('reboot',
    // 'shutdown', 'update', 'wake'), so the registry must classify them too or
    // the seam throws on a reboot.
    const routeTypes = new Set<string>([
      ...createCommandSchema.shape.type.options,
      ...bulkCommandSchema.shape.type.options,
    ]);
    const missing = [...routeTypes].filter((t) => !(t in COMMAND_OFFLINE_POLICY_REGISTRY));
    expect(missing).toEqual([]);
  });

  it('covers every device_commands.type literal the API writes outside CommandTypes', () => {
    // Swept from every `.insert(deviceCommands)` / queueCommand / executeCommand
    // / queueCommandForExecution call site in apps/api/src (#5128 W1). A type
    // missing here throws at the seam, so this list is the fail-closed contract:
    // add the literal AND its class when a new one appears.
    const extras = [
      'actuate_elevation',
      'apply_browser_policy',
      'desktop_stream_stop',
      'network_discovery',
      'reboot',
      'restart_agent',
      'schedule_reboot',
      'set_auto_update',
      'shutdown',
      'update',
      'update_agent',
      'update_watchdog',
      'wake',
    ];
    const missing = extras.filter((t) => !(t in COMMAND_OFFLINE_POLICY_REGISTRY));
    expect(missing).toEqual([]);
  });

  it('agent-binary and session-bound types reject rather than queue', () => {
    // `update_agent` / `update_watchdog` are refused by queueCommand outright
    // (#4093) and only reach the agent via executeCommand, which waits for the
    // result — the one pairing the design forbids with `queue` (#5128 §A).
    expect(defaultOfflinePolicy('update_agent')).toEqual({ kind: 'reject' });
    expect(defaultOfflinePolicy('update_watchdog')).toEqual({ kind: 'reject' });
    expect(defaultOfflinePolicy('restart_agent')).toEqual({ kind: 'reject' });
    expect(defaultOfflinePolicy('network_discovery')).toEqual({ kind: 'reject' });
    expect(defaultOfflinePolicy('actuate_elevation')).toEqual({ kind: 'reject' });
    expect(defaultOfflinePolicy('desktop_stream_stop')).toEqual({ kind: 'reject' });
    expect(defaultOfflinePolicy('wake')).toEqual({ kind: 'reject' });
  });

  it('schedule_reboot shares the power-state TTL', () => {
    expect(defaultOfflinePolicy('schedule_reboot')).toEqual({
      kind: 'queue',
      deliverWithinMs: deliveryTtlMs('power_state'),
    });
  });

  it('every CommandTypes value is EXPLICITLY classified, never left to the fallback', () => {
    // The registry's fallback is `standard`, i.e. QUEUEABLE. Deferred delivery
    // widens the window in which the authorization behind a command can go
    // stale, so a new command type must not become queueable just because
    // nobody classified it. This is the fail-closed property that
    // UnregisteredCommandTypeError does NOT provide (that only fires for a
    // string absent from CommandTypes entirely).
    const unclassified = Object.values(CommandTypes).filter(
      (t) => !EXPLICITLY_CLASSIFIED_COMMAND_TYPES.has(t)
    );
    expect(unclassified).toEqual([]);
  });

  it('throws for an unregistered type', () => {
    expect(() => defaultOfflinePolicy('definitely_not_a_command')).toThrow(UnregisteredCommandTypeError);
    expect(() => defaultOfflinePolicy('definitely_not_a_command')).toThrow(/COMMAND_OFFLINE_POLICY_REGISTRY/);
  });

  it('rejects live/interactive types and queues fire-and-forget types', () => {
    expect(defaultOfflinePolicy(CommandTypes.TERMINAL_START)).toEqual({ kind: 'reject' });
    expect(defaultOfflinePolicy(CommandTypes.LIST_PROCESSES)).toEqual({ kind: 'reject' });
    expect(defaultOfflinePolicy(CommandTypes.TAKE_SCREENSHOT)).toEqual({ kind: 'reject' });
    expect(defaultOfflinePolicy(CommandTypes.SCRIPT)).toEqual({
      kind: 'queue',
      deliverWithinMs: deliveryTtlMs('standard'),
    });
    expect(defaultOfflinePolicy(CommandTypes.REFRESH_INVENTORY)).toEqual({
      kind: 'queue',
      deliverWithinMs: deliveryTtlMs('short'),
    });
    expect(defaultOfflinePolicy('reboot')).toEqual({
      kind: 'queue',
      deliverWithinMs: deliveryTtlMs('power_state'),
    });
    expect(defaultOfflinePolicy('shutdown')).toEqual({
      kind: 'queue',
      deliverWithinMs: deliveryTtlMs('power_state'),
    });
    expect(defaultOfflinePolicy(CommandTypes.REBOOT_SAFE_MODE)).toEqual({
      kind: 'queue',
      deliverWithinMs: deliveryTtlMs('power_state'),
    });
  });

  it('backup and restore types stay reject (out of scope for v1)', () => {
    expect(defaultOfflinePolicy(CommandTypes.BACKUP_RUN)).toEqual({ kind: 'reject' });
    expect(defaultOfflinePolicy(CommandTypes.BACKUP_RESTORE)).toEqual({ kind: 'reject' });
    expect(defaultOfflinePolicy(CommandTypes.BMR_RECOVER)).toEqual({ kind: 'reject' });
  });

  it('standard TTL is 7 days by default and env-tunable', () => {
    expect(deliveryTtlMs('standard')).toBe(7 * 24 * 60 * 60 * 1000);
    vi.stubEnv('DEVICE_COMMAND_QUEUE_TTL_HOURS', '48');
    expect(deliveryTtlMs('standard')).toBe(48 * 60 * 60 * 1000);
  });

  it('short and power_state TTLs default to 24 hours and are env-tunable', () => {
    expect(deliveryTtlMs('short')).toBe(24 * 60 * 60 * 1000);
    expect(deliveryTtlMs('power_state')).toBe(24 * 60 * 60 * 1000);
    vi.stubEnv('DEVICE_COMMAND_QUEUE_SHORT_TTL_HOURS', '6');
    vi.stubEnv('DEVICE_COMMAND_QUEUE_POWER_STATE_TTL_HOURS', '2');
    expect(deliveryTtlMs('short')).toBe(6 * 60 * 60 * 1000);
    expect(deliveryTtlMs('power_state')).toBe(2 * 60 * 60 * 1000);
  });

  it('an invalid or non-positive TTL env value falls back to the default', () => {
    vi.stubEnv('DEVICE_COMMAND_QUEUE_TTL_HOURS', 'not-a-number');
    expect(deliveryTtlMs('standard')).toBe(7 * 24 * 60 * 60 * 1000);
    vi.stubEnv('DEVICE_COMMAND_QUEUE_TTL_HOURS', '0');
    expect(deliveryTtlMs('standard')).toBe(7 * 24 * 60 * 60 * 1000);
    vi.stubEnv('DEVICE_COMMAND_QUEUE_TTL_HOURS', '-5');
    expect(deliveryTtlMs('standard')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('live TTL is the reject race grace, not a queue window', () => {
    expect(deliveryTtlMs('live')).toBe(REJECT_RACE_GRACE_MS);
  });

  // #5128 W4 flipped the default. This is the ONLY test that asserts the
  // unset-env behaviour — every other flag test stubs the value explicitly, so
  // without this one the default could flip back unnoticed.
  it('defaults ON when the env var is unset, and only an explicit "false" opts out', () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', undefined);
    expect(isOfflineQueueEnabled()).toBe(true);
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', '');
    expect(isOfflineQueueEnabled()).toBe(true);
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'false');
    expect(isOfflineQueueEnabled()).toBe(false);
  });

  it('flag off + previouslyRejected keeps reject; flag on lets the registry queue', () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'false');
    expect(isOfflineQueueEnabled()).toBe(false);
    expect(resolveOfflinePolicy(CommandTypes.INSTALL_PATCHES, undefined, { previouslyRejected: true })).toEqual({
      kind: 'reject',
    });
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'true');
    expect(isOfflineQueueEnabled()).toBe(true);
    expect(resolveOfflinePolicy(CommandTypes.INSTALL_PATCHES, undefined, { previouslyRejected: true }).kind).toBe(
      'queue'
    );
  });

  it('the flag does not gate callers that already queued today', () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'false');
    expect(resolveOfflinePolicy(CommandTypes.SCRIPT, undefined, { previouslyRejected: false }).kind).toBe('queue');
    expect(resolveOfflinePolicy(CommandTypes.SOFTWARE_INSTALL, undefined, { previouslyRejected: false }).kind).toBe(
      'queue'
    );
  });

  it('an explicit requested policy always wins over the flag and the registry', () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'false');
    expect(
      resolveOfflinePolicy(CommandTypes.INSTALL_PATCHES, { kind: 'queue', deliverWithinMs: 1000 }, {
        previouslyRejected: true,
      })
    ).toEqual({ kind: 'queue', deliverWithinMs: 1000 });
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'true');
    expect(resolveOfflinePolicy(CommandTypes.SCRIPT, { kind: 'reject' }, { previouslyRejected: false })).toEqual({
      kind: 'reject',
    });
  });

  it('an explicit policy for an unregistered type still throws (fail-closed)', () => {
    expect(() =>
      resolveOfflinePolicy('definitely_not_a_command', { kind: 'reject' }, { previouslyRejected: false })
    ).toThrow(UnregisteredCommandTypeError);
  });

  it('deliverByFor: queue adds deliverWithinMs; reject gets NO deadline at all', () => {
    const now = new Date('2026-09-06T00:00:00Z');
    expect(deliverByFor({ kind: 'queue', deliverWithinMs: 60_000 }, now)!.toISOString()).toBe(
      '2026-09-06T00:01:00.000Z'
    );
    // #5128 review round 2 (J): a `reject` row is only ever created against a
    // device just observed online, and a NULL deadline puts it back on the
    // legacy execution clock — byte-identical to pre-#5128. Stamping the
    // 5-minute grace instead cut every executeCommand row's window from 30 min
    // to 5, including watchdog-targeted work and barrier-held reboots.
    expect(deliverByFor({ kind: 'reject' }, now)).toBeNull();
  });

  it('REJECT_RACE_GRACE_MS is only the `live` TTL class value, never stamped on a row', () => {
    expect(deliveryTtlMs('live')).toBe(REJECT_RACE_GRACE_MS);
    expect(deliverByFor(defaultOfflinePolicy('list_processes'))).toBeNull();
  });
});
