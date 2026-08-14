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
import type { ResolvedVariable, TenantVariableScope } from './tenantVariableResolution';

const savedScript = (o = {}) => ({
  id: 'script-1', orgId: 'org-a', partnerId: null, isSystem: false,
  osTypes: ['linux'], language: 'bash', content: 'echo hi',
  timeoutSeconds: 60, runAs: 'system', deletedAt: null, ...o,
}) as any;

// hostname/siteId/customFields joined the projection in #3409 PR3 P3 and are
// read by the sourced-parameter resolver (the `builtin` and
// `deviceCustomField` sources) — see the sourced-parameters describe block
// at the bottom of this file.
const device = (o = {}) => ({
  id: 'device-1', orgId: 'org-a', osType: 'linux', status: 'online', agentId: null,
  hostname: 'host-1', siteId: 'site-1', customFields: { assetTag: 'A-1' }, ...o,
}) as any;

// #3409 PR2 Task 4: builds a TenantVariableScope directly, bypassing
// loadTenantVariableScope (which needs a real DB query chain and is covered
// on its own in tenantVariableResolution.test.ts). `resolveForOrg` and
// `substituteTenantVariables` are used UNMOCKED here — this exercises the
// real substitution/secret-redaction logic at the dispatch boundary, not a
// hand-tuned mock of it. The shape below mirrors
// tenantVariableResolution.ts's private `InternalTenantVariableScope`
// exactly (orgIds + byOrg); TenantVariableScope itself only declares
// `orgIds`, so this is cast through `unknown`.
const resolvedVar = (key: string, value: string, isSecret = false): ResolvedVariable => ({
  key, value, isSecret, variableId: `var-${key}`, version: 1, ownerScope: 'organization',
});

const buildScope = (orgId: string, vars: ResolvedVariable[] = []): TenantVariableScope => ({
  orgIds: new Set([orgId]),
  byOrg: new Map([[orgId, new Map(vars.map((v) => [v.key, v]))]]),
} as unknown as TenantVariableScope);

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

// #3409 PR2 Task 4: wiring tenant variable resolution into dispatch.
describe('dispatchScriptToDevice — {{var.*}} resolution', () => {
  it('substitutes a non-secret variable into the content that reaches the payload', async () => {
    const scope = buildScope('org-a', [resolvedVar('repo_url', 'https://example.com/pkg')]);
    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript({ content: 'curl {{var.repo_url}}' }) },
      variableScope: scope,
    });
    expect(r.ok).toBe(true);
    const [, , payload] = vi.mocked(queueCommand).mock.calls[0]!;
    expect((payload as Record<string, unknown>).content).toBe('curl https://example.com/pkg');
    expect(JSON.stringify(payload)).not.toContain('{{var.repo_url}}');
  });

  it('fails the device with unresolved_variables when a token has no value', async () => {
    const scope = buildScope('org-a', []); // no variables in the snapshot
    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript({ content: 'curl {{var.repo_url}}' }) },
      variableScope: scope,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unresolved_variables');
    expect(queueCommand).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled(); // no orphan pending execution row
  });

  it('fails the device when the content references a SECRET variable', async () => {
    const scope = buildScope('org-a', [resolvedVar('s1_token', 'shh', true)]);
    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript({ content: 'curl -H "Authorization: {{var.s1_token}}"' }) },
      variableScope: scope,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('unresolved_variables');
      expect(r.error).toMatch(/secret/i);
    }
  });

  it('never puts a secret value anywhere in the built payload', async () => {
    const SECRET_VALUE = 'top-secret-value-xyz';
    const scope = buildScope('org-a', [resolvedVar('s1_token', SECRET_VALUE, true)]);
    await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript({ content: 'curl -H "Authorization: {{var.s1_token}}"' }) },
      variableScope: scope,
    });
    // A secret reference fails the device before any payload is ever built —
    // queueCommand's captured call args ARE what would have reached the
    // agent, so asserting the call never happened, and that whatever WAS
    // captured never contains the plaintext, covers both "no payload built"
    // and "even if one were, it's clean".
    expect(queueCommand).not.toHaveBeenCalled();
    const payload = vi.mocked(queueCommand).mock.calls[0]?.[2] ?? null;
    expect(JSON.stringify(payload)).not.toContain(SECRET_VALUE);
  });

  it('resolves nothing and requires no scope when the content has no {{var.}} token', async () => {
    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript({ content: 'echo hi, no tokens here' }) },
      // deliberately no variableScope — must not throw
    });
    expect(r.ok).toBe(true);
    const [, , payload] = vi.mocked(queueCommand).mock.calls[0]!;
    expect((payload as Record<string, unknown>).content).toBe('echo hi, no tokens here');
  });

  it('throws if the supplied scope was not built for this device org', async () => {
    const scope = buildScope('org-other', [resolvedVar('repo_url', 'x')]);
    await expect(dispatchScriptToDevice({
      device: device({ orgId: 'org-a' }),
      source: { kind: 'saved', script: savedScript({ orgId: 'org-a', content: '{{var.repo_url}}' }) },
      variableScope: scope,
    })).rejects.toThrow(/not in this snapshot/i);
  });

  it('does not substitute into a raw execute_command source ({{var.*}} passes through untouched)', async () => {
    const scope = buildScope('org-a', [resolvedVar('repo_url', 'https://example.com')]);
    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'raw', content: 'curl {{var.repo_url}}', language: 'bash', provenance: 'automation:auto-1' },
      variableScope: scope,
    });
    expect(r.ok).toBe(true);
    const [, , payload] = vi.mocked(queueCommand).mock.calls[0]!;
    expect((payload as Record<string, unknown>).content).toBe('curl {{var.repo_url}}');
  });
});

// #3409 PR3: sourced-parameter resolution at the dispatch chokepoint.
describe('dispatchScriptToDevice — sourced parameters', () => {
  const scriptWithParams = (parameters: unknown[], overrides = {}) =>
    savedScript({ parameters, ...overrides });

  const payloadParameters = () => {
    const [, , payload] = vi.mocked(queueCommand).mock.calls[0]!;
    return (payload as Record<string, unknown>).parameters;
  };

  const executionParameters = () =>
    vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0].parameters;

  it('pre-fills a bound parameter from the device row and drops the caller override', async () => {
    const r = await dispatchScriptToDevice({
      device: device(),
      source: {
        kind: 'saved',
        script: scriptWithParams([
          { name: 'host', type: 'string', source: 'builtin', builtinKey: 'device.hostname' },
          { name: 'level', type: 'string', source: 'runtime' },
        ]),
      },
      parameters: { host: 'caller-tried-this', level: 'debug' },
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ignoredParameters).toEqual(['host']);
    expect(payloadParameters()).toEqual({ host: 'host-1', level: 'debug' });
    expect(JSON.stringify(payloadParameters())).not.toContain('caller-tried-this');
  });

  it('resolves a tenantVariable-bound parameter from the preloaded scope', async () => {
    const scope = buildScope('org-a', [resolvedVar('api_token', 'tok-123')]);
    await dispatchScriptToDevice({
      device: device(),
      source: {
        kind: 'saved',
        script: scriptWithParams([
          { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token' },
        ]),
      },
      variableScope: scope,
    });

    expect(payloadParameters()).toEqual({ token: 'tok-123' });
  });

  it('fails the device with unresolved_parameters — DISTINCT from unresolved_variables', async () => {
    const scope = buildScope('org-a', []);
    const r = await dispatchScriptToDevice({
      device: device(),
      source: {
        kind: 'saved',
        script: scriptWithParams([
          { name: 'token', type: 'string', required: true, source: 'tenantVariable', variableKey: 'api_token' },
        ]),
      },
      variableScope: scope,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('unresolved_parameters');
      expect(r.code).not.toBe('unresolved_variables');
      expect(r.error).toContain('token');
    }
  });

  // Same rule PR2 established for content substitution: resolution runs
  // BEFORE the insert, so a failing device leaves no orphan 'pending' row.
  it('leaves no orphan execution row when a device fails resolution', async () => {
    const scope = buildScope('org-a', []);
    const r = await dispatchScriptToDevice({
      device: device(),
      source: {
        kind: 'saved',
        script: scriptWithParams([
          { name: 'token', type: 'string', required: true, source: 'tenantVariable', variableKey: 'api_token' },
        ]),
      },
      variableScope: scope,
    });

    expect(r.ok).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
    expect(queueCommand).not.toHaveBeenCalled();
  });

  it('fails the device when a bound parameter targets a SECRET tenant variable', async () => {
    const SECRET_VALUE = 'sup3r-s3cret-xyz';
    const scope = buildScope('org-a', [resolvedVar('api_token', SECRET_VALUE, true)]);
    const r = await dispatchScriptToDevice({
      device: device(),
      source: {
        kind: 'saved',
        script: scriptWithParams([
          // A default IS present — the denial must not fall back to it.
          { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token', defaultValue: 'the-default' },
        ]),
      },
      parameters: { token: 'caller-supplied' },
      variableScope: scope,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('unresolved_parameters');
      expect(r.error).toMatch(/secret/i);
    }
    expect(queueCommand).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(queueCommand).mock.calls)).not.toContain(SECRET_VALUE);
  });

  it('requires a variableScope only for a tenantVariable binding, not for the other sources', async () => {
    const r = await dispatchScriptToDevice({
      device: device({ customFields: { asset_tag: 'A-1' } }),
      source: {
        kind: 'saved',
        script: scriptWithParams([
          { name: 'lic', type: 'string', source: 'deviceCustomField', fieldKey: 'asset_tag' },
        ]),
      },
      // deliberately no variableScope — must not throw
    });

    expect(r.ok).toBe(true);
    expect(payloadParameters()).toEqual({ lic: 'A-1' });
  });

  it('throws when a tenantVariable binding is dispatched with no scope (call-site bug)', async () => {
    await expect(dispatchScriptToDevice({
      device: device(),
      source: {
        kind: 'saved',
        script: scriptWithParams([
          { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token' },
        ]),
      },
    })).rejects.toThrow(/variableScope is required/i);
  });

  it('skips resolution entirely for a raw execute_command source', async () => {
    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'raw', content: 'ipconfig', language: 'powershell', provenance: 'automation:auto-1' },
      parameters: { anything: 'kept' },
    });

    expect(r.ok).toBe(true);
    expect(payloadParameters()).toEqual({ anything: 'kept' });
  });

  it('leaves a script with no parameter definitions byte-identical to PR2 behaviour', async () => {
    await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript() },
      parameters: { a: '1' },
    });

    expect(payloadParameters()).toEqual({ a: '1' });
    expect(executionParameters()).toEqual({ a: '1' });
  });

  // Plan §3 P4 — the persistence rule.
  describe('P4: resolved values never enter script_executions.parameters', () => {
    it('stores the CALLER parameters plus an identity-only $bindings descriptor', async () => {
      const scope = buildScope('org-a', [resolvedVar('api_token', 'tok-123')]);
      await dispatchScriptToDevice({
        device: device(),
        source: {
          kind: 'saved',
          script: scriptWithParams([
            { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token' },
            { name: 'level', type: 'string', source: 'runtime' },
          ]),
        },
        parameters: { level: 'debug' },
        variableScope: scope,
      });

      const stored = executionParameters();
      expect(stored).toEqual({
        level: 'debug',
        $bindings: [
          { key: 'token', source: 'tenantVariable', variableId: 'var-api_token', ownerScope: 'organization', version: 1 },
        ],
      });
      // The resolved value exists ONLY in the command payload.
      expect(JSON.stringify(stored)).not.toContain('tok-123');
      expect(payloadParameters()).toMatchObject({ token: 'tok-123' });
    });

    it('does not add a $bindings key when the script has no bound parameters', async () => {
      await dispatchScriptToDevice({
        device: device(),
        source: {
          kind: 'saved',
          script: scriptWithParams([{ name: 'level', type: 'string', source: 'runtime' }]),
        },
        parameters: { level: 'debug' },
      });

      expect(executionParameters()).toEqual({ level: 'debug' });
      expect(executionParameters()).not.toHaveProperty('$bindings');
    });

    it('never persists a builtin- or custom-field-resolved value either', async () => {
      await dispatchScriptToDevice({
        device: device({ customFields: { asset_tag: 'A-1' } }),
        source: {
          kind: 'saved',
          script: scriptWithParams([
            { name: 'host', type: 'string', source: 'builtin', builtinKey: 'device.hostname' },
            { name: 'lic', type: 'string', source: 'deviceCustomField', fieldKey: 'asset_tag' },
          ]),
        },
      });

      const stored = executionParameters();
      expect(stored).toEqual({
        $bindings: [
          { key: 'host', source: 'builtin' },
          { key: 'lic', source: 'deviceCustomField' },
        ],
      });
      expect(JSON.stringify(stored)).not.toContain('host-1');
      expect(JSON.stringify(stored)).not.toContain('A-1');
    });
  });

  describe('builtin name lookups', () => {
    // `loadBuiltinNameContext` is the only db.select this codepath makes
    // (requireOnline is off in these tests), so one chain models both.
    const mockNameSelect = (rows: unknown[]) => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
        }),
      } as any);
    };

    it('looks up org.name / site.name and resolves them', async () => {
      mockNameSelect([{ name: 'Acme Corp' }]);
      await dispatchScriptToDevice({
        device: device(),
        source: {
          kind: 'saved',
          script: scriptWithParams([
            { name: 'org_name', type: 'string', source: 'builtin', builtinKey: 'org.name' },
            { name: 'site_name', type: 'string', source: 'builtin', builtinKey: 'site.name' },
          ]),
        },
      });

      expect(db.select).toHaveBeenCalledTimes(2); // one org query, one site query
      expect(payloadParameters()).toEqual({ org_name: 'Acme Corp', site_name: 'Acme Corp' });
    });

    // The two name queries are the only per-device cost this feature adds;
    // a script that binds no NAME builtin must not pay it.
    it('issues NO lookup for the id/hostname builtins', async () => {
      await dispatchScriptToDevice({
        device: device(),
        source: {
          kind: 'saved',
          script: scriptWithParams([
            { name: 'org_id', type: 'string', source: 'builtin', builtinKey: 'org.id' },
            { name: 'site_id', type: 'string', source: 'builtin', builtinKey: 'site.id' },
            { name: 'host', type: 'string', source: 'builtin', builtinKey: 'device.hostname' },
          ]),
        },
      });

      expect(db.select).not.toHaveBeenCalled();
      expect(payloadParameters()).toEqual({ org_id: 'org-a', site_id: 'site-1', host: 'host-1' });
    });
  });
});
