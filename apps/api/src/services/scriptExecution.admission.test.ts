import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('./featureConfigResolver', () => ({
  checkDeviceMaintenanceWindow: vi.fn().mockResolvedValue({
    active: false,
    suppressScripts: false,
    suppressAlerts: false,
    suppressPatching: false,
    suppressAutomations: false,
    rebootIfPending: false,
    windowEndsAt: null,
  }),
}));

vi.mock('./scriptDispatch', () => ({
  dispatchScriptToDevice: vi.fn(),
}));

vi.mock('./tenantVariableResolution', () => ({
  loadTenantVariableScope: vi.fn().mockResolvedValue({ orgIds: new Set() }),
}));

import { db } from '../db';
import { checkDeviceMaintenanceWindow } from './featureConfigResolver';
import { dispatchScriptToDevice } from './scriptDispatch';
import { executeScriptOnDevices } from './scriptExecution';

const scriptSelect = (rows: unknown[]) => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
  }),
});

const deviceSelect = (rows: unknown[]) => ({
  from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
});

const insertReturning = (rows: unknown[]) => ({
  values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
});

const updateChain = () => ({
  set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
});

const script = (overrides: Record<string, unknown> = {}) => ({
  id: 'script-1',
  orgId: null,
  partnerId: 'partner-a',
  isSystem: true,
  name: 'Admission test',
  osTypes: ['linux'],
  language: 'bash',
  content: 'echo hi',
  parameters: [],
  timeoutSeconds: 60,
  runAs: 'system',
  deletedAt: null,
  ...overrides,
});

const device = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  orgId: 'org-a',
  siteId: 'site-a',
  osType: 'linux',
  status: 'online',
  agentId: null,
  ...overrides,
});

const auth = {
  user: { id: 'user-1' },
  orgId: null as string | null,
  canAccessOrg: (orgId: string) => orgId === 'org-a' || orgId === 'org-b',
};

const permissions = {
  permissions: [],
  partnerId: 'partner-a',
  orgId: null,
  roleId: 'role-1',
  scope: 'partner' as const,
  orgAccess: 'all' as const,
  allowedSiteIds: ['site-a'],
};

const dispatched = (id: string) => ({
  ok: true as const,
  commandId: `command-${id}`,
  executionId: `execution-${id}`,
  delivered: false,
  deliveryOutcome: 'no_agent' as const,
  executedAt: null,
  ignoredParameters: [],
  runAs: 'system' as const,
  targetSessionId: null,
});

describe('executeScriptOnDevices admission contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'batch-default' }]) as never);
    vi.mocked(db.update).mockReturnValue(updateChain() as never);
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
      active: false,
      suppressScripts: false,
      suppressAlerts: false,
      suppressPatching: false,
      suppressAutomations: false,
      rebootIfPending: false,
      windowEndsAt: null,
    });
    vi.mocked(dispatchScriptToDevice).mockImplementation(async ({ device: target }) => dispatched(target.id));
  });

  it('returns one ordered target per first-occurrence ID and dispatches each admitted target once', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelect([script()]) as never)
      .mockReturnValueOnce(deviceSelect([device('C'), device('A'), device('B')]) as never);

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['A', 'B', 'A', 'C', 'B'],
      auth,
      permissions,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admission).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      status: 'queued',
      targets: [
        { requestedDeviceId: 'A', admission: 'admitted', executionId: 'execution-A', commandId: 'command-A', batchId: 'batch-default' },
        { requestedDeviceId: 'B', admission: 'admitted', executionId: 'execution-B', commandId: 'command-B', batchId: 'batch-default' },
        { requestedDeviceId: 'C', admission: 'admitted', executionId: 'execution-C', commandId: 'command-C', batchId: 'batch-default' },
      ],
    });
    expect(vi.mocked(dispatchScriptToDevice).mock.calls.map(([call]) => call.device.id)).toEqual(['A', 'B', 'C']);
  });

  it('keeps every distinct requested ID and applies oracle-safe gates without side effects', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelect([script({ orgId: 'org-a', isSystem: false })]) as never)
      .mockReturnValueOnce(deviceSelect([
        device('foreign', { orgId: 'org-foreign', siteId: 'site-foreign' }),
        device('site-denied', { siteId: 'site-b' }),
        device('script-org', { orgId: 'org-b' }),
        device('os', { osType: 'windows' }),
        device('decommissioned', { status: 'decommissioned' }),
        device('maintenance'),
        device('ok'),
      ]) as never);
    vi.mocked(checkDeviceMaintenanceWindow).mockImplementation(async (id: string) => ({
      active: id === 'maintenance',
      suppressScripts: id === 'maintenance',
      suppressAlerts: false,
      suppressPatching: false,
      suppressAutomations: false,
      rebootIfPending: false,
      windowEndsAt: null,
    }));

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['missing', 'foreign', 'site-denied', 'script-org', 'os', 'decommissioned', 'maintenance', 'ok'],
      auth,
      permissions,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admission.status).toBe('partially_queued');
    expect(result.admission.targets).toEqual([
      { requestedDeviceId: 'missing', admission: 'denied', reasonCode: 'not_found_or_inaccessible' },
      { requestedDeviceId: 'foreign', admission: 'denied', reasonCode: 'not_found_or_inaccessible' },
      { requestedDeviceId: 'site-denied', admission: 'denied', reasonCode: 'site_access_denied' },
      { requestedDeviceId: 'script-org', admission: 'denied', reasonCode: 'script_org_mismatch' },
      { requestedDeviceId: 'os', admission: 'excluded', reasonCode: 'os_incompatible' },
      { requestedDeviceId: 'decommissioned', admission: 'excluded', reasonCode: 'device_decommissioned' },
      { requestedDeviceId: 'maintenance', admission: 'suppressed', reasonCode: 'maintenance_suppressed' },
      { requestedDeviceId: 'ok', admission: 'admitted', executionId: 'execution-ok', commandId: 'command-ok' },
    ]);
    expect(vi.mocked(dispatchScriptToDevice).mock.calls.map(([call]) => call.device.id)).toEqual(['ok']);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('returns a valid typed rejection rather than an HTTP failure when no target is admitted', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelect([script()]) as never)
      .mockReturnValueOnce(deviceSelect([]) as never);

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['missing-a', 'missing-b'],
      auth,
      permissions,
    });

    expect(result).toMatchObject({
      ok: true,
      admission: {
        status: 'rejected',
        targets: [
          { requestedDeviceId: 'missing-a', admission: 'denied', reasonCode: 'not_found_or_inaccessible' },
          { requestedDeviceId: 'missing-b', admission: 'denied', reasonCode: 'not_found_or_inaccessible' },
        ],
      },
    });
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('maps dispatch refusals without truncating later targets or duplicating rows already owned by dispatch', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelect([script()]) as never)
      .mockReturnValueOnce(deviceSelect([device('recorded'), device('race'), device('ok')]) as never);
    vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'batch-1' }]) as never);
    vi.mocked(dispatchScriptToDevice)
      .mockResolvedValueOnce({ ok: false, code: 'agent_upgrade_required_recorded', error: 'upgrade' })
      .mockResolvedValueOnce({ ok: false, code: 'os_mismatch', error: 'changed' })
      .mockResolvedValueOnce(dispatched('ok'));

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['recorded', 'race', 'ok'],
      auth,
      permissions,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admission.targets).toEqual([
      { requestedDeviceId: 'recorded', admission: 'excluded', reasonCode: 'agent_upgrade_required_recorded', batchId: 'batch-1' },
      { requestedDeviceId: 'race', admission: 'excluded', reasonCode: 'os_incompatible', batchId: 'batch-1' },
      { requestedDeviceId: 'ok', admission: 'admitted', executionId: 'execution-ok', commandId: 'command-ok', batchId: 'batch-1' },
    ]);
    const insertChain = vi.mocked(db.insert).mock.results[0]!.value as ReturnType<typeof insertReturning>;
    expect(insertChain.values).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['device_offline', 'device_offline'],
    ['org_mismatch', 'script_org_mismatch'],
    ['os_mismatch', 'os_incompatible'],
    ['device_decommissioned', 'device_decommissioned'],
    ['unresolved_variables', 'unresolved_variables'],
    ['unresolved_parameters', 'unresolved_parameters'],
    ['secrets_unsupported_run_as', 'secrets_unsupported_run_as'],
    ['secret_delivery_unavailable', 'secret_delivery_unavailable'],
    ['agent_upgrade_required', 'agent_upgrade_required'],
    ['agent_upgrade_required_recorded', 'agent_upgrade_required_recorded'],
    ['secret_gate_unavailable', 'secret_gate_unavailable'],
  ] as const)('publishes dispatch refusal %s as stable reason %s', async (dispatchCode, reasonCode) => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelect([script()]) as never)
      .mockReturnValueOnce(deviceSelect([device('target')]) as never);
    vi.mocked(dispatchScriptToDevice).mockResolvedValueOnce({
      ok: false,
      code: dispatchCode,
      error: 'refused',
    });

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['target'],
      auth,
      permissions,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admission).toMatchObject({
      status: 'rejected',
      targets: [{ requestedDeviceId: 'target', admission: 'excluded', reasonCode }],
    });
  });

  it('keeps insert_failed as an internal all-or-nothing failure', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelect([script()]) as never)
      .mockReturnValueOnce(deviceSelect([device('target')]) as never);
    vi.mocked(dispatchScriptToDevice).mockResolvedValueOnce({
      ok: false,
      code: 'insert_failed',
      error: 'database unavailable',
    });

    await expect(executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['target'],
      auth,
      permissions,
    })).rejects.toThrow('database unavailable');
  });

  it('assigns each admitted target its own organization batch and generates a fresh request ID', async () => {
    const setup = () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(scriptSelect([script()]) as never)
        .mockReturnValueOnce(deviceSelect([
          device('org-a-1', { orgId: 'org-a' }),
          device('org-b-1', { orgId: 'org-b', siteId: 'site-a' }),
        ]) as never);
      vi.mocked(db.insert)
        .mockReturnValueOnce(insertReturning([{ id: 'batch-a' }]) as never)
        .mockReturnValueOnce(insertReturning([{ id: 'batch-b' }]) as never);
    };

    setup();
    const first = await executeScriptOnDevices({ scriptId: 'script-1', deviceIds: ['org-a-1', 'org-b-1'], auth, permissions });
    setup();
    const second = await executeScriptOnDevices({ scriptId: 'script-1', deviceIds: ['org-a-1', 'org-b-1'], auth, permissions });

    expect(first.ok && first.admission.targets.map((target) => target.batchId)).toEqual(['batch-a', 'batch-b']);
    expect(second.ok && second.admission.requestId).not.toBe(first.ok && first.admission.requestId);
  });
});
