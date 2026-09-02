import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SQL, Param } from 'drizzle-orm';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./commandQueue', () => ({ queueCommand: vi.fn() }));
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn().mockResolvedValue(null),
  releaseClaimedCommandDelivery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./sensitiveCommandPayload', () => ({
  encryptSensitivePayloadFields: vi.fn((_t: string, p: unknown) => p),
  decryptCommandForDelivery: vi.fn((c: unknown) => c),
  toAgentCommandFrame: vi.fn((c: { id: string; type: string; payload: unknown }) => ({
    id: c.id,
    type: c.type,
    payload: c.payload,
  })),
}));
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: vi.fn().mockReturnValue(false) }));
// #3409 PR4c-2: the secret-delivery gates are unit-tested against their own
// drizzle mocks in scriptSecretDelivery.test.ts. Here they are mocked so this
// file tests the WIRING — that dispatch calls them at the right two points,
// only for a secret-bearing script, and honours their verdicts.
vi.mock('./scriptSecretDelivery', () => ({
  // The real constant's text is asserted in scriptSecretDelivery.test.ts; the
  // dispatch refusal only has to carry it through verbatim, so a stand-in
  // string is enough here and keeps this file free of the real module.
  AGENT_UPGRADE_REQUIRED_MESSAGE: 'Agent upgrade required: mocked message',
  SECRET_GATE_UNAVAILABLE_MESSAGE: 'Secret gate unavailable: mocked message',
  secretDeliveryPreflight: vi.fn().mockResolvedValue({ ok: true }),
  failClaimedSecretCommandsForUnsupportedAgent: vi.fn((claimed: unknown[]) => Promise.resolve(claimed)),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { db } from '../db';
import { queueCommand } from './commandQueue';
import { claimPendingCommandForDelivery } from './commandDispatch';
import { decryptCommandForDelivery, encryptSensitivePayloadFields } from './sensitiveCommandPayload';
import { sendCommandToAgent } from '../routes/agentWs';
import { captureException } from './sentry';
import {
  AGENT_UPGRADE_REQUIRED_MESSAGE,
  SECRET_GATE_UNAVAILABLE_MESSAGE,
  failClaimedSecretCommandsForUnsupportedAgent,
  secretDeliveryPreflight,
} from './scriptSecretDelivery';
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
const resolvedVar = (
  key: string,
  value: string,
  isSecret = false,
  ownerScope: 'organization' | 'partner' = 'organization',
): ResolvedVariable => ({
  key, value, isSecret, variableId: `var-${key}`, version: 1, ownerScope,
});

// `unreadableKeys` mirrors the snapshot's third field — keys whose row EXISTS
// but failed to decrypt. `unreadableForOrg` is used UNMOCKED here (like
// `resolveForOrg`), so this map must be present on every scope or that
// accessor has nothing to read.
const buildScope = (
  orgId: string,
  vars: ResolvedVariable[] = [],
  unreadableKeys: string[] = [],
): TenantVariableScope => ({
  orgIds: new Set([orgId]),
  byOrg: new Map([[orgId, new Map(vars.map((v) => [v.key, v]))]]),
  unreadableKeysByOrg: new Map([[orgId, new Set(unreadableKeys)]]),
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

// Mocks the users-row existence probe (#3826 Wave 4A Task 3): a single
// `db.select({id}).from(users).where(eq(users.id, candidate)).limit(1)`
// query. Pass `found: true` to model a real users row (real-user path,
// unchanged behavior) or `found: false` to model an agent-shaped id that
// does not resolve to any users row (degrade path).
const mockUsersProbe = (found: boolean) => {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(found ? [{ id: 'probed' }] : []),
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
  // Permissive defaults re-established per test so a `…Once` override or a
  // per-test verdict never leaks into the next test.
  vi.mocked(secretDeliveryPreflight).mockResolvedValue({ ok: true });
  vi.mocked(failClaimedSecretCommandsForUnsupportedAgent).mockImplementation(
    (claimed: any) => Promise.resolve(claimed),
  );
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
    mockUsersProbe(true); // 'user-1' resolves to a real users row — real-user path.
    const r = await dispatchScriptToDevice({
      device: device(), source: { kind: 'saved', script: savedScript(), automationRunId: null },
      parameters: { a: '1' }, triggeredBy: 'user-1', triggerType: 'manual',
    });
    expect(r.ok).toBe(true);
    const execValues = vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0];
    expect(execValues).toMatchObject({ scriptId: 'script-1', deviceId: 'device-1', orgId: 'org-a', triggeredBy: 'user-1', status: 'pending' });
    // Real-user path must stay byte-identical: no $actor sidecar.
    expect(execValues.parameters).not.toHaveProperty('$actor');
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
    expect(encryptSensitivePayloadFields).toHaveBeenCalledWith(
      'script',
      expect.any(Object),
      // #3409 PR4a: the secret envelope's AAD binds the command id, so the id
      // is reserved BEFORE encryption and reused for the insert.
      { commandId: expect.any(String), deviceId: device().id },
    );
    expect(vi.mocked(encryptSensitivePayloadFields).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(queueCommand).mock.invocationCallOrder[0]!);
  });

  it('reserves ONE command id and uses it for both the AAD and the insert', async () => {
    // A mismatch here would make every sealed envelope un-openable at delivery.
    await dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } });
    const encryptCtx = vi.mocked(encryptSensitivePayloadFields).mock.calls[0]![2] as
      | { commandId: string; deviceId: string }
      | undefined;
    const queueOptions = vi.mocked(queueCommand).mock.calls[0]![4] as
      | { commandId?: string }
      | undefined;
    expect(encryptCtx?.commandId).toBeTruthy();
    expect(queueOptions?.commandId).toBe(encryptCtx?.commandId);
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

// #3826 Wave 4A Task 3: agent principals reach dispatchScriptToDevice through
// the same handlers humans use (auth.user.id is an ai_agents id, not a
// users.id, for an ai_agent principal — see agentAuthContext.ts). Both
// `script_executions.triggered_by` and (via queueCommand) `device_commands
// .created_by` FK-reference users.id, so an agent-shaped id must degrade to
// NULL before either insert — mirrors the shipped commandQueue.ts:855-889
// precedent exactly.
describe('dispatchScriptToDevice — users-FK probe-and-degrade (#3826)', () => {
  it('degrades an agent-shaped triggeredBy/createdBy to null on BOTH columns and stashes actor metadata', async () => {
    mockUsersProbe(false); // agent id does not resolve to a users row
    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript() },
      triggeredBy: 'agent-shaped-id-1',
      createdBy: 'agent-shaped-id-1',
    });
    expect(r.ok).toBe(true);
    const execValues = vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0];
    expect(execValues.triggeredBy).toBeNull();
    expect(execValues.parameters).toMatchObject({
      $actor: { actorType: 'ai_agent', actorId: 'agent-shaped-id-1' },
    });
    const [, , , userId] = vi.mocked(queueCommand).mock.calls[0]!;
    expect(userId).toBeUndefined();
  });

  it('single probe covers BOTH columns: exactly one users select when triggeredBy === createdBy', async () => {
    mockUsersProbe(true);
    await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript() },
      triggeredBy: 'user-1',
      createdBy: 'user-1',
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('real-user path stays byte-identical: createdBy passes through to queueCommand verbatim', async () => {
    mockUsersProbe(true);
    await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript() },
      triggeredBy: 'user-1',
      createdBy: 'user-1',
    });
    const [, , , userId] = vi.mocked(queueCommand).mock.calls[0]!;
    expect(userId).toBe('user-1');
  });

  it('does not probe at all when neither triggeredBy nor createdBy is supplied (no behavior change)', async () => {
    await dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('raw source: degrades an agent-shaped createdBy for queueCommand (no execution row to stash metadata in)', async () => {
    mockUsersProbe(false);
    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'raw', content: 'ipconfig', language: 'powershell', provenance: 'automation:auto-1' },
      createdBy: 'agent-shaped-id-2',
    });
    expect(r.ok).toBe(true);
    expect(db.insert).not.toHaveBeenCalled();
    const [, , , userId] = vi.mocked(queueCommand).mock.calls[0]!;
    expect(userId).toBeUndefined();
  });

  // #4299: the load-bearing half of the probe. `users` is an RLS-forced
  // dual-axis table and `withSystemDbAccessContext` short-circuits to the
  // caller's store when one is already open (`withDbAccessContext` returns
  // early on an existing store), so a probe that does not FIRST escape the
  // request context runs org-scoped. A partner-level human (`users.org_id IS
  // NULL`) matches no branch of the users SELECT policy from an org-scoped,
  // user-less context, so the probe reads zero rows and degrades a REAL human
  // to NULL on both `triggered_by` and `created_by` — silently, since this
  // path is FK-safe. Nesting order is the observable proof this suite can
  // make: `db` is mocked here, so no RLS policy is actually evaluated. The
  // real-Postgres proof of the identical escape (a partner-level human kept
  // through an org-scoped, user-less caller context) is the load-bearing test
  // in __tests__/integration/commandQueueCreatedBy.integration.test.ts, which
  // covers the sibling probe in commandQueue.ts. This assertion fails against
  // the pre-#4299 code — verified, not assumed.
  it('runs the actor probe OUTSIDE the caller DB context, in a system context', async () => {
    const dbModule = await import('../db');
    const order: string[] = [];
    vi.mocked(dbModule.runOutsideDbContext).mockImplementationOnce(async (fn: () => unknown) => {
      order.push('enter-outside');
      const result = await fn();
      order.push('exit-outside');
      return result;
    });
    vi.mocked(dbModule.withSystemDbAccessContext).mockImplementationOnce(async (fn: () => unknown) => {
      order.push('enter-system');
      const result = await fn();
      order.push('exit-system');
      return result;
    });
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            order.push('users-probe');
            return Promise.resolve([{ id: 'probed' }]);
          }),
        }),
      }),
    } as any);

    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript() },
      triggeredBy: 'user-1',
      createdBy: 'user-1',
    });

    expect(r.ok).toBe(true);
    // Nesting matters: outside must open before system, and the read must land
    // between them. `withSystemDbAccessContext` alone (no escape) yields
    // ['enter-system', 'users-probe', 'exit-system'] and is the regression.
    expect(order).toEqual([
      'enter-outside',
      'enter-system',
      'users-probe',
      'exit-system',
      'exit-outside',
    ]);
    // And the real user still survives the guard on BOTH columns.
    const execValues = vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0];
    expect(execValues.triggeredBy).toBe('user-1');
    const [, , , userId] = vi.mocked(queueCommand).mock.calls[0]!;
    expect(userId).toBe('user-1');
  });

  it('does not add an $actor key when the script has no bound parameters and the actor IS real', async () => {
    mockUsersProbe(true);
    await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript() },
      triggeredBy: 'user-1',
      createdBy: 'user-1',
    });
    const execValues = vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0];
    expect(execValues.parameters).not.toHaveProperty('$actor');
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

  // #3409 PR4c-2 review finding 2 — the "unreadable vs unset" distinction was
  // implemented in the resolver but the ONLY production caller never passed
  // the set, so it could not fire anywhere outside the resolver's own unit
  // tests. This asserts dispatch actually forwards `unreadableForOrg(...)`.
  it('reports an UNREADABLE bound variable as unreadable, not as "no value"', async () => {
    const scope = buildScope('org-a', [], ['api_token']);
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
      // The remediation is "go look at the encryption keys", NOT "create the
      // variable" — the two wordings send a tech to opposite places.
      expect(r.error).toContain('could not be read');
      expect(r.error).not.toContain('no value for required parameter');
      expect(r.error).toContain('api_token');
    }
  });

  it('reports a genuinely ABSENT variable as "no value", never as unreadable', async () => {
    const scope = buildScope('org-a', [], ['some_other_key']);
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
      expect(r.error).toContain('no value for required parameter');
      expect(r.error).not.toContain('could not be read');
    }
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

// #3409 PR4c-2: `tenantSecret` parameters — the sealed out-of-band channel
// plus the two activation gates (enqueue preflight, claim-time re-check).
// The gates themselves are covered against their own DB mocks in
// scriptSecretDelivery.test.ts; these tests pin the WIRING.
describe('dispatchScriptToDevice — tenantSecret parameters', () => {
  const SECRET_VALUE = 'sup3r-s3cret-value-xyz';

  const secretScript = (extra: unknown[] = [], overrides = {}) =>
    savedScript({
      parameters: [
        { name: 'api_token', source: 'tenantSecret', variableKey: 'vendor_token' },
        ...extra,
      ],
      ...overrides,
    });

  const secretScope = () => buildScope('org-a', [resolvedVar('vendor_token', SECRET_VALUE, true)]);

  // Stands in for the real seal (the module is mocked file-wide): consumes
  // `secretEnv` and leaves the ciphertext string the agent frame carries.
  const mockSealOnce = () => {
    vi.mocked(encryptSensitivePayloadFields).mockImplementationOnce((_t: string, payload: any) => {
      const out = { ...payload };
      if (out.secretEnv !== undefined) {
        delete out.secretEnv;
        out.secretEnvEnvelope = 'enc:v3:sealed-envelope';
      }
      return out;
    });
  };

  const dispatchSecret = (input: Record<string, unknown> = {}) =>
    dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: secretScript() },
      variableScope: secretScope(),
      ...input,
    } as any);

  it('hands the resolved secret to the seal in secretEnv, never in parameters', async () => {
    mockSealOnce();
    const r = await dispatchSecret({
      source: {
        kind: 'saved',
        script: secretScript([{ name: 'level', type: 'string', source: 'runtime' }]),
      },
      parameters: { level: 'debug' },
    });

    expect(r.ok).toBe(true);
    const sealInput = vi.mocked(encryptSensitivePayloadFields).mock.calls[0]![1] as Record<string, unknown>;
    expect(sealInput.secretEnv).toEqual({ api_token: SECRET_VALUE });
    expect(sealInput.parameters).toEqual({ level: 'debug' });
    expect(JSON.stringify(sealInput.parameters)).not.toContain(SECRET_VALUE);
  });

  it('queues the SEALED payload: secretEnvEnvelope string, no secretEnv', async () => {
    mockSealOnce();
    await dispatchSecret();

    const [, , payload] = vi.mocked(queueCommand).mock.calls[0]!;
    const queued = payload as Record<string, unknown>;
    expect(typeof queued.secretEnvEnvelope).toBe('string');
    expect(queued).not.toHaveProperty('secretEnv');
    expect(JSON.stringify(queued)).not.toContain(SECRET_VALUE);
  });

  it('stores an identity-only $bindings row and no value in script_executions', async () => {
    mockSealOnce();
    await dispatchSecret();

    const execValues = vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0];
    expect(execValues.parameters).toEqual({
      $bindings: [
        {
          key: 'api_token',
          source: 'tenantSecret',
          variableId: 'var-vendor_token',
          ownerScope: 'organization',
          version: 1,
        },
      ],
    });
    // The whole serialized insert — not just the parameters column.
    expect(JSON.stringify(execValues)).not.toContain(SECRET_VALUE);
  });

  // #3409 PR4c-2 review BLOCKER — dispatch is where the script's ownership
  // tier is KNOWN, so it is where the "never resolve a secret above your own
  // tier" rule is actually enforced. These assert the derivation
  // (`scripts.org_id IS NULL` -> 'partner') reaches the resolver.
  describe('secret ownership tier', () => {
    const partnerSecretScope = () =>
      buildScope('org-a', [resolvedVar('vendor_token', SECRET_VALUE, true, 'partner')]);

    it('refuses an ORG-owned script bound to a PARTNER-WIDE secret, sealing nothing', async () => {
      const r = await dispatchScriptToDevice({
        device: device(),
        source: { kind: 'saved', script: secretScript(undefined, { orgId: 'org-a' }) },
        variableScope: partnerSecretScope(),
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('unresolved_parameters');
        expect(r.error).toContain('partner-wide secret variable');
      }
      // Refused BEFORE anything is written or sealed — no orphan rows, and
      // the credential never reaches the seal.
      expect(db.insert).not.toHaveBeenCalled();
      expect(queueCommand).not.toHaveBeenCalled();
      expect(encryptSensitivePayloadFields).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(encryptSensitivePayloadFields).mock.calls)).not.toContain(SECRET_VALUE);
    });

    it('ALLOWS a partner-wide script (orgId null) bound to a partner-wide secret', async () => {
      mockSealOnce();
      const r = await dispatchScriptToDevice({
        device: device(),
        source: { kind: 'saved', script: secretScript(undefined, { orgId: null }) },
        variableScope: partnerSecretScope(),
      });

      expect(r.ok).toBe(true);
      const sealInput = vi.mocked(encryptSensitivePayloadFields).mock.calls[0]![1] as Record<string, unknown>;
      expect(sealInput.secretEnv).toEqual({ api_token: SECRET_VALUE });
    });

    // The primary use case, not an escalation: one partner-wide script, each
    // target org's own value resolved per device.
    it('ALLOWS a partner-wide script bound to an ORG-owned secret (per-org value)', async () => {
      mockSealOnce();
      const r = await dispatchScriptToDevice({
        device: device(),
        source: { kind: 'saved', script: secretScript(undefined, { orgId: null }) },
        variableScope: secretScope(),
      });

      expect(r.ok).toBe(true);
      const sealInput = vi.mocked(encryptSensitivePayloadFields).mock.calls[0]![1] as Record<string, unknown>;
      expect(sealInput.secretEnv).toEqual({ api_token: SECRET_VALUE });
    });

    it('ALLOWS an org-owned script bound to its own org-owned secret', async () => {
      mockSealOnce();
      const r = await dispatchSecret();
      expect(r.ok).toBe(true);
    });
  });

  it('runs the enqueue preflight with the effective runAs and target session', async () => {
    mockSealOnce();
    await dispatchSecret({ runAs: 'elevated', targetSessionId: undefined });

    expect(secretDeliveryPreflight).toHaveBeenCalledWith({
      deviceId: 'device-1',
      runAs: 'elevated',
      targetSessionId: undefined,
    });
    // BEFORE the execution insert — a refused device must leave no orphan row.
    expect(vi.mocked(secretDeliveryPreflight).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(db.insert).mock.invocationCallOrder[0]!);
  });

  // The three preflight refusals, propagated verbatim with no orphan rows.
  for (const code of [
    'secrets_unsupported_run_as',
    'secret_delivery_unavailable',
    'agent_upgrade_required',
  ] as const) {
    it(`fails the device with ${code} and leaves no execution or command behind`, async () => {
      vi.mocked(secretDeliveryPreflight).mockResolvedValue({ ok: false, code, error: `refused: ${code}` });
      const r = await dispatchSecret({ runAs: 'user' });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe(code);
        expect(r.error).toBe(`refused: ${code}`);
      }
      expect(db.insert).not.toHaveBeenCalled();
      expect(queueCommand).not.toHaveBeenCalled();
      expect(encryptSensitivePayloadFields).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(queueCommand).mock.calls)).not.toContain(SECRET_VALUE);
    });
  }

  // Hot-path regression guard (the preload trap from PR2): the gate must cost
  // nothing for the overwhelming majority of scripts, which have no secret.
  it('never calls the preflight for a script with no tenantSecret parameter', async () => {
    await dispatchScriptToDevice({
      device: device(),
      source: {
        kind: 'saved',
        script: savedScript({ parameters: [{ name: 'level', type: 'string', source: 'runtime' }] }),
      },
      parameters: { level: 'debug' },
    });

    expect(secretDeliveryPreflight).not.toHaveBeenCalled();
    expect(failClaimedSecretCommandsForUnsupportedAgent).not.toHaveBeenCalled();
  });

  it('never calls the claim gate on the immediate-send path for a secret-free script', async () => {
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({ executedAt: new Date() } as any);
    vi.mocked(sendCommandToAgent).mockReturnValue(true);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);

    const r = await dispatchScriptToDevice({
      device: device({ agentId: 'agent-1' }),
      source: { kind: 'saved', script: savedScript() },
    });

    expect(failClaimedSecretCommandsForUnsupportedAgent).not.toHaveBeenCalled();
    if (r.ok) expect(r.deliveryOutcome).toBe('sent');
  });

  it('immediate send: re-checks the claimed command through the claim gate, then sends', async () => {
    mockSealOnce();
    const executedAt = new Date('2026-08-22T00:00:00Z');
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({ executedAt } as any);
    vi.mocked(sendCommandToAgent).mockReturnValue(true);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);

    const r = await dispatchSecret({ device: device({ agentId: 'agent-1' }) });

    expect(failClaimedSecretCommandsForUnsupportedAgent).toHaveBeenCalledWith([
      {
        id: 'cmd-1',
        type: 'script',
        deviceId: 'device-1',
        payload: expect.objectContaining({ secretEnvEnvelope: 'enc:v3:sealed-envelope' }),
        executedAt,
      },
    ]);
    // Gate first, send second — never the other way round.
    expect(vi.mocked(failClaimedSecretCommandsForUnsupportedAgent).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(sendCommandToAgent).mock.invocationCallOrder[0]!);
    expect(sendCommandToAgent).toHaveBeenCalled();
    if (r.ok) {
      expect(r.delivered).toBe(true);
      expect(r.deliveryOutcome).toBe('sent');
    }
  });

  // The blocker the review caught: the immediate-send path claims the command
  // itself and never reaches decryptClaimedCommandsForDelivery, so without
  // this gate a downgraded agent would receive the script with the credential
  // unset.
  //
  // The gate outcome is TERMINAL, and every caller of dispatchScriptToDevice
  // branches on `ok` alone — so reporting it as `ok: true` told the operator
  // "queued on N devices" for a credentialed run that had already been failed.
  // It is a refusal (`ok: false`), and 'agent_unsupported' no longer exists as
  // a deliveryOutcome.
  //
  // #3409 PR4c-2 review finding 3: the code is DISTINCT from the enqueue
  // preflight's 'agent_upgrade_required'. Both mean "upgrade the agent" to the
  // operator (same message), but only THIS one arrives with its
  // script_executions row and batch slot already written by the gate — and
  // `DISPATCH_CODES_ALREADY_RECORDED` keys on the code, so sharing one value
  // silently suppressed the far more common enqueue refusal's failure row.
  it('immediate send: refuses with agent_upgrade_required_recorded when the claim gate fails the command', async () => {
    mockSealOnce();
    const executedAt = new Date('2026-08-22T00:00:00Z');
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({ executedAt } as any);
    vi.mocked(sendCommandToAgent).mockReturnValue(true);
    vi.mocked(failClaimedSecretCommandsForUnsupportedAgent).mockResolvedValue([]);
    const { releaseClaimedCommandDelivery } = await import('./commandDispatch');

    const r = await dispatchSecret({ device: device({ agentId: 'agent-1' }) });

    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(decryptCommandForDelivery).not.toHaveBeenCalled();
    // Terminal, not retryable: the gate already failed both rows, so the
    // command must NOT go back to pending for the same agent to re-claim.
    expect(releaseClaimedCommandDelivery).not.toHaveBeenCalled();
    // ...and the execution row is NOT flipped to 'running' here.
    expect(db.update).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('agent_upgrade_required_recorded');
      // Same operator-facing text as the enqueue refusal — only the code,
      // which decides row ownership, differs.
      expect(r.error).toBe(AGENT_UPGRADE_REQUIRED_MESSAGE);
    }
  });

  // The gate's own try/catch covers only its writes: the capability SELECT
  // (and its multi-device contract-violation throw) can propagate out AFTER
  // `claimPendingCommandForDelivery` already flipped the row to 'sent'. Left
  // bare, that 500s the caller and aborts a large fan-out mid-run.
  it('immediate send: a gate throw becomes the same refusal, reported to Sentry, nothing sent', async () => {
    mockSealOnce();
    const executedAt = new Date('2026-08-22T00:00:00Z');
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({ executedAt } as any);
    vi.mocked(sendCommandToAgent).mockReturnValue(true);
    const boom = new Error('capability select exploded');
    vi.mocked(failClaimedSecretCommandsForUnsupportedAgent).mockRejectedValue(boom);
    const { releaseClaimedCommandDelivery } = await import('./commandDispatch');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await dispatchSecret({ device: device({ agentId: 'agent-1' }) });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      // An INFRASTRUCTURE fault, not a capability claim: telling the operator
      // to upgrade a perfectly current agent would send them to fix the wrong
      // thing, and nothing was written on this path, so the refusal must also
      // stay OUT of DISPATCH_CODES_ALREADY_RECORDED (asserted in
      // scriptExecution.test.ts) or the device's failure row is dropped.
      expect(r.code).toBe('secret_gate_unavailable');
      expect(r.code).not.toBe('agent_upgrade_required_recorded');
      expect(r.error).toBe(SECRET_GATE_UNAVAILABLE_MESSAGE);
      expect(r.error).not.toBe(AGENT_UPGRADE_REQUIRED_MESSAGE);
    }
    // Fail CLOSED: an unknown gate verdict must never decrypt or send.
    expect(decryptCommandForDelivery).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(releaseClaimedCommandDelivery).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(boom);
    // Log line carries ids only — never the sealed payload or the plaintext.
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sealed-envelope');
    warn.mockRestore();
  });
});
