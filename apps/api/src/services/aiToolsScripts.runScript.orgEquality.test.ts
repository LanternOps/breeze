import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Sibling to the scriptExecution.ts / mobile.ts cross-org-script fix (#1674):
 * the AI `run_script` tool resolves a script by `orgCondition` and each device
 * by org+site `verifyDeviceAccess`, but neither check ties the script's org to
 * the device's org. For a multi-org caller, `orgCondition` is
 * `inArray(orgId, accessibleOrgIds)`, so an org-A script resolves AND an org-B
 * device passes verifyDeviceAccess — org A's script content would land on an
 * org-B device. This asserts the per-device org-equality invariant: a non-null
 * script org must match the device org, while a system (null-org) script stays
 * universally runnable.
 *
 * PR0 (#3409 Task 4): run_script now dispatches through the shared
 * scriptDispatch core (dispatchScriptToDevice + waitForCommandResult) instead
 * of the bare executeCommand call, gaining a script_executions row and
 * partner-wide script visibility. These tests mock dispatchScriptToDevice /
 * waitForCommandResult directly — the dispatch core's own execution-row and
 * queueCommand behavior is covered by Task 1's tests, not re-asserted here.
 *
 * C1 fix (#3409 PR0 final review): dispatch + poll must escape the ambient
 * held transaction (runOutsideDbContext + withSystemDbAccessContext), or the
 * device_commands INSERT stays invisible to the agent-WS handler on another
 * connection until the whole 60s poll finishes. `runOutsideDbContext` /
 * `withSystemDbAccessContext` are mocked below as flag-tracking passthroughs
 * (not bare identity) specifically so a later describe block can assert
 * dispatchScriptToDevice actually runs NESTED inside them, not merely that
 * they were called somewhere.
 */

const mocks = vi.hoisted(() => {
  const contextFlags = { runOutside: false, system: false };
  // Untyped `vi.fn()` + a separate `.mockImplementation` call (rather than
  // `vi.fn(async () => (...))`) so TS doesn't lock the mock's return type to
  // this one success shape — the dispatch-failure test below needs to
  // `.mockResolvedValueOnce` a differently-shaped `{ ok: false, code, error }`.
  const dispatchScriptToDevice = vi.fn();
  dispatchScriptToDevice.mockImplementation(async () => ({
    ok: true,
    commandId: 'cmd-1',
    executionId: 'exec-1',
    delivered: true,
    executedAt: new Date('2026-08-11T00:00:00Z'),
    // Snapshot the escape state at the moment dispatch actually runs, so
    // the C1 test can assert nesting (not just that the mocks were called).
    __calledUnder: { ...contextFlags },
  }));
  return {
    contextFlags,
    dispatchScriptToDevice,
    // Modeled on a real device_commands row: carries `payload` (full script
    // content + parameters) alongside `result`. B1 (#3409 PR0 Wave B): the
    // handler must project only `result` (+ commandId/executionId) and never
    // let `payload` — which is what leaked script content into the model
    // context and persisted chat history — reach the tool's returned JSON.
    waitForCommandResult: vi.fn().mockResolvedValue({
      id: 'cmd-1',
      status: 'completed',
      payload: { scriptId: 'script-x', content: 'SECRET SCRIPT CONTENT', parameters: { foo: 'bar' } },
      result: { status: 'completed', exitCode: 0, stdout: 'hi' },
    }),
  };
});
const { dispatchScriptToDevice, waitForCommandResult, contextFlags } = mocks;

vi.mock('./scriptDispatch', () => ({ dispatchScriptToDevice: mocks.dispatchScriptToDevice }));
vi.mock('./commandQueue', () => ({ waitForCommandResult: mocks.waitForCommandResult }));
// #3409 PR2 Task 4: the real loadTenantVariableScope issues a
// .select().from().innerJoin().where() chain this file's db.select mock
// (below, `mockDb`) doesn't shape — and its own coverage lives in
// tenantVariableResolution.test.ts. Stub it so the per-device preload this
// task adds doesn't require reshaping every mockDb() call site here.
vi.mock('./tenantVariableResolution', () => ({
  loadTenantVariableScope: vi.fn().mockResolvedValue({ orgIds: new Set() }),
}));

vi.mock('../db', () => ({
  // Real `runOutsideDbContext` is `dbContextStorage.exit(fn)` — an
  // AsyncLocalStorage exit, which stays in effect for `fn`'s ENTIRE async
  // continuation (every await inside it), not just until its first
  // microtask boundary. A plain synchronous try/finally around a
  // promise-returning `fn()` would restore the flag the instant `fn()`
  // returns a pending promise, well before an internal `await` (e.g. the
  // #3409 PR2 Task 4 variable-scope preload ahead of dispatch) actually
  // resolves — under-representing how long the real escape stays active.
  // Awaiting a promise result before restoring the flag models that
  // correctly.
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    mocks.contextFlags.runOutside = true;
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(() => { mocks.contextFlags.runOutside = false; });
    }
    mocks.contextFlags.runOutside = false;
    return result;
  }),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    mocks.contextFlags.system = true;
    try {
      return await fn();
    } finally {
      mocks.contextFlags.system = false;
    }
  }),
  db: { select: vi.fn() },
}));

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, organizations, scripts } from '../db/schema';
import { registerScriptTools } from './aiToolsScripts';
import { loadTenantVariableScope } from './tenantVariableResolution';
import type { AiTool } from './aiTools';
import type { ToolExecutionContext } from './toolExecutionContext';
import type { AuthContext } from '../middleware/auth';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SCRIPT_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_B = '22222222-2222-2222-2222-222222222222';
const PARTNER_1 = 'partner-1';
const PARTNER_2 = 'partner-2';

function runScriptTool(): AiTool {
  const map = new Map<string, AiTool>();
  registerScriptTools(map);
  return map.get('run_script')!;
}

// A multi-org caller (org A and org B both accessible). orgCondition is a no-op
// in the mock so the script select returns whatever the mock yields; the access
// breadth is modeled by what the mocked queries return, matching production
// where inArray(orgId, accessibleOrgIds) would resolve both.
function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'u@example.com', name: 'U' },
    token: {} as any,
    partnerId: null,
    orgId: ORG_A,
    scope: 'organization',
    accessibleOrgIds: [ORG_A, ORG_B],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    canAccessSite: () => true,
  } as any;
}

/**
 * The handler issues up to three kinds of select(), distinguished by the
 * table passed to .from(): scripts (full-row), devices (verifyDeviceAccess),
 * and organizations (the partner guard, only reached for partner-wide
 * scripts). `orgRow` is only consulted when the handler actually queries
 * organizations.
 */
/**
 * Every table `.from()` was called with, in order. Lets a test assert that the
 * handler did NOT re-read `scripts` (rather than only that it produced the
 * right answer, which a re-read would also do when the row happens to agree).
 */
const selectedTables: unknown[] = [];

function mockDb(scriptRow: any, deviceRow: any, orgRow?: any) {
  selectedTables.length = 0;
  vi.mocked(db.select).mockImplementation((() => {
    return {
      from: vi.fn((table: unknown) => {
        selectedTables.push(table);
        let rows: any[];
        if (table === scripts) rows = [scriptRow].filter(Boolean);
        else if (table === devices) rows = [deviceRow].filter(Boolean);
        else if (table === organizations) rows = orgRow !== undefined ? [orgRow].filter(Boolean) : [];
        else rows = [];
        return {
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
        };
      }),
    } as any;
  }) as any);
}

beforeEach(() => vi.clearAllMocks());

describe('run_script enforces script-device org equality', () => {
  it('does NOT execute an org-A script on an org-B device (cross-org rejected)', async () => {
    mockDb(
      { id: SCRIPT_ID, orgId: ORG_A, partnerId: null, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
    );

    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth()),
    );

    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(out.results[DEVICE_B].error).toMatch(/not found or access denied/i);
  });

  it('executes a same-org script on a same-org device', async () => {
    const scriptRow = { id: SCRIPT_ID, orgId: ORG_B, partnerId: null, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' };
    const deviceRow = { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' };
    mockDb(scriptRow, deviceRow);

    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth()),
    );

    expect(dispatchScriptToDevice).toHaveBeenCalledTimes(1);
    expect(dispatchScriptToDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        device: expect.objectContaining({ id: DEVICE_B }),
        source: { kind: 'saved', script: scriptRow },
        triggerType: 'manual',
        triggeredBy: 'user-1',
        createdBy: 'user-1',
        requireOnline: true,
      }),
    );

    // Result comes from waitForCommandResult, not the dispatch return value.
    expect(waitForCommandResult).toHaveBeenCalledWith('cmd-1', 60000);
    // B1 (#3409 PR0 Wave B): the handler projects the polled command's
    // `.result` (+ commandId/executionId) rather than returning the row
    // whole — `payload` (script content + parameters) must never reach the
    // model context or persisted chat history.
    expect(out.results[DEVICE_B]).toEqual({
      status: 'completed',
      exitCode: 0,
      stdout: 'hi',
      commandId: 'cmd-1',
      executionId: 'exec-1',
    });
    expect(out.results[DEVICE_B]).not.toHaveProperty('payload');
    expect(out.results[DEVICE_B]).not.toHaveProperty('content');
    expect(JSON.stringify(out)).not.toContain('SECRET SCRIPT CONTENT');
  });

  it('executes a system (null-org) script on any accessible device', async () => {
    mockDb(
      { id: SCRIPT_ID, orgId: null, partnerId: null, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
    );

    await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth());

    expect(dispatchScriptToDevice).toHaveBeenCalledTimes(1);
  });
});

describe('run_script partner-wide script visibility (#3409 PR0)', () => {
  it('runs a partner-wide script (org_id NULL) on a device whose org belongs to the matching partner', async () => {
    mockDb(
      { id: SCRIPT_ID, orgId: null, partnerId: PARTNER_1, language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
      { partnerId: PARTNER_1 },
    );

    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth()),
    );

    expect(dispatchScriptToDevice).toHaveBeenCalledTimes(1);
    expect(out.results[DEVICE_B]).toEqual({
      status: 'completed',
      exitCode: 0,
      stdout: 'hi',
      commandId: 'cmd-1',
      executionId: 'exec-1',
    });
  });

  it('rejects a partner-wide script when the device org belongs to a different partner', async () => {
    mockDb(
      { id: SCRIPT_ID, orgId: null, partnerId: PARTNER_1, language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
      { partnerId: PARTNER_2 },
    );

    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth()),
    );

    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(out.results[DEVICE_B].error).toMatch(/not found or access denied/i);
  });

  it('rejects a partner-wide script when the device org cannot be resolved', async () => {
    mockDb(
      { id: SCRIPT_ID, orgId: null, partnerId: PARTNER_1, language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
      undefined,
    );

    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth()),
    );

    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(out.results[DEVICE_B].error).toMatch(/not found or access denied/i);
  });
});

describe('run_script escapes the ambient transaction for dispatch + poll (#3409 C1)', () => {
  it('runs dispatchScriptToDevice nested inside runOutsideDbContext(withSystemDbAccessContext(...)), and polls after dispatch resolves', async () => {
    const scriptRow = { id: SCRIPT_ID, orgId: ORG_B, partnerId: null, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' };
    const deviceRow = { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' };
    mockDb(scriptRow, deviceRow);

    await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth());

    expect(dispatchScriptToDevice).toHaveBeenCalledTimes(1);
    // dispatchScriptToDevice's mock snapshots the escape flags the instant it
    // runs — this proves it executed NESTED inside both wrappers, not merely
    // that the wrappers were called somewhere in the handler.
    const dispatchReturn = await dispatchScriptToDevice.mock.results[0]!.value;
    expect(dispatchReturn.__calledUnder).toEqual({ runOutside: true, system: true });

    // withSystemDbAccessContext wraps ONLY dispatch (never the poll) — nesting
    // the poll inside it would hold a live transaction across the 60s wait
    // and reproduce the exact 0-row bug this fix removes, just under a
    // system-scoped transaction instead of the ambient one.
    expect(vi.mocked(withSystemDbAccessContext)).toHaveBeenCalledTimes(1);
    // runOutsideDbContext escapes twice: once wrapping dispatch, once
    // wrapping the poll.
    expect(vi.mocked(runOutsideDbContext).mock.calls.length).toBeGreaterThanOrEqual(2);

    // The poll must start only after dispatch has fully resolved (i.e. after
    // its transaction committed), never before.
    const dispatchOrder = dispatchScriptToDevice.mock.invocationCallOrder[0]!;
    const waitOrder = waitForCommandResult.mock.invocationCallOrder[0]!;
    expect(waitOrder).toBeGreaterThan(dispatchOrder);
  });

  it('preloads the variable scope inside the same escape, and forwards it to dispatch (#3409 PR2 Task 4)', async () => {
    const scope = { orgIds: new Set([ORG_B]) };
    vi.mocked(loadTenantVariableScope).mockResolvedValueOnce(scope as any);
    // Content MUST carry a {{var.*}} token — the preload is gated on it, so a
    // token-free fixture would assert nothing.
    const scriptRow = { id: SCRIPT_ID, orgId: ORG_B, partnerId: null, language: 'powershell', content: 'echo {{var.repo_url}}', timeoutSeconds: 60, runAs: 'system' };
    const deviceRow = { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' };
    mockDb(scriptRow, deviceRow);

    await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth());

    expect(loadTenantVariableScope).toHaveBeenCalledWith([ORG_B]);
    expect(dispatchScriptToDevice).toHaveBeenCalledWith(
      expect.objectContaining({ variableScope: scope }),
    );
    // The preload must run BEFORE dispatch, nested in the same escape — not
    // a second independent context.
    const preloadOrder = vi.mocked(loadTenantVariableScope).mock.invocationCallOrder[0]!;
    const dispatchOrder = dispatchScriptToDevice.mock.invocationCallOrder[0]!;
    expect(preloadOrder).toBeLessThan(dispatchOrder);
  });
});

describe('run_script surfaces dispatch failures without calling waitForCommandResult', () => {
  it('returns the dispatch error and does not poll when dispatch fails', async () => {
    mockDb(
      { id: SCRIPT_ID, orgId: ORG_B, partnerId: null, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
    );
    dispatchScriptToDevice.mockResolvedValueOnce({ ok: false, code: 'device_offline', error: 'Device is offline, cannot execute command' });

    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth()),
    );

    expect(out.results[DEVICE_B].error).toBe('Device is offline, cannot execute command');
    expect(waitForCommandResult).not.toHaveBeenCalled();
  });
});

describe('run_script keeps per-device failures isolated in the shared results accumulator', () => {
  it('does not let one device throwing during dispatch corrupt another device\'s successful result', async () => {
    const DEVICE_C = '33333333-3333-3333-3333-333333333333';
    mockDb(
      { id: SCRIPT_ID, orgId: ORG_B, partnerId: null, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      // The mocked devices select ignores the WHERE clause and always
      // returns this one row, but the tool keys `results` by the actual
      // deviceId from the input array, which is what this test asserts on.
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
    );

    // First device's dispatch throws (e.g. a genuine DB/infra fault);
    // second device's dispatch uses the default (successful) mock.
    dispatchScriptToDevice.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B, DEVICE_C] }, makeAuth()),
    );

    expect(out.results[DEVICE_B].error).toBe('boom');
    expect(out.results[DEVICE_C]).toEqual({
      status: 'completed',
      exitCode: 0,
      stdout: 'hi',
      commandId: 'cmd-1',
      executionId: 'exec-1',
    });
  });
});

// #3409 PR3 P1 — the scope-preload gate must look past the content.
//
// Every fixture here is TOKEN-FREE on purpose: under the old
// `hasVariableTokens(script.content)` gate the AI run_script path passes `[]`
// to loadTenantVariableScope, dispatch then resolves the binding against an
// EMPTY scope, and the device fails with "no value set" for a variable that
// exists. Asserting the loaded org list — not merely that the loader was
// called — is what makes these non-vacuous.
//
// MUTATION-VERIFIED: forcing `scriptNeedsVariableScope` to return `false`
// fails the first test below (plus the scriptExecution / automationRuntime
// siblings) and nothing else.
describe('run_script variable-scope preload gate (#3409 PR3 P1)', () => {
  const scriptRow = (parameters: unknown) => ({
    id: SCRIPT_ID,
    orgId: ORG_B,
    partnerId: null,
    language: 'powershell',
    content: 'echo hi', // no {{var.*}} token
    parameters,
    timeoutSeconds: 60,
    runAs: 'system',
  });
  const deviceRow = { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' };

  it('loads the org scope for a token-free script whose PARAMETERS bind a tenant variable', async () => {
    mockDb(scriptRow([{ name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token' }]), deviceRow);

    await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth());

    expect(loadTenantVariableScope).toHaveBeenCalledWith([ORG_B]);
  });

  it('passes the empty org list when the script needs no scope at all', async () => {
    mockDb(scriptRow([{ name: 'level', type: 'string', source: 'runtime' }]), deviceRow);

    await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth());

    expect(loadTenantVariableScope).toHaveBeenCalledWith([]);
  });

  it('still loads for a content token, with no parameter definitions at all', async () => {
    mockDb({ ...scriptRow(null), content: 'curl {{var.repo_url}}' }, deviceRow);

    await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth());

    expect(loadTenantVariableScope).toHaveBeenCalledWith([ORG_B]);
  });
});

// #3409 PR4c-1 — the verified release snapshot.
//
// A release path (jobs/intentReleaseWorker.ts, or the inline chat path in
// aiAgentSdk.ts) has already read the script row and resolved the tenant
// variables in order to recompute the pinned effect digest. Reading them AGAIN
// here reopens the exact check/use window the digest exists to close, so the
// verified material is handed in as `ToolExecutionContext.verifiedRunScript`.
//
// EVERY test below feeds an EMPTY `scripts` table (`mockDb(null, ...)`). That
// is deliberate and is what makes them non-vacuous: a handler that re-queries
// answers "Script not found or has no content" and dispatches nothing, so no
// assertion here can be satisfied by accident.
describe('run_script consumes a verified release snapshot instead of re-querying (#3409 PR4c-1)', () => {
  const OTHER_SCRIPT_ID = '44444444-4444-4444-4444-444444444444';
  const deviceRow = { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' };
  const pinnedScope = { orgIds: new Set([ORG_B]) } as any;

  const pinnedRow = (overrides: Record<string, unknown> = {}) => ({
    id: SCRIPT_ID,
    orgId: ORG_B,
    partnerId: null,
    language: 'powershell',
    content: 'echo pinned',
    timeoutSeconds: 60,
    runAs: 'system',
    parameters: null,
    ...overrides,
  });

  /**
   * The carrier the release paths build. `snapshot` (digest material),
   * `scriptRow` (what dispatch consumes) and `scope` (plaintext-bearing) are
   * SIBLINGS — the scope must never be reachable from the digest material.
   * Cast because the fixtures are deliberately partial rows.
   */
  function contextFor(scriptRow: any, scope: any = pinnedScope): ToolExecutionContext {
    return {
      verifiedRunScript: {
        snapshot: {
          script: {
            id: scriptRow.id,
            orgId: scriptRow.orgId,
            language: scriptRow.language,
            content: scriptRow.content,
            timeoutSeconds: scriptRow.timeoutSeconds,
            runAs: scriptRow.runAs,
          },
          parameterDefinitions: '[]',
          deviceOrgIds: [ORG_B],
          variableReferences: [],
        },
        scriptRow,
        scope,
      },
    } as unknown as ToolExecutionContext;
  }

  it('dispatches the pinned row and never re-reads the scripts table', async () => {
    const pinned = pinnedRow();
    mockDb(null, deviceRow);

    const out = JSON.parse(
      await runScriptTool().handler(
        { scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] },
        makeAuth(),
        contextFor(pinned),
      ),
    );

    expect(selectedTables).not.toContain(scripts);
    expect(dispatchScriptToDevice).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'saved', script: pinned } }),
    );
    expect(out.results[DEVICE_B].status).toBe('completed');
  });

  it('reuses the pinned variable scope instead of re-resolving it, still nested inside the C1 escape', async () => {
    // The content carries a {{var.*}} token, so the no-context path WOULD call
    // loadTenantVariableScope — without the token this would assert nothing.
    const pinned = pinnedRow({ content: 'curl {{var.repo_url}}' });
    mockDb(null, deviceRow);

    await runScriptTool().handler(
      { scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] },
      makeAuth(),
      contextFor(pinned),
    );

    expect(loadTenantVariableScope).not.toHaveBeenCalled();
    expect(dispatchScriptToDevice).toHaveBeenCalledWith(
      expect.objectContaining({ variableScope: pinnedScope }),
    );
    // Skipping the preload must not have unpicked the escape nesting dispatch
    // itself depends on (#3409 C1).
    const dispatchReturn = await dispatchScriptToDevice.mock.results[0]!.value;
    expect(dispatchReturn.__calledUnder).toEqual({ runOutside: true, system: true });
  });

  it('still rejects a pinned org-A script on an org-B device — the snapshot removes a READ, not a CHECK', async () => {
    mockDb(null, deviceRow);

    const out = JSON.parse(
      await runScriptTool().handler(
        { scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] },
        makeAuth(),
        contextFor(pinnedRow({ orgId: ORG_A })),
      ),
    );

    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(out.results[DEVICE_B].error).toMatch(/not found or access denied/i);
  });

  it('still enforces the partner guard for a pinned partner-wide script', async () => {
    mockDb(null, deviceRow, { partnerId: PARTNER_2 });

    const out = JSON.parse(
      await runScriptTool().handler(
        { scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] },
        makeAuth(),
        contextFor(pinnedRow({ orgId: null, partnerId: PARTNER_1 })),
      ),
    );

    // The device-org -> partner lookup must actually have run.
    expect(selectedTables).toContain(organizations);
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(out.results[DEVICE_B].error).toMatch(/not found or access denied/i);
  });

  it('refuses a pinned script whose org the caller cannot access', async () => {
    // The skipped query carried `or(isNull(orgId), auth.orgCondition(orgId))`.
    // That filter is AUTHORIZATION and has to survive as an in-code check —
    // the release path resolves the row under a SYSTEM context with no org
    // filter at all, so dropping it would let a caller run a script from an
    // org they cannot reach.
    const auth = makeAuth();
    auth.canAccessOrg = () => false;
    mockDb(null, deviceRow);

    const out = JSON.parse(
      await runScriptTool().handler(
        { scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] },
        auth,
        contextFor(pinnedRow({ orgId: ORG_A })),
      ),
    );

    expect(out.error).toMatch(/not found/i);
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
    // And it must NOT quietly fall back to the query to try again.
    expect(selectedTables).not.toContain(scripts);
  });

  it('ignores a context pinned to a DIFFERENT script and falls back to the query', async () => {
    const queried = pinnedRow({ content: 'echo queried' });
    mockDb(queried, deviceRow);

    await runScriptTool().handler(
      { scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] },
      makeAuth(),
      contextFor(pinnedRow({ id: OTHER_SCRIPT_ID })),
    );

    expect(selectedTables).toContain(scripts);
    expect(dispatchScriptToDevice).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'saved', script: queried } }),
    );
  });

  it('with NO context, reads the script row and resolves the scope exactly as before', async () => {
    const queried = pinnedRow({ content: 'curl {{var.repo_url}}' });
    mockDb(queried, deviceRow);

    await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth());

    expect(selectedTables).toContain(scripts);
    expect(loadTenantVariableScope).toHaveBeenCalledWith([ORG_B]);
  });
});
