import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db layer with chainable select/insert/update builders.
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

// Maintenance window check — keep devices executable by default.
vi.mock('./featureConfigResolver', () => ({
  checkDeviceMaintenanceWindow: vi.fn().mockResolvedValue({ active: false, suppressScripts: false }),
}));

// Per-device dispatch core (#3409 PR 0) — the service is now a thin caller
// of this seam, so unit tests stub it rather than the DB inserts / WS send
// it owns internally.
vi.mock('./scriptDispatch', () => ({
  dispatchScriptToDevice: vi.fn().mockResolvedValue({
    ok: true,
    commandId: 'cmd-1',
    executionId: 'exec-1',
    delivered: false,
    executedAt: null,
    // Required on the success arm since #3409 PR3 — the fan-out unions it.
    ignoredParameters: [],
  }),
}));

// #3409 PR2 Task 4: the resolver itself is fully covered (with a real DB
// mock shape) in tenantVariableResolution.test.ts. Here it's stubbed so this
// suite can assert the CALLER's contract — preloaded once per fan-out,
// passed through to every dispatch call — without needing the
// runOutsideDbContext/withSystemDbAccessContext wrappers the real resolver
// requires from '../db' (this file's '../db' mock doesn't provide them).
vi.mock('./tenantVariableResolution', () => ({
  loadTenantVariableScope: vi.fn().mockResolvedValue({ orgIds: new Set() }),
}));

// Real permissions module is fine; canAccessSite is only consulted when
// allowedSiteIds is set, which these tests don't exercise.

import { db } from '../db';
import { checkDeviceMaintenanceWindow } from './featureConfigResolver';
import { dispatchScriptToDevice } from './scriptDispatch';
import { loadTenantVariableScope } from './tenantVariableResolution';
import { executeScriptOnDevices } from './scriptExecution';

// db.select() is used twice per call: first the script (.limit chain), then the
// devices (.where chain, no limit). Return a script-shaped chain first, then a
// devices-shaped chain.
const scriptSelectChain = (rows: unknown[]) => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(rows),
    }),
  }),
});

const devicesSelectChain = (rows: unknown[]) => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(rows),
  }),
});

const insertReturning = (rows: unknown[]) => ({
  values: vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(rows),
  }),
});

const updateChain = () => ({
  set: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  }),
});

const baseScript = (overrides: Record<string, unknown> = {}) => ({
  id: 'script-1',
  orgId: 'org-a',
  isSystem: false,
  osTypes: ['linux'],
  language: 'bash',
  content: 'echo hi',
  timeoutSeconds: 60,
  runAs: 'system',
  deletedAt: null,
  ...overrides,
});

const baseDevice = (overrides: Record<string, unknown> = {}) => ({
  id: 'device-1',
  orgId: 'org-b',
  siteId: null,
  osType: 'linux',
  status: 'online',
  agentId: null,
  ...overrides,
});

// Multi-org partner caller: canAccessOrg passes for both org A and org B.
const multiOrgAuth = {
  user: { id: 'user-1' },
  orgId: null as string | null,
  canAccessOrg: (orgId: string) => orgId === 'org-a' || orgId === 'org-b',
};

describe('executeScriptOnDevices — cross-org isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'inserted-1' }]) as any);
    vi.mocked(db.update).mockReturnValue(updateChain() as any);
  });

  it('excludes a device whose org differs from a non-null script org', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-a' })]) as any)
      .mockReturnValueOnce(devicesSelectChain([baseDevice({ orgId: 'org-b' })]) as any);

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-1'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.admission).toMatchObject({
        status: 'rejected',
        targets: [{ requestedDeviceId: 'device-1', admission: 'denied', reasonCode: 'script_org_mismatch' }],
      });
    }
    // No dispatch for the cross-org device.
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it('executes when the script and device share the same org', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-b' })]) as any)
      .mockReturnValueOnce(devicesSelectChain([baseDevice({ orgId: 'org-b' })]) as any);

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-1'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.admission.targets).toEqual([expect.objectContaining({
        requestedDeviceId: 'device-1', admission: 'admitted',
      })]);
    }
  });

  it('executes a system (org-less) script on any accessible device', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: null, isSystem: true })]) as any)
      .mockReturnValueOnce(devicesSelectChain([baseDevice({ orgId: 'org-b' })]) as any);

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-1'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.admission.targets[0]).toMatchObject({ requestedDeviceId: 'device-1', admission: 'admitted' });
    }
  });

  it('runs only same-org devices in a mixed batch (cross-org excluded)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-a' })]) as any)
      .mockReturnValueOnce(
        devicesSelectChain([
          baseDevice({ id: 'device-a', orgId: 'org-a' }),
          baseDevice({ id: 'device-b', orgId: 'org-b' }),
        ]) as any,
      );

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-a', 'device-b'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.admission.targets).toEqual([
        expect.objectContaining({ requestedDeviceId: 'device-a', admission: 'admitted' }),
        { requestedDeviceId: 'device-b', admission: 'denied', reasonCode: 'script_org_mismatch' },
      ]);
    }
  });

  it('splits batches per org for a multi-org run of an org-null script', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: null, isSystem: true })]) as any)
      .mockReturnValueOnce(devicesSelectChain([
        baseDevice({ id: 'device-1', orgId: 'org-a' }),
        baseDevice({ id: 'device-2', orgId: 'org-a' }),
        baseDevice({ id: 'device-3', orgId: 'org-b' }),
      ]) as any);
    // One insert per org batch — return a distinct id per call so the test
    // can assert each device's dispatch carries its own org's batch id
    // rather than accidentally passing on a shared mock id.
    vi.mocked(db.insert)
      .mockReturnValueOnce(insertReturning([{ id: 'batch-org-a' }]) as any)
      .mockReturnValueOnce(insertReturning([{ id: 'batch-org-b' }]) as any);

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-1', 'device-2', 'device-3'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.admission.targets.map((target) => target.batchId)).toEqual([
        'batch-org-a', 'batch-org-a', 'batch-org-b',
      ]);
    }

    // Two batch inserts: org-a with 2 devices targeted, org-b with 1.
    const insertCalls = vi.mocked(db.insert).mock.results;
    expect(insertCalls).toHaveLength(2);
    const valuesCalls = insertCalls.map((r: any) => r.value.values.mock.calls[0][0]);
    expect(valuesCalls).toEqual([
      expect.objectContaining({ orgId: 'org-a', devicesTargeted: 2 }),
      expect.objectContaining({ orgId: 'org-b', devicesTargeted: 1 }),
    ]);

    // Each device's dispatch carries its own org's batch id.
    const dispatchCalls = vi.mocked(dispatchScriptToDevice).mock.calls;
    const batchIdByDevice = Object.fromEntries(
      dispatchCalls.map((call) => [call[0].device.id, call[0].batchId]),
    );
    expect(batchIdByDevice).toEqual({
      'device-1': 'batch-org-a',
      'device-2': 'batch-org-a',
      'device-3': 'batch-org-b',
    });

    // Final status update covers both created batches.
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});

describe('executeScriptOnDevices — per-device dispatch failures (#3409 PR2 Task 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'inserted-1' }]) as any);
    vi.mocked(db.update).mockReturnValue(updateChain() as any);
  });

  it('records a per-device failure and still dispatches the remaining devices', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-b' })]) as any)
      .mockReturnValueOnce(devicesSelectChain([
        baseDevice({ id: 'device-a', orgId: 'org-b' }),
        baseDevice({ id: 'device-b', orgId: 'org-b' }),
        baseDevice({ id: 'device-c', orgId: 'org-b' }),
      ]) as any);
    vi.mocked(dispatchScriptToDevice)
      .mockResolvedValueOnce({ ok: true, commandId: 'cmd-a', executionId: 'exec-a', delivered: false, deliveryOutcome: 'no_agent', executedAt: null, ignoredParameters: [] })
      .mockResolvedValueOnce({ ok: false, code: 'unresolved_variables', error: 'Could not resolve variable(s): repo_url' })
      .mockResolvedValueOnce({ ok: true, commandId: 'cmd-c', executionId: 'exec-c', delivered: false, deliveryOutcome: 'no_agent', executedAt: null, ignoredParameters: [] });

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-a', 'device-b', 'device-c'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admission.targets).toEqual([
      expect.objectContaining({ requestedDeviceId: 'device-a', admission: 'admitted' }),
      expect.objectContaining({ requestedDeviceId: 'device-b', admission: 'excluded', reasonCode: 'unresolved_variables' }),
      expect.objectContaining({ requestedDeviceId: 'device-c', admission: 'admitted' }),
    ]);
  });

  it('writes a failed script_executions row for the failed device, not nothing', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-b' })]) as any)
      .mockReturnValueOnce(devicesSelectChain([
        baseDevice({ id: 'device-a', orgId: 'org-b' }),
        baseDevice({ id: 'device-b', orgId: 'org-b' }),
      ]) as any);
    vi.mocked(dispatchScriptToDevice)
      .mockResolvedValueOnce({ ok: true, commandId: 'cmd-a', executionId: 'exec-a', delivered: false, deliveryOutcome: 'no_agent', executedAt: null, ignoredParameters: [] })
      .mockResolvedValueOnce({ ok: false, code: 'unresolved_variables', error: 'Could not resolve variable(s): repo_url' });

    await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-a', 'device-b'],
      auth: multiOrgAuth,
    });

    // db.insert always returns the same mocked chain object (mockReturnValue,
    // not mockReturnValueOnce), so both the batch insert and the failed-row
    // insert record their `.values(...)` call on that ONE shared mock fn —
    // index into ITS call history, not `db.insert`'s. Call 0 is the batch
    // insert (from batch creation above the dispatch loop); call 1 is the
    // failed execution row.
    const insertChain = vi.mocked(db.insert).mock.results[0]!.value;
    const failedRowValues = insertChain.values.mock.calls[1][0];
    expect(failedRowValues).toMatchObject({
      scriptId: 'script-1',
      deviceId: 'device-b',
      orgId: 'org-b',
      status: 'failed',
      errorMessage: expect.any(String),
      completedAt: expect.any(Date),
    });
  });

  it('counts a per-device failure toward the batch devicesFailed, not devicesTargeted', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-b' })]) as any)
      .mockReturnValueOnce(devicesSelectChain([
        baseDevice({ id: 'device-a', orgId: 'org-b' }),
        baseDevice({ id: 'device-b', orgId: 'org-b' }),
      ]) as any);
    vi.mocked(dispatchScriptToDevice)
      .mockResolvedValueOnce({ ok: true, commandId: 'cmd-a', executionId: 'exec-a', delivered: false, deliveryOutcome: 'no_agent', executedAt: null, ignoredParameters: [] })
      .mockResolvedValueOnce({ ok: false, code: 'unresolved_variables', error: 'Could not resolve variable(s): repo_url' });

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-a', 'device-b'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admission.targets).toHaveLength(2);
    expect(result.admission.status).toBe('partially_queued');

    // db.update calls: one devicesFailed increment for the failed device's
    // batch, plus the final batch-status update.
    const updateCalls = vi.mocked(db.update).mock.results;
    expect(updateCalls).toHaveLength(2);
    const devicesFailedSetCall = updateCalls[0]!.value.set.mock.calls[0][0];
    expect(devicesFailedSetCall).toHaveProperty('devicesFailed');
  });
});

// #3409 PR4c-2: the claim-time secret gate ALREADY wrote the failed
// script_executions row and ALREADY spent the batch's devicesFailed slot
// before dispatch returned. The fan-out must report the device as failed
// without writing a SECOND row or double-counting the batch.
describe('executeScriptOnDevices — dispatch codes the gate already recorded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'inserted-1' }]) as any);
    vi.mocked(db.update).mockReturnValue(updateChain() as any);
  });

  const twoDeviceSelect = () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-b' })]) as any)
      .mockReturnValueOnce(devicesSelectChain([
        baseDevice({ id: 'device-a', orgId: 'org-b' }),
        baseDevice({ id: 'device-b', orgId: 'org-b' }),
      ]) as any);
  };

  const okDispatch = (suffix: string) => ({
    ok: true as const,
    commandId: `cmd-${suffix}`,
    executionId: `exec-${suffix}`,
    delivered: false,
    deliveryOutcome: 'no_agent' as const,
    executedAt: null,
    ignoredParameters: [],
  });

  it('reports agent_upgrade_required_recorded in failures without a second execution insert or batch increment', async () => {
    twoDeviceSelect();
    vi.mocked(dispatchScriptToDevice)
      .mockResolvedValueOnce(okDispatch('a'))
      .mockResolvedValueOnce({
        ok: false,
        code: 'agent_upgrade_required_recorded',
        error: 'Agent upgrade required: ...; script not executed',
      });

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-a', 'device-b'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admission.targets).toEqual([
      expect.objectContaining({ requestedDeviceId: 'device-a', admission: 'admitted' }),
      expect.objectContaining({ requestedDeviceId: 'device-b', admission: 'excluded', reasonCode: 'agent_upgrade_required_recorded' }),
    ]);

    // db.insert's chain is a single shared mock: call 0 is the batch insert.
    // A second `.values(...)` call would be the duplicate failed-execution row.
    const insertChain = vi.mocked(db.insert).mock.results[0]!.value;
    expect(insertChain.values.mock.calls).toHaveLength(1);
    // The only db.update left is the final batch-status write — no
    // devicesFailed increment (the gate already spent that slot).
    const updateCalls = vi.mocked(db.update).mock.results;
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.value.set.mock.calls[0][0]).not.toHaveProperty('devicesFailed');
  });

  // #3409 PR4c-2 review finding 3 — THE regression this split exists for.
  // 'agent_upgrade_required' is overwhelmingly the ENQUEUE preflight's
  // refusal, which returns BEFORE any script_executions row is written. While
  // it shared a code with the claim-time gate it was suppressed here, so a
  // batch of 10 devices with 3 pre-PR4b agents showed 7 accounted rows and
  // `devicesCompleted + devicesFailed >= devicesTargeted` never held — the
  // batch could never finalize.
  it('DOES write the row and increment the batch for the ENQUEUE agent_upgrade_required refusal', async () => {
    twoDeviceSelect();
    vi.mocked(dispatchScriptToDevice)
      .mockResolvedValueOnce(okDispatch('a'))
      .mockResolvedValueOnce({
        ok: false,
        code: 'agent_upgrade_required',
        error: 'Agent upgrade required: ...; script not executed',
      });

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-a', 'device-b'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admission.targets[1]).toMatchObject({
      requestedDeviceId: 'device-b', admission: 'excluded', reasonCode: 'agent_upgrade_required',
    });

    const insertChain = vi.mocked(db.insert).mock.results[0]!.value;
    expect(insertChain.values.mock.calls).toHaveLength(2);
    expect(insertChain.values.mock.calls[1][0]).toMatchObject({
      deviceId: 'device-b',
      orgId: 'org-b',
      status: 'failed',
    });
    const updateCalls = vi.mocked(db.update).mock.results;
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]!.value.set.mock.calls[0][0]).toHaveProperty('devicesFailed');
  });

  // The claim gate's infrastructure-fault path writes NOTHING (it cannot know
  // whether the gate's terminal write landed), so its refusal must also take
  // the ordinary per-device failure row.
  it('DOES write the row and increment the batch for secret_gate_unavailable', async () => {
    twoDeviceSelect();
    vi.mocked(dispatchScriptToDevice)
      .mockResolvedValueOnce(okDispatch('a'))
      .mockResolvedValueOnce({
        ok: false,
        code: 'secret_gate_unavailable',
        error: 'The server could not verify ...; script not executed',
      });

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-a', 'device-b'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const insertChain = vi.mocked(db.insert).mock.results[0]!.value;
    expect(insertChain.values.mock.calls).toHaveLength(2);
    const updateCalls = vi.mocked(db.update).mock.results;
    expect(updateCalls[0]!.value.set.mock.calls[0][0]).toHaveProperty('devicesFailed');
  });

  it('still writes the row and increments the batch for a code the gate did NOT record', async () => {
    twoDeviceSelect();
    vi.mocked(dispatchScriptToDevice)
      .mockResolvedValueOnce(okDispatch('a'))
      .mockResolvedValueOnce({
        ok: false,
        code: 'secret_delivery_unavailable',
        error: 'Secret delivery is not configured on this server',
      });

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-a', 'device-b'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admission.targets[1]).toMatchObject({
      requestedDeviceId: 'device-b', admission: 'excluded', reasonCode: 'secret_delivery_unavailable',
    });

    const insertChain = vi.mocked(db.insert).mock.results[0]!.value;
    expect(insertChain.values.mock.calls).toHaveLength(2);
    expect(insertChain.values.mock.calls[1][0]).toMatchObject({
      deviceId: 'device-b',
      orgId: 'org-b',
      status: 'failed',
    });
    const updateCalls = vi.mocked(db.update).mock.results;
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]!.value.set.mock.calls[0][0]).toHaveProperty('devicesFailed');
  });
});

describe('executeScriptOnDevices — ignored bound parameters (#3409 PR3 §2.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'inserted-1' }]) as any);
    vi.mocked(db.update).mockReturnValue(updateChain() as any);
  });

  it('unions the per-device ignored keys and de-duplicates them', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-b' })]) as any)
      .mockReturnValueOnce(devicesSelectChain([
        baseDevice({ id: 'device-a', orgId: 'org-b' }),
        baseDevice({ id: 'device-b', orgId: 'org-b' }),
      ]) as any);
    // Definitions belong to the SCRIPT, so in practice every device reports
    // the same set — the caller must still see each key exactly once, and a
    // key only one device reported must not be dropped.
    vi.mocked(dispatchScriptToDevice)
      .mockResolvedValueOnce({ ok: true, commandId: 'cmd-a', executionId: 'exec-a', delivered: false, deliveryOutcome: 'no_agent', executedAt: null, ignoredParameters: ['api_key', 'site_code'] })
      .mockResolvedValueOnce({ ok: true, commandId: 'cmd-b', executionId: 'exec-b', delivered: false, deliveryOutcome: 'no_agent', executedAt: null, ignoredParameters: ['api_key'] });

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-a', 'device-b'],
      parameters: { api_key: 'caller-supplied', site_code: 'caller-supplied' },
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ignoredParameters).toEqual(['api_key', 'site_code']);
  });

  it('is an empty array when no bound key was supplied', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-b' })]) as any)
      .mockReturnValueOnce(devicesSelectChain([baseDevice({ id: 'device-a', orgId: 'org-b' })]) as any);
    vi.mocked(dispatchScriptToDevice)
      .mockResolvedValueOnce({ ok: true, commandId: 'cmd-a', executionId: 'exec-a', delivered: false, deliveryOutcome: 'no_agent', executedAt: null, ignoredParameters: [] });

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-a'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The SERVICE always reports the field; it is the ROUTE that omits it from
    // the wire when empty (see scripts.test.ts / mobile.test.ts).
    expect(result.ignoredParameters).toEqual([]);
  });

  it('still reports keys from the devices that dispatched when another device failed', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-b' })]) as any)
      .mockReturnValueOnce(devicesSelectChain([
        baseDevice({ id: 'device-a', orgId: 'org-b' }),
        baseDevice({ id: 'device-b', orgId: 'org-b' }),
      ]) as any);
    vi.mocked(dispatchScriptToDevice)
      // The failure arm of DispatchScriptResult carries no ignored keys, so a
      // failed device contributes nothing — the surviving device is what keeps
      // the warning alive for the run.
      .mockResolvedValueOnce({ ok: false, code: 'unresolved_parameters', error: 'Unresolved script parameter(s): no value for required parameter(s) "region"' })
      .mockResolvedValueOnce({ ok: true, commandId: 'cmd-b', executionId: 'exec-b', delivered: false, deliveryOutcome: 'no_agent', executedAt: null, ignoredParameters: ['api_key'] });

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-a', 'device-b'],
      parameters: { api_key: 'caller-supplied' },
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ignoredParameters).toEqual(['api_key']);
    expect(result.admission.targets[0]).toMatchObject({ admission: 'excluded', reasonCode: 'unresolved_parameters' });
  });
});

describe('executeScriptOnDevices — tenant variable scope preload (#3409 PR2 Task 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'inserted-1' }]) as any);
    vi.mocked(db.update).mockReturnValue(updateChain() as any);
    vi.mocked(loadTenantVariableScope).mockResolvedValue({ orgIds: new Set() } as any);
  });

  it('preloads the scope ONCE for the whole fan-out, not once per device', async () => {
    vi.mocked(db.select)
      // Content MUST carry a token — the preload is gated on it, so a
      // token-free fixture would make this assertion vacuous.
      .mockReturnValueOnce(scriptSelectChain([
        baseScript({ orgId: null, isSystem: true, content: 'curl {{var.repo_url}}' }),
      ]) as any)
      .mockReturnValueOnce(devicesSelectChain([
        baseDevice({ id: 'device-1', orgId: 'org-a' }),
        baseDevice({ id: 'device-2', orgId: 'org-a' }),
        baseDevice({ id: 'device-3', orgId: 'org-b' }),
      ]) as any);

    await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-1', 'device-2', 'device-3'],
      auth: multiOrgAuth,
    });

    expect(loadTenantVariableScope).toHaveBeenCalledTimes(1);
    // De-duplicated org set, order-insensitive.
    const [orgIds] = vi.mocked(loadTenantVariableScope).mock.calls[0]!;
    expect(new Set(orgIds)).toEqual(new Set(['org-a', 'org-b']));
  });

  // Without this gate every script run — the overwhelming majority of which
  // reference no variable — would escape the request transaction and take a
  // second connection to build a snapshot nothing consults.
  it('does not load a variable scope for a script with no {{var.*}} token', async () => {
    vi.mocked(loadTenantVariableScope).mockResolvedValue({ orgIds: new Set() } as any);

    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-a', content: 'echo hi' })]) as any)
      .mockReturnValueOnce(devicesSelectChain([baseDevice({ id: 'device-1', orgId: 'org-a' })]) as any);

    await executeScriptOnDevices({ scriptId: 'script-1', deviceIds: ['device-1'], auth: multiOrgAuth });

    // Called with an EMPTY org list, which loadTenantVariableScope
    // short-circuits without querying — no escape from the request
    // transaction, no second connection.
    const [orgIds] = vi.mocked(loadTenantVariableScope).mock.calls[0]!;
    expect(orgIds).toEqual([]);
  });

  // #3409 PR3 P1 — the gap that makes the extended gate load-bearing. The
  // content here is deliberately TOKEN-FREE: with the old
  // `hasVariableTokens(script.content)` gate this run passes `[]`, dispatch
  // then resolves the binding against an EMPTY scope, and the device fails
  // with "no value set" for a variable that exists.
  //
  // MUTATION-VERIFIED: forcing `scriptNeedsVariableScope` to `false` fails
  // this test and the sibling `aiToolsScripts` / `automationRuntime` gate
  // tests, and nothing else.
  it('loads a scope for a token-free script whose PARAMETERS bind a tenant variable', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([
        baseScript({
          orgId: 'org-a',
          content: 'echo hi',
          parameters: [{ name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token' }],
        }),
      ]) as any)
      .mockReturnValueOnce(devicesSelectChain([baseDevice({ id: 'device-1', orgId: 'org-a' })]) as any);

    await executeScriptOnDevices({ scriptId: 'script-1', deviceIds: ['device-1'], auth: multiOrgAuth });

    const [orgIds] = vi.mocked(loadTenantVariableScope).mock.calls[0]!;
    expect(orgIds).toEqual(['org-a']);
  });

  it('does NOT load a scope for a token-free script whose parameters are all runtime', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([
        baseScript({
          orgId: 'org-a',
          content: 'echo hi',
          parameters: [{ name: 'level', type: 'string', source: 'runtime' }],
        }),
      ]) as any)
      .mockReturnValueOnce(devicesSelectChain([baseDevice({ id: 'device-1', orgId: 'org-a' })]) as any);

    await executeScriptOnDevices({ scriptId: 'script-1', deviceIds: ['device-1'], auth: multiOrgAuth });

    const [orgIds] = vi.mocked(loadTenantVariableScope).mock.calls[0]!;
    expect(orgIds).toEqual([]);
  });

  it('passes the preloaded scope through to every device dispatch call', async () => {
    const scope = { orgIds: new Set(['org-b']) };
    vi.mocked(loadTenantVariableScope).mockResolvedValue(scope as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-b' })]) as any)
      .mockReturnValueOnce(devicesSelectChain([
        baseDevice({ id: 'device-a', orgId: 'org-b' }),
        baseDevice({ id: 'device-b', orgId: 'org-b' }),
      ]) as any);

    await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-a', 'device-b'],
      auth: multiOrgAuth,
    });

    const dispatchCalls = vi.mocked(dispatchScriptToDevice).mock.calls;
    expect(dispatchCalls).toHaveLength(2);
    for (const call of dispatchCalls) {
      expect(call[0].variableScope).toBe(scope);
    }
  });
});

// Full MaintenanceWindowStatus shape (featureConfigResolver.ts) — the mocked
// resolver must satisfy every field, not just the two this suite cares about.
const maintenanceStatus = (overrides: { active: boolean; suppressScripts: boolean }) => ({
  active: overrides.active,
  suppressScripts: overrides.suppressScripts,
  suppressAlerts: false,
  suppressPatching: false,
  suppressAutomations: false,
  rebootIfPending: false,
  windowEndsAt: null,
});

describe('executeScriptOnDevices — maintenance window suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'inserted-1' }]) as any);
    vi.mocked(db.update).mockReturnValue(updateChain() as any);
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue(maintenanceStatus({ active: false, suppressScripts: false }));
  });

  it('returns a typed rejection when every target device is in a script-suppressing maintenance window', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-b' })]) as any)
      .mockReturnValueOnce(devicesSelectChain([baseDevice({ id: 'device-1', orgId: 'org-b' })]) as any);
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue(maintenanceStatus({ active: true, suppressScripts: true }));

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-1'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.admission).toMatchObject({
      status: 'rejected',
      targets: [{ requestedDeviceId: 'device-1', admission: 'suppressed', reasonCode: 'maintenance_suppressed' }],
    });
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it('excludes only the suppressed device from an otherwise-executable batch', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-b' })]) as any)
      .mockReturnValueOnce(devicesSelectChain([
        baseDevice({ id: 'device-1', orgId: 'org-b' }),
        baseDevice({ id: 'device-2', orgId: 'org-b' }),
      ]) as any);
    vi.mocked(checkDeviceMaintenanceWindow).mockImplementation(async (deviceId: string) =>
      deviceId === 'device-1'
        ? maintenanceStatus({ active: true, suppressScripts: true })
        : maintenanceStatus({ active: false, suppressScripts: false }),
    );

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-1', 'device-2'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.admission.status).toBe('partially_queued');
      expect(result.admission.targets).toEqual([
        { requestedDeviceId: 'device-1', admission: 'suppressed', reasonCode: 'maintenance_suppressed' },
        expect.objectContaining({ requestedDeviceId: 'device-2', admission: 'admitted' }),
      ]);
    }
  });
});
