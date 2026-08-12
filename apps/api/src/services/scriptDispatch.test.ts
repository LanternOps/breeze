import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SQL, Param } from 'drizzle-orm';

vi.mock('../db', () => ({ db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() } }));
vi.mock('./commandQueue', () => ({ queueCommand: vi.fn() }));
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn().mockResolvedValue(null),
  releaseClaimedCommandDelivery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./sensitiveCommandPayload', () => ({
  encryptSensitivePayloadFields: vi.fn((_t: string, p: unknown) => p),
  decryptCommandForDelivery: vi.fn((c: unknown) => c),
}));
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: vi.fn().mockReturnValue(false) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { db } from '../db';
import { queueCommand } from './commandQueue';
import { claimPendingCommandForDelivery } from './commandDispatch';
import { decryptCommandForDelivery, encryptSensitivePayloadFields } from './sensitiveCommandPayload';
import { sendCommandToAgent } from '../routes/agentWs';
import { captureException } from './sentry';
import { dispatchScriptToDevice } from './scriptDispatch';

const savedScript = (o = {}) => ({
  id: 'script-1', orgId: 'org-a', partnerId: null, isSystem: false,
  osTypes: ['linux'], language: 'bash', content: 'echo hi',
  timeoutSeconds: 60, runAs: 'system', deletedAt: null, ...o,
}) as any;

const device = (o = {}) => ({
  id: 'device-1', orgId: 'org-a', osType: 'linux', status: 'online', agentId: null, ...o,
}) as any;

const insertReturning = (rows: unknown[]) => ({
  values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
});

// Mocks the cleanup delete (`db.delete(...).where(...).returning(...)`).
// `rows` models what the delete actually removed — pass `[]` to model a
// 0-row delete (execution wasn't pending anymore), or configure `whereImpl`
// to reject to model a transient cleanup-DB failure.
const mockDiscardDelete = (rows: unknown[] | (() => Promise<unknown[]>)) => {
  const returning = typeof rows === 'function'
    ? vi.fn(rows)
    : vi.fn().mockResolvedValue(rows);
  const del = { where: vi.fn().mockReturnValue({ returning }) };
  vi.mocked(db.delete).mockReturnValue(del as any);
  return del;
};

// Mocks the live `devices.status` re-read the requireOnline gate performs.
// Pass `undefined` to model a device row that no longer exists.
const mockLiveDeviceStatus = (status: string | undefined) => {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(status === undefined ? [] : [{ status }]),
      }),
    }),
  } as any);
};

// Extracts the actually-BOUND query parameters (column name + literal value)
// from a drizzle SQL condition tree, e.g. `and(eq(id, 'exec-1'), eq(status,
// 'pending'))` -> [{ column: 'id', value: 'exec-1' }, { column: 'status',
// value: 'pending' }].
//
// This walks ONLY `SQL`/`Param` nodes (verified via `instanceof` against the
// classes drizzle-orm exports), not the wider object graph. That matters:
// an earlier version of this helper (`collectSqlTokens`) walked every
// object reachable from the condition, including the real (unmocked)
// `scriptExecutions` table/column metadata — which itself contains the
// literal strings 'status' and 'pending' (column name + enum value) via
// circular table<->column references. A `toContain('status')` /
// `toContain('pending')` assertion against that flattened token list passed
// even when the `eq(status, 'pending')` guard was deleted from production
// code entirely, because those tokens leak in from schema metadata
// regardless of the actual WHERE predicate. Restricting the walk to `Param`
// (the runtime-bound value) and `SQL` (the composite condition) nodes makes
// the count and identity of bound parameters reflect the real predicate.
function collectBoundParams(node: unknown): { column: string; value: unknown }[] {
  const found: { column: string; value: unknown }[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown) => {
    if (value == null || typeof value !== 'object') return;
    if (seen.has(value as object)) return;
    seen.add(value as object);
    if (value instanceof Param) {
      // `encoder` is the column the param is bound against — do NOT descend
      // into it (it carries the circular table<->column graph); just read
      // its name.
      const encoder = (value as { encoder?: { name?: string } }).encoder;
      found.push({ column: encoder?.name ?? '<unknown>', value: (value as { value: unknown }).value });
      return;
    }
    if (value instanceof SQL) {
      for (const chunk of (value as unknown as { queryChunks: unknown[] }).queryChunks) visit(chunk);
    }
    // Anything else (columns, tables, StringChunk separators) is not
    // descended into — only SQL/Param nodes can carry bound parameters.
  };
  visit(node);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'exec-1' }]) as any);
  vi.mocked(queueCommand).mockResolvedValue({ id: 'cmd-1', payload: {} } as any);
});

describe('dispatchScriptToDevice — invariants', () => {
  it('rejects a decommissioned device', async () => {
    const r = await dispatchScriptToDevice({ device: device({ status: 'decommissioned' }), source: { kind: 'saved', script: savedScript() } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('device_decommissioned');
    expect(db.insert).not.toHaveBeenCalled();
    // Decommission is permanent — checked against the caller's snapshot with
    // no live re-read.
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects offline device when requireOnline (snapshot and live read agree)', async () => {
    mockLiveDeviceStatus('offline');
    const r = await dispatchScriptToDevice({ device: device({ status: 'offline' }), requireOnline: true, source: { kind: 'saved', script: savedScript() } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('device_offline');
      expect(r.error).toBe('Device is offline, cannot execute command');
    }
  });

  it('queues for an offline device when requireOnline is not set (manual semantics)', async () => {
    const r = await dispatchScriptToDevice({ device: device({ status: 'offline' }), source: { kind: 'saved', script: savedScript() } });
    expect(r.ok).toBe(true);
    // requireOnline:false is deliberate offline-queueing (manual/route
    // semantics) — no live re-read should fire for it.
    expect(db.select).not.toHaveBeenCalled();
  });

  it('requireOnline gate re-reads live status: rejects a stale-online snapshot when the live read says offline', async () => {
    // Automation fleet runs snapshot device status once at run start
    // (automationRuntime.ts:1712/2269) and can dispatch minutes later — the
    // snapshot passed in here says 'online', but the live devices row has
    // since gone offline. The gate must trust the live read, not the
    // snapshot, or it would dispatch to a device that's actually offline.
    mockLiveDeviceStatus('offline');
    const r = await dispatchScriptToDevice({
      device: device({ status: 'online' }), requireOnline: true, source: { kind: 'saved', script: savedScript() },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('device_offline');
      expect(r.error).toBe('Device is offline, cannot execute command');
    }
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('requireOnline gate proceeds when the live read says online, even off a stale non-online snapshot', async () => {
    mockLiveDeviceStatus('online');
    const r = await dispatchScriptToDevice({
      device: device({ status: 'offline' }), requireOnline: true, source: { kind: 'saved', script: savedScript() },
    });
    expect(r.ok).toBe(true);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('requireOnline gate rejects with "Device not found" when the live row is gone', async () => {
    mockLiveDeviceStatus(undefined);
    const r = await dispatchScriptToDevice({
      device: device({ status: 'online' }), requireOnline: true, source: { kind: 'saved', script: savedScript() },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('device_offline');
      expect(r.error).toBe('Device not found');
    }
  });

  it('rejects cross-org saved script (org-equality invariant)', async () => {
    const r = await dispatchScriptToDevice({ device: device({ orgId: 'org-b' }), source: { kind: 'saved', script: savedScript({ orgId: 'org-a' }) } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('org_mismatch');
  });

  it('allows org-null (system/partner-wide) saved script on any device', async () => {
    const r = await dispatchScriptToDevice({ device: device({ orgId: 'org-b' }), source: { kind: 'saved', script: savedScript({ orgId: null }) } });
    expect(r.ok).toBe(true);
  });

  it('rejects OS-incompatible saved script', async () => {
    const r = await dispatchScriptToDevice({ device: device({ osType: 'windows' }), source: { kind: 'saved', script: savedScript({ osTypes: ['linux'] }) } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('os_mismatch');
  });
});

describe('dispatchScriptToDevice — rows and payload', () => {
  it('saved: creates an execution row with the DEVICE org and passes executionId in payload', async () => {
    const r = await dispatchScriptToDevice({
      device: device(), source: { kind: 'saved', script: savedScript(), automationRunId: null },
      parameters: { a: '1' }, triggeredBy: 'user-1', triggerType: 'manual',
    });
    expect(r.ok).toBe(true);
    const execValues = vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0];
    expect(execValues).toMatchObject({ scriptId: 'script-1', deviceId: 'device-1', orgId: 'org-a', triggeredBy: 'user-1', status: 'pending' });
    const [, , payload] = vi.mocked(queueCommand).mock.calls[0]!;
    expect(payload).toMatchObject({ scriptId: 'script-1', executionId: 'exec-1', language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' });
  });

  it('saved: automationRunId lives on the source variant and is forwarded to the insert', async () => {
    await dispatchScriptToDevice({
      device: device(), source: { kind: 'saved', script: savedScript(), automationRunId: 'run-1' },
    });
    const execValues = vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0];
    expect(execValues).toMatchObject({ automationRunId: 'run-1' });
  });

  it('raw: creates NO execution row and uses provenance as payload scriptId', async () => {
    const r = await dispatchScriptToDevice({
      device: device(), source: { kind: 'raw', content: 'ipconfig', language: 'powershell', provenance: 'automation:auto-1' },
      timeoutSeconds: 300, runAs: 'system',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.executionId).toBeNull();
    expect(db.insert).not.toHaveBeenCalled(); // no scriptExecutions insert; command goes via queueCommand
    const [, , payload] = vi.mocked(queueCommand).mock.calls[0]!;
    expect(payload).toMatchObject({ scriptId: 'automation:auto-1', content: 'ipconfig', language: 'powershell' });
    expect((payload as Record<string, unknown>).executionId).toBeUndefined();
  });

  it('canonicalizes number/boolean parameters to strings in the payload (#3409 PR2 Task 7)', async () => {
    await dispatchScriptToDevice({
      device: device(), source: { kind: 'saved', script: savedScript() },
      parameters: { n: 3, b: true, s: 'already-a-string' },
    });
    const [, , payload] = vi.mocked(queueCommand).mock.calls[0]!;
    expect((payload as Record<string, unknown>).parameters).toEqual({ n: '3', b: 'true', s: 'already-a-string' });
  });

  it('does not canonicalize the parameters stored on the script_executions row (raw values preserved for history)', async () => {
    await dispatchScriptToDevice({
      device: device(), source: { kind: 'saved', script: savedScript(), automationRunId: null },
      parameters: { n: 3, b: true },
    });
    const execValues = vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0];
    expect(execValues.parameters).toEqual({ n: 3, b: true });
  });

  it('runs the payload through encryptSensitivePayloadFields before queueCommand', async () => {
    await dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } });
    expect(encryptSensitivePayloadFields).toHaveBeenCalledWith('script', expect.any(Object));
    expect(vi.mocked(encryptSensitivePayloadFields).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(queueCommand).mock.invocationCallOrder[0]!);
  });

  it('input runAs/timeoutSeconds override script defaults', async () => {
    await dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() }, runAs: 'user', timeoutSeconds: 5 });
    const [, , payload] = vi.mocked(queueCommand).mock.calls[0]!;
    expect(payload).toMatchObject({ runAs: 'user', timeoutSeconds: 5 });
  });

  it('deletes the pending execution row if queueCommand throws', async () => {
    mockDiscardDelete([{ id: 'exec-1' }]);
    vi.mocked(queueCommand).mockRejectedValue(new Error('boom'));
    await expect(dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } })).rejects.toThrow('boom');
    expect(db.delete).toHaveBeenCalled();
  });

  it('rethrows the ORIGINAL queueCommand error even if the cleanup delete also throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockDiscardDelete(() => Promise.reject(new Error('cleanup-db-down')));
    vi.mocked(queueCommand).mockRejectedValue(new Error('boom'));
    await expect(dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } })).rejects.toThrow('boom');
    expect(db.delete).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(captureException).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  // A1 regression (#3162 non-throw path): queueCommand can resolve falsy
  // WITHOUT throwing (e.g. a swallowed insert failure inside queueCommand).
  // Before the fix, this branch returned insert_failed but never ran
  // cleanup, orphaning the pending execution row for the reaper to later
  // mislabel 'timeout'.
  it('discards the pending execution row when queueCommand resolves falsy without throwing', async () => {
    mockDiscardDelete([{ id: 'exec-1' }]);
    vi.mocked(queueCommand).mockResolvedValue(undefined as any);
    const r = await dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('insert_failed');
    expect(db.delete).toHaveBeenCalled();
  });

  it('warns when the cleanup delete removes 0 rows (execution was no longer pending)', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockDiscardDelete([]);
    vi.mocked(queueCommand).mockRejectedValue(new Error('boom'));
    await expect(dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } })).rejects.toThrow('boom');
    expect(consoleWarnSpy).toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it('discards the pending execution row when the payload build throws', async () => {
    mockDiscardDelete([{ id: 'exec-1' }]);
    vi.mocked(encryptSensitivePayloadFields).mockImplementationOnce(() => { throw new Error('payload boom'); });
    await expect(dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } })).rejects.toThrow('payload boom');
    expect(db.delete).toHaveBeenCalled();
    expect(queueCommand).not.toHaveBeenCalled();
  });
});

describe('dispatchScriptToDevice — delivery', () => {
  it('claims, decrypts via decryptCommandForDelivery, sends, and marks execution running (guarded)', async () => {
    const setSpy = vi.fn();
    const whereArgs: unknown[] = [];
    vi.mocked(db.update).mockReturnValue({
      set: (vals: Record<string, unknown>) => {
        setSpy(vals);
        return {
          where: (condition: unknown) => {
            whereArgs.push(condition);
            return Promise.resolve(undefined);
          },
        };
      },
    } as any);
    const executedAt = new Date('2026-08-11T00:00:00Z');
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({ executedAt } as any);
    vi.mocked(sendCommandToAgent).mockReturnValue(true);
    const r = await dispatchScriptToDevice({ device: device({ agentId: 'agent-1' }), source: { kind: 'saved', script: savedScript() } });
    expect(decryptCommandForDelivery).toHaveBeenCalled();
    expect(sendCommandToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({ id: 'cmd-1', type: 'script' }));
    if (r.ok) {
      expect(r.delivered).toBe(true);
      expect(r.deliveryOutcome).toBe('sent');
      expect(r.executedAt).toEqual(executedAt);
    }

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith({ status: 'running', startedAt: executedAt });
    expect(whereArgs).toHaveLength(1);
    // Discriminating on the STRUCTURE of the bound parameters (not just
    // their presence anywhere in the SQL node graph — see the comment on
    // `collectBoundParams`): the guard must bind exactly two parameters,
    // one pinning the execution id and one pinning status='pending'. If the
    // `status='pending'` conjunct is removed from production code, this
    // drops to a single bound param and the assertion fails.
    const boundParams = collectBoundParams(whereArgs[0]);
    expect(boundParams).toHaveLength(2);
    expect(boundParams).toEqual(
      expect.arrayContaining([
        { column: 'id', value: 'exec-1' },
        { column: 'status', value: 'pending' },
      ]),
    );
  });

  it('reports claim_lost when claimPendingCommandForDelivery loses the race (no throw)', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue(null);
    const r = await dispatchScriptToDevice({ device: device({ agentId: 'agent-1' }), source: { kind: 'saved', script: savedScript() } });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.delivered).toBe(false);
      expect(r.deliveryOutcome).toBe('claim_lost');
    }
    // A8 warn policy: claim_lost is a normal race outcome (another dispatch
    // path claimed the command first), unlike decrypt_failed/send_failed
    // (had a connected agent and still failed to reach it) — it must NOT warn.
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it('releases the claim when decrypt returns null (does NOT send raw payload)', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({ executedAt: new Date() } as any);
    // Once-only override: the default mock implementation just echoes the
    // command back, and other tests in this suite rely on that default —
    // `mockReturnValueOnce` avoids leaking `null` into later tests (plain
    // `mockReturnValue` is not undone by `vi.clearAllMocks()` in beforeEach).
    vi.mocked(decryptCommandForDelivery).mockReturnValueOnce(null as any);
    const { releaseClaimedCommandDelivery } = await import('./commandDispatch');
    const r = await dispatchScriptToDevice({ device: device({ agentId: 'agent-1' }), source: { kind: 'saved', script: savedScript() } });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(releaseClaimedCommandDelivery).toHaveBeenCalledWith('cmd-1', expect.any(Date));
    expect(db.update).not.toHaveBeenCalled();
    if (r.ok) {
      expect(r.delivered).toBe(false);
      expect(r.deliveryOutcome).toBe('decrypt_failed');
    }
    // decrypt_failed means we had a connected agent and still failed to
    // reach it — operationally distinct from "queued for later", so it warns.
    expect(consoleWarnSpy).toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it('releases the claim when the WS send fails', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({ executedAt: new Date() } as any);
    vi.mocked(sendCommandToAgent).mockReturnValue(false);
    const { releaseClaimedCommandDelivery } = await import('./commandDispatch');
    const r = await dispatchScriptToDevice({ device: device({ agentId: 'agent-1' }), source: { kind: 'saved', script: savedScript() } });
    expect(releaseClaimedCommandDelivery).toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    if (r.ok) {
      expect(r.delivered).toBe(false);
      expect(r.deliveryOutcome).toBe('send_failed');
    }
    expect(consoleWarnSpy).toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it('skips delivery entirely when agentId is null (normal "no agent connected" case, no warn)', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await dispatchScriptToDevice({ device: device({ agentId: null }), source: { kind: 'saved', script: savedScript() } });
    expect(claimPendingCommandForDelivery).not.toHaveBeenCalled();
    if (r.ok) {
      expect(r.delivered).toBe(false);
      expect(r.deliveryOutcome).toBe('no_agent');
    }
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });
});
