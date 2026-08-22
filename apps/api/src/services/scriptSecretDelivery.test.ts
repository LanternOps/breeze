import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SQL, Param } from 'drizzle-orm';

vi.mock('../db', () => ({ db: { select: vi.fn(), update: vi.fn() } }));
vi.mock('./secretCrypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./secretCrypto')>()),
  getActiveSecretEncryptionKeyId: vi.fn(),
}));
vi.mock('./sensitiveCommandPayload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sensitiveCommandPayload')>()),
  terminalPayloadErasureSet: vi.fn(() => ({ payload: 'ERASED-PAYLOAD-SENTINEL' })),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { db } from '../db';
import { deviceCommands, devices, scriptExecutionBatches, scriptExecutions } from '../db/schema';
import { getActiveSecretEncryptionKeyId } from './secretCrypto';
import { terminalPayloadErasureSet } from './sensitiveCommandPayload';
import { SCRIPT_SECRET_ENVELOPE_FIELD } from './scriptSecretEnvelope';
import { captureException } from './sentry';
import type { ClaimedCommand } from './commandDelivery';
import {
  AGENT_UPGRADE_REQUIRED_MESSAGE,
  SCRIPT_SECRET_ENV_REQUIRED_VERSION,
  SECRET_DELIVERY_UNAVAILABLE_MESSAGE,
  SECRETS_RUN_AS_MESSAGE,
  failClaimedSecretCommandsForUnsupportedAgent,
  loadScriptSecretEnvVersion,
  runAsSupportsSecretEnv,
  secretDeliveryPreflight,
} from './scriptSecretDelivery';

const DEVICE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXEC_1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BATCH_1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SECRET_VALUE = 'hunter2-super-secret-value';
const claimedAt = new Date('2026-08-22T00:00:00Z');

// ── Drizzle mock plumbing ────────────────────────────────────────────

// Extracts the actually-BOUND query parameters (column name + literal value)
// from a drizzle SQL condition tree. Walks ONLY `SQL`/`Param` nodes — never
// the column/table metadata graph, which itself contains strings like
// 'status' and would make a `toContain` assertion pass against a deleted
// guard (memory: vacuous_drizzle_where_clause_assertions). Duplicated from
// scriptDispatch.test.ts on purpose (test helpers stay local).
function collectBoundParams(node: unknown): { column: string; value: unknown }[] {
  const found: { column: string; value: unknown }[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown) => {
    if (value == null || typeof value !== 'object') return;
    if (seen.has(value as object)) return;
    seen.add(value as object);
    if (value instanceof Param) {
      const encoder = (value as { encoder?: { name?: string } }).encoder;
      found.push({ column: encoder?.name ?? '<unknown>', value: (value as { value: unknown }).value });
      return;
    }
    if (value instanceof SQL) {
      for (const chunk of (value as unknown as { queryChunks: unknown[] }).queryChunks) visit(chunk);
    } else if (Array.isArray(value)) {
      // `inArray(col, [...])` embeds a plain JS array of Param nodes as one
      // query chunk (drizzle-orm 0.45).
      for (const item of value) visit(item);
    }
  };
  visit(node);
  return found;
}

type SelectCall = { columns: unknown; table: unknown; where: unknown };
type UpdateCall = { table: unknown; set: Record<string, unknown> | undefined; where: unknown };

const selectCalls: SelectCall[] = [];
const updateCalls: UpdateCall[] = [];

// Models `db.select(cols).from(table).where(cond)` resolving to `rows`
// (optionally per-table). Records every call so a test can assert the
// predicate's bound params and the query COUNT.
function mockSelect(rowsFor: (table: unknown) => unknown[] | Promise<unknown[]>) {
  vi.mocked(db.select).mockImplementation(((columns: unknown) => {
    const call: SelectCall = { columns, table: undefined, where: undefined };
    selectCalls.push(call);
    return {
      from: vi.fn((table: unknown) => {
        call.table = table;
        return {
          where: vi.fn((cond: unknown) => {
            call.where = cond;
            return Promise.resolve(rowsFor(table));
          }),
        };
      }),
    };
  }) as any);
}

// Models `db.update(table).set(v).where(cond)` (awaitable) and the same
// chain with `.returning(cols)`; `returningFor` picks the returned rows per
// table, or throws to model a failing write.
function mockUpdate(returningFor: (table: unknown) => unknown[]) {
  vi.mocked(db.update).mockImplementation(((table: unknown) => {
    const call: UpdateCall = { table, set: undefined, where: undefined };
    updateCalls.push(call);
    const resolveRows = () => {
      try {
        return Promise.resolve(returningFor(table));
      } catch (err) {
        return Promise.reject(err);
      }
    };
    return {
      set: vi.fn((values: Record<string, unknown>) => {
        call.set = values;
        return {
          where: vi.fn((cond: unknown) => {
            call.where = cond;
            return Object.assign(resolveRows(), {
              returning: vi.fn(() => resolveRows()),
            });
          }),
        };
      }),
    };
  }) as any);
}

const capabilityRows = (versions: Record<string, number>) =>
  Object.entries(versions).map(([id, scriptSecretEnvVersion]) => ({ id, scriptSecretEnvVersion }));

const envelopeCommand = (o: Partial<ClaimedCommand> = {}): ClaimedCommand => ({
  id: 'cmd-secret',
  type: 'script',
  deviceId: DEVICE_A,
  payload: {
    scriptId: 'script-1',
    executionId: EXEC_1,
    [SCRIPT_SECRET_ENVELOPE_FIELD]: 'enc:v3:key-1:ciphertext',
  },
  executedAt: claimedAt,
  ...o,
});

const plainCommand = (o: Partial<ClaimedCommand> = {}): ClaimedCommand => ({
  id: 'cmd-plain',
  type: 'script',
  deviceId: DEVICE_A,
  payload: { scriptId: 'script-2', parameters: {} },
  executedAt: claimedAt,
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  selectCalls.length = 0;
  updateCalls.length = 0;
  vi.mocked(getActiveSecretEncryptionKeyId).mockReturnValue('key-1');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ── Pure helpers ─────────────────────────────────────────────────────

describe('SCRIPT_SECRET_ENV_REQUIRED_VERSION', () => {
  it('is the PR4b agent capability version', () => {
    expect(SCRIPT_SECRET_ENV_REQUIRED_VERSION).toBe(1);
  });
});

describe('runAsSupportsSecretEnv', () => {
  it.each([
    ['system', undefined, true],
    ['elevated', undefined, true],
    ['user', undefined, false],
    [undefined, undefined, true],
    ['system', 3, false],
    ['elevated', 0, false],
    ['system', null, true],
  ] as const)('runAs=%s targetSessionId=%s → %s', (runAs, targetSessionId, expected) => {
    expect(runAsSupportsSecretEnv(runAs as any, targetSessionId as any)).toBe(expected);
  });
});

// ── loadScriptSecretEnvVersion ───────────────────────────────────────

describe('loadScriptSecretEnvVersion', () => {
  it('reads devices.script_secret_env_version for the device', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: 1 }));
    await expect(loadScriptSecretEnvVersion(DEVICE_A)).resolves.toBe(1);
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0]!.table).toBe(devices);
    expect(collectBoundParams(selectCalls[0]!.where)).toEqual([{ column: 'id', value: DEVICE_A }]);
  });

  it('returns null when the device row is gone', async () => {
    mockSelect(() => []);
    await expect(loadScriptSecretEnvVersion(DEVICE_A)).resolves.toBeNull();
  });
});

// ── secretDeliveryPreflight ──────────────────────────────────────────

describe('secretDeliveryPreflight', () => {
  it('refuses a user-context run before touching the key or the DB', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: 1 }));
    const r = await secretDeliveryPreflight({ deviceId: DEVICE_A, runAs: 'user' });
    expect(r).toEqual({ ok: false, code: 'secrets_unsupported_run_as', error: SECRETS_RUN_AS_MESSAGE });
    expect(getActiveSecretEncryptionKeyId).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('refuses a targeted-session run even as system', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: 1 }));
    const r = await secretDeliveryPreflight({ deviceId: DEVICE_A, runAs: 'system', targetSessionId: 2 });
    expect(r).toEqual({ ok: false, code: 'secrets_unsupported_run_as', error: SECRETS_RUN_AS_MESSAGE });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('refuses when no secret-encryption key is active, before the capability query', async () => {
    vi.mocked(getActiveSecretEncryptionKeyId).mockReturnValue(null);
    mockSelect(() => capabilityRows({ [DEVICE_A]: 1 }));
    const r = await secretDeliveryPreflight({ deviceId: DEVICE_A, runAs: 'system' });
    expect(r).toEqual({
      ok: false,
      code: 'secret_delivery_unavailable',
      error: SECRET_DELIVERY_UNAVAILABLE_MESSAGE,
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('refuses a device whose agent reports capability 0', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: 0 }));
    const r = await secretDeliveryPreflight({ deviceId: DEVICE_A, runAs: 'elevated' });
    expect(r).toEqual({ ok: false, code: 'agent_upgrade_required', error: AGENT_UPGRADE_REQUIRED_MESSAGE });
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0]!.table).toBe(devices);
    expect(collectBoundParams(selectCalls[0]!.where)).toEqual([{ column: 'id', value: DEVICE_A }]);
  });

  it('refuses when the device row is gone (fail closed, not open)', async () => {
    mockSelect(() => []);
    const r = await secretDeliveryPreflight({ deviceId: DEVICE_A, runAs: 'system' });
    expect(r).toEqual({ ok: false, code: 'agent_upgrade_required', error: AGENT_UPGRADE_REQUIRED_MESSAGE });
  });

  it('passes at the required version', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: SCRIPT_SECRET_ENV_REQUIRED_VERSION }));
    await expect(secretDeliveryPreflight({ deviceId: DEVICE_A, runAs: 'system' })).resolves.toEqual({ ok: true });
  });

  it('passes at a newer version (floor, not equality)', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: SCRIPT_SECRET_ENV_REQUIRED_VERSION + 1 }));
    await expect(secretDeliveryPreflight({ deviceId: DEVICE_A, runAs: 'system' })).resolves.toEqual({ ok: true });
  });

  it('treats an absent runAs as the system default', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: 1 }));
    await expect(secretDeliveryPreflight({ deviceId: DEVICE_A, runAs: undefined })).resolves.toEqual({ ok: true });
  });
});

// ── failClaimedSecretCommandsForUnsupportedAgent ─────────────────────

describe('failClaimedSecretCommandsForUnsupportedAgent', () => {
  it('returns the batch unchanged and issues NO query when nothing carries an envelope', async () => {
    const claimed = [
      plainCommand(),
      // A non-script command must not be gated even if it happens to carry
      // a field by the same name.
      plainCommand({ id: 'cmd-other', type: 'run_script', payload: { [SCRIPT_SECRET_ENVELOPE_FIELD]: 'x' } }),
      // An envelope that is not a non-empty string is not an envelope.
      plainCommand({ id: 'cmd-empty', payload: { [SCRIPT_SECRET_ENVELOPE_FIELD]: '' } }),
      plainCommand({ id: 'cmd-null-payload', payload: null }),
    ];
    const out = await failClaimedSecretCommandsForUnsupportedAgent(claimed);
    expect(out).toBe(claimed);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('returns an empty batch untouched', async () => {
    await expect(failClaimedSecretCommandsForUnsupportedAgent([])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('leaves an envelope-bearing command alone when the agent is capable (one select, no update)', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: 1 }));
    const claimed = [plainCommand(), envelopeCommand()];
    const out = await failClaimedSecretCommandsForUnsupportedAgent(claimed);
    expect(out.map((c) => c.id)).toEqual(['cmd-plain', 'cmd-secret']);
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0]!.table).toBe(devices);
    expect(collectBoundParams(selectCalls[0]!.where)).toEqual([{ column: 'id', value: DEVICE_A }]);
    expect(db.update).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('fails the envelope-bearing command terminally on a capability-0 agent and returns the siblings', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: 0 }));
    mockUpdate((table) => (table === deviceCommands ? [{ id: 'cmd-secret' }] : [{ id: EXEC_1, scriptId: 'script-1' }]));

    const claimed = [plainCommand(), envelopeCommand(), plainCommand({ id: 'cmd-plain-2' })];
    const out = await failClaimedSecretCommandsForUnsupportedAgent(claimed);

    expect(out.map((c) => c.id)).toEqual(['cmd-plain', 'cmd-plain-2']);
    expect(selectCalls).toHaveLength(1);

    const cmdUpdate = updateCalls.find((u) => u.table === deviceCommands);
    expect(cmdUpdate).toBeDefined();
    expect(cmdUpdate!.set).toEqual(
      expect.objectContaining({
        status: 'failed',
        completedAt: expect.any(Date),
        result: { status: 'failed', error: AGENT_UPGRADE_REQUIRED_MESSAGE, exitCode: 1 },
        payload: 'ERASED-PAYLOAD-SENTINEL',
      }),
    );
    expect(terminalPayloadErasureSet).toHaveBeenCalledTimes(1);
    // Guarded on the claim state: `id = ? AND status = 'sent'` — never an
    // unconditional overwrite of a row something else already drove terminal.
    expect(collectBoundParams(cmdUpdate!.where)).toEqual([
      { column: 'id', value: 'cmd-secret' },
      { column: 'status', value: 'sent' },
    ]);

    // One warning, naming the command and device — never the payload.
    expect(console.warn).toHaveBeenCalledTimes(1);
    const [warnMessage, warnContext] = vi.mocked(console.warn).mock.calls[0]!;
    expect(String(warnMessage)).toContain('[scriptSecretDelivery]');
    expect(warnContext).toEqual(expect.objectContaining({ commandId: 'cmd-secret', deviceId: DEVICE_A }));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('ciphertext');
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('payload');
  });

  it('propagates the failure to the linked script_executions row and bumps the batch failure counter', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: 0 }));
    mockUpdate((table) => (table === deviceCommands ? [{ id: 'cmd-secret' }] : [{ id: EXEC_1, scriptId: 'script-1' }]));

    await failClaimedSecretCommandsForUnsupportedAgent([
      envelopeCommand({ payload: { ...(envelopeCommand().payload as object), batchId: BATCH_1 } }),
    ]);

    const execUpdate = updateCalls.find((u) => u.table === scriptExecutions);
    expect(execUpdate).toBeDefined();
    expect(execUpdate!.set).toEqual(
      expect.objectContaining({
        status: 'failed',
        completedAt: expect.any(Date),
        errorMessage: AGENT_UPGRADE_REQUIRED_MESSAGE,
      }),
    );
    expect(collectBoundParams(execUpdate!.where)).toEqual([
      { column: 'id', value: EXEC_1 },
      { column: 'device_id', value: DEVICE_A },
      { column: 'status', value: 'pending' },
      { column: 'status', value: 'queued' },
      { column: 'status', value: 'running' },
    ]);

    const batchUpdate = updateCalls.find((u) => u.table === scriptExecutionBatches);
    expect(batchUpdate).toBeDefined();
    expect(Object.keys(batchUpdate!.set ?? {})).toEqual(['devicesFailed']);
    expect(collectBoundParams(batchUpdate!.where)).toEqual([
      { column: 'id', value: BATCH_1 },
      { column: 'script_id', value: 'script-1' },
    ]);

    // The command row is updated BEFORE the execution row (the agent-facing
    // state is the one the claim path is racing on).
    expect(updateCalls.map((u) => u.table)).toEqual([deviceCommands, scriptExecutions, scriptExecutionBatches]);
  });

  it('does not touch the batch counter when the execution was already terminal', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: 0 }));
    mockUpdate((table) => (table === deviceCommands ? [{ id: 'cmd-secret' }] : []));

    await failClaimedSecretCommandsForUnsupportedAgent([
      envelopeCommand({ payload: { ...(envelopeCommand().payload as object), batchId: BATCH_1 } }),
    ]);

    expect(updateCalls.map((u) => u.table)).toEqual([deviceCommands, scriptExecutions]);
  });

  it('skips execution propagation when the payload carries no (uuid) executionId', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: 0 }));
    mockUpdate(() => [{ id: 'cmd-secret' }]);

    await failClaimedSecretCommandsForUnsupportedAgent([
      envelopeCommand({ id: 'cmd-no-exec', payload: { [SCRIPT_SECRET_ENVELOPE_FIELD]: 'enc:v3:k:c' } }),
      envelopeCommand({ id: 'cmd-bad-exec', payload: { [SCRIPT_SECRET_ENVELOPE_FIELD]: 'enc:v3:k:c', executionId: 'not-a-uuid' } }),
    ]);

    expect(updateCalls.map((u) => u.table)).toEqual([deviceCommands, deviceCommands]);
  });

  it('does not propagate (or double-count) when the command row was no longer `sent`', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: 0 }));
    mockUpdate(() => []);

    const out = await failClaimedSecretCommandsForUnsupportedAgent([plainCommand(), envelopeCommand()]);

    // Still withheld from delivery — a lost race is not a reason to ship it.
    expect(out.map((c) => c.id)).toEqual(['cmd-plain']);
    expect(updateCalls.map((u) => u.table)).toEqual([deviceCommands]);
  });

  it('treats a missing device row as unsupported', async () => {
    mockSelect(() => []);
    mockUpdate(() => [{ id: 'cmd-secret' }]);
    const out = await failClaimedSecretCommandsForUnsupportedAgent([envelopeCommand()]);
    expect(out).toEqual([]);
    expect(updateCalls[0]?.table).toBe(deviceCommands);
  });

  it('issues ONE capability select for a batch spanning several devices', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: 1, [DEVICE_B]: 0 }));
    mockUpdate(() => [{ id: 'x' }]);

    const out = await failClaimedSecretCommandsForUnsupportedAgent([
      envelopeCommand({ id: 'cmd-a', deviceId: DEVICE_A }),
      envelopeCommand({ id: 'cmd-b', deviceId: DEVICE_B }),
      envelopeCommand({ id: 'cmd-b2', deviceId: DEVICE_B }),
    ]);

    expect(out.map((c) => c.id)).toEqual(['cmd-a']);
    expect(selectCalls).toHaveLength(1);
    const bound = collectBoundParams(selectCalls[0]!.where);
    expect(bound.map((b) => b.column)).toEqual(['id', 'id']);
    expect(bound.map((b) => b.value).sort()).toEqual([DEVICE_A, DEVICE_B].sort());
    expect(updateCalls.filter((u) => u.table === deviceCommands).map((u) => collectBoundParams(u.where)[0]!.value))
      .toEqual(['cmd-b', 'cmd-b2']);
  });

  it('captures a propagation failure and still returns the siblings (and still withholds the command)', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: 0 }));
    mockUpdate((table) => {
      if (table === deviceCommands) return [{ id: 'cmd-secret' }];
      throw new Error('script_executions write exploded');
    });

    const out = await failClaimedSecretCommandsForUnsupportedAgent([plainCommand(), envelopeCommand()]);

    expect(out.map((c) => c.id)).toEqual(['cmd-plain']);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureException).mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(String((vi.mocked(captureException).mock.calls[0]![0] as Error).message)).toContain('cmd-secret');
  });

  it('captures a terminal-update failure, withholds the command, and still returns the siblings', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: 0 }));
    mockUpdate(() => {
      throw new Error('device_commands write exploded');
    });

    const out = await failClaimedSecretCommandsForUnsupportedAgent([envelopeCommand(), plainCommand()]);

    expect(out.map((c) => c.id)).toEqual(['cmd-plain']);
    expect(captureException).toHaveBeenCalledTimes(1);
    // No execution propagation after a failed command write.
    expect(updateCalls.map((u) => u.table)).toEqual([deviceCommands]);
  });

  it('never echoes the envelope or a secret value into logs or Sentry', async () => {
    mockSelect(() => capabilityRows({ [DEVICE_A]: 0 }));
    mockUpdate(() => {
      throw new Error('boom');
    });
    await failClaimedSecretCommandsForUnsupportedAgent([
      envelopeCommand({ payload: { [SCRIPT_SECRET_ENVELOPE_FIELD]: `enc:v3:k:${SECRET_VALUE}`, executionId: EXEC_1 } }),
    ]);
    const everything = JSON.stringify([
      vi.mocked(console.warn).mock.calls,
      vi.mocked(console.error).mock.calls,
      vi.mocked(captureException).mock.calls.map((c) => (c[0] as Error).message),
    ]);
    expect(everything).not.toContain(SECRET_VALUE);
  });
});
