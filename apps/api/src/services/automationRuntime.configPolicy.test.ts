import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  resolveOwnedAutomationReferencesMock,
  seedActionResultsMock,
  recordActionDispatchMock,
  reconcileRunMock,
  createSoftwareDeploymentMock,
  isDeviceSoftwareCurrentMock,
} = vi.hoisted(() => ({
  resolveOwnedAutomationReferencesMock: vi.fn(),
  seedActionResultsMock: vi.fn(),
  recordActionDispatchMock: vi.fn(),
  reconcileRunMock: vi.fn(),
  createSoftwareDeploymentMock: vi.fn(),
  isDeviceSoftwareCurrentMock: vi.fn(),
}));

vi.mock('./automationActionResults', () => ({
  seedAutomationActionResults: seedActionResultsMock,
  recordAutomationActionDispatch: recordActionDispatchMock,
  reconcileAutomationRun: reconcileRunMock,
}));

vi.mock('./automationReferenceAuthorization', () => ({
  AutomationReferenceAuthorizationError: class AutomationReferenceAuthorizationError extends Error {
    readonly code = 'unknown_or_unauthorized_reference';
  },
  resolveOwnedAutomationReferences: resolveOwnedAutomationReferencesMock,
}));

// Mock DB and dependencies before importing
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
    // #3525 W05 — the dispatch fence reads the run row FOR SHARE through
    // db.execute before either runner seeds. Returning no row is "run not
    // found", which the fence deliberately treats as "not cancelled".
    execute: vi.fn(async () => []),
  },
}));

vi.mock('../db/schema', () => ({
  automationRuns: { id: 'id', automationId: 'automationId', status: 'status' },
  automationRunDeviceResults: { runId: 'runId', deviceId: 'deviceId' },
  configPolicyAutomations: { featureLinkId: 'featureLinkId' },
  configPolicyEffectiveFeatureLinks: { id: 'id', configPolicyId: 'configPolicyId' },
  configurationPolicies: { id: 'id', orgId: 'orgId', partnerId: 'partnerId' },
  organizations: { id: 'id', partnerId: 'partnerId', type: 'type' },
  automationResourceBindings: { automationId: 'automationId' },
  devices: { id: 'id', orgId: 'orgId', hostname: 'hostname', osType: 'osType', status: 'status' },
  scripts: { id: 'id', deletedAt: 'deletedAt' },
  notificationChannels: { id: 'id', orgId: 'orgId' },
  automations: { id: 'id', runCount: 'runCount' },
  alerts: { id: 'id' },
  alertRules: { id: 'id', orgId: 'orgId', name: 'name', targetType: 'targetType', targetId: 'targetId' },
  alertTemplates: { id: 'id', orgId: 'orgId', name: 'name' },
  deviceGroupMemberships: { deviceId: 'deviceId', groupId: 'groupId' },
}));

vi.mock('./eventBus', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./deploymentEngine', () => ({
  resolveDeploymentTargets: vi.fn().mockResolvedValue([]),
}));

vi.mock('./scriptDispatch', () => ({
  dispatchScriptToDevice: vi.fn().mockResolvedValue({ ok: false, code: 'insert_failed', error: 'mocked' }),
}));

vi.mock('./softwareDeployment', () => ({
  createSoftwareDeployment: createSoftwareDeploymentMock,
}));

vi.mock('./softwareCurrency', () => ({
  isDeviceSoftwareCurrent: isDeviceSoftwareCurrentMock,
  latestVersionsFromResolvedAutomationReferences: vi.fn((references: any) => {
    const latest = new Map();
    for (const [catalogId, version] of references.softwareVersionsByCatalogId) {
      latest.set(catalogId, {
        version,
        catalogName: references.softwareCatalogsById.get(catalogId)?.name ?? catalogId,
      });
    }
    return latest;
  }),
  resolveLatestVersionsByCatalogId: vi.fn().mockResolvedValue(new Map()),
}));

// #3409 PR3 P2: spied so the per-run call COUNT is assertable. The resolver's
// own behaviour is covered in tenantVariableResolution.test.ts.
vi.mock('./tenantVariableResolution', () => ({
  loadTenantVariableScope: vi.fn().mockResolvedValue({ orgIds: new Set() }),
}));

vi.mock('./notificationSenders', () => ({
  getEmailRecipients: vi.fn().mockReturnValue([]),
  sendEmailNotification: vi.fn().mockResolvedValue({ success: false }),
  sendWebhookNotification: vi.fn().mockResolvedValue({ success: false }),
}));

import { db } from '../db';
import {
  createConfigPolicyAutomationRun,
  executeAutomationRun,
  executeConfigPolicyAutomationRun,
} from './automationRuntime';
import { dispatchScriptToDevice } from './scriptDispatch';
import { publishEvent } from './eventBus';
import { loadTenantVariableScope } from './tenantVariableResolution';

function emptyResolvedReferences() {
  return {
    scriptsById: new Map(),
    softwareCatalogsById: new Map(),
    softwareVersionsByCatalogId: new Map(),
    notificationChannelsById: new Map(),
  };
}

function installTransactionMock() {
  const tx = {
    ...db,
    select: vi.fn((selection?: Record<string, unknown>) => {
      if (selection && Object.keys(selection).join(',') === 'partnerId') {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ partnerId: 'partner-1' }]),
            }),
          }),
        };
      }
      return selection ? db.select(selection as any) : db.select();
    }),
  };
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
}

function makeConfigPolicyAutomation(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'cpa-1',
    featureLinkId: 'fl-1',
    name: 'Test Automation',
    description: null,
    triggerType: 'schedule',
    cronExpression: '0 2 * * *',
    timezone: 'UTC',
    actions: [{ type: 'execute_command', command: 'echo hello' }],
    onFailure: 'stop',
    enabled: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mockInsertReturning(result: unknown[]) {
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(result),
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    }),
  } as any);
}

function mockInsertCapturingValues(result: unknown[]) {
  const valuesMock = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(result),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  });
  vi.mocked(db.insert).mockReturnValue({
    values: valuesMock,
  } as any);
  return valuesMock;
}

/**
 * Serves the three select shapes the standalone target-authority path uses:
 *
 *   `.where(...)`                        -> the unlocked locator reads
 *   `.where(...).orderBy(...).for(...)`  -> `devices FOR NO KEY UPDATE`
 *   `.where(...).limit(1).for(...)`      -> `organizations FOR SHARE`
 *
 * The organizations arm is derived from the device rows' own `orgId`s so the
 * default is "every org these devices sit in exists and belongs to
 * `partner-1`". That deliberately does NOT decide the test: the owner check in
 * `lockCurrentAutomationTargetDevices` still compares the DEVICE row's orgId
 * against the automation's owner, which is what the moved-target cases turn on.
 * Pass `orgRows` to model an org that is missing, reassigned, or quick-support.
 */
function selectableRows(
  rows: unknown[],
  _options: { locked?: boolean; orgRows?: unknown[] } = {},
) {
  const orgRows = _options.orgRows ?? [
    ...new Set(
      (rows as Array<{ orgId?: string }>).map((row) => row?.orgId).filter(Boolean) as string[],
    ),
  ].map((id) => ({ id, partnerId: 'partner-1', type: 'standard' }));
  const whereResult = Object.assign(Promise.resolve(rows), {
    orderBy: vi.fn().mockReturnValue({ for: vi.fn().mockResolvedValue(rows) }),
    limit: vi.fn().mockReturnValue({ for: vi.fn().mockResolvedValue(orgRows) }),
  });
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(whereResult),
    }),
  };
}

function mockSelectChain(result: unknown[]) {
  return vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(result),
        }),
      }),
    }),
  } as any);
}

// createConfigPolicyAutomationRun resolves the owning configurationPolicies.id
// from the feature-link id via:
//   db.select({ configPolicyId }).from(configPolicyEffectiveFeatureLinks).where(...).limit(1)
// Mock that lookup so the inserted configPolicyId is the resolved policy id, not
// the feature-link id (issue #1855).
function mockResolveConfigPolicyId(configPolicyId: string | null) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(
            configPolicyId === null
              ? []
              : [{ configPolicyId, orgId: 'org-1', partnerId: null }],
          ),
        }),
      }),
    }),
  } as any);
}

describe('createConfigPolicyAutomationRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installTransactionMock();
    resolveOwnedAutomationReferencesMock.mockResolvedValue(emptyResolvedReferences());
    seedActionResultsMock.mockResolvedValue(undefined);
    recordActionDispatchMock.mockResolvedValue(true);
    reconcileRunMock.mockResolvedValue(undefined);
    isDeviceSoftwareCurrentMock.mockResolvedValue(false);
    createSoftwareDeploymentMock.mockResolvedValue({
      deploymentId: 'deployment-1',
      status: 'pending',
      dispatchedDeviceIds: [],
      deviceResults: [],
    });
  });

  it('creates a run record with automationId=null and the resolved configPolicyId', async () => {
    // featureLinkId 'fl-1' resolves to configurationPolicies.id 'cp-1'.
    mockResolveConfigPolicyId('cp-1');
    const run = {
      id: 'run-1',
      automationId: null,
      configPolicyId: 'cp-1',
      configItemName: 'Test Automation',
      status: 'running',
      triggeredBy: 'scheduler',
      devicesTargeted: 2,
      devicesSucceeded: 0,
      devicesFailed: 0,
      logs: [],
    };
    const valuesMock = mockInsertCapturingValues([run]);

    const result = await createConfigPolicyAutomationRun({
      configPolicyId: 'cp-1',
      automation: makeConfigPolicyAutomation(),
      targetDeviceIds: ['dev-1', 'dev-2'],
      triggeredBy: 'scheduler',
    });

    expect(result.automationId).toBeNull();
    expect(result.configPolicyId).toBe('cp-1');
    expect(result.configItemName).toBe('Test Automation');
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: null,
        configPolicyId: 'cp-1',
        configItemName: 'Test Automation',
        triggeredBy: 'scheduler',
        devicesTargeted: 2,
      })
    );
  });

  it('writes the resolved configurationPolicies.id, NOT the feature-link id (#1855)', async () => {
    // The feature link 'fl-custom' belongs to configurationPolicies.id
    // 'cp-custom'. automation_runs.config_policy_id MUST hold the policy id so
    // the RLS EXISTS-join and the read route can resolve the owning org; writing
    // the feature-link id made the run RLS-invisible in the portal.
    const automation = makeConfigPolicyAutomation({ featureLinkId: 'fl-custom' });
    mockResolveConfigPolicyId('cp-custom');
    const run = {
      id: 'run-1',
      automationId: null,
      configPolicyId: 'cp-custom',
      configItemName: 'Test Automation',
      status: 'running',
    };
    const valuesMock = mockInsertCapturingValues([run]);

    const result = await createConfigPolicyAutomationRun({
      configPolicyId: 'cp-1',
      automation,
      targetDeviceIds: ['dev-1'],
      triggeredBy: 'manual',
    });

    expect(result.configPolicyId).toBe('cp-custom');
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: null,
        configPolicyId: 'cp-custom',
        triggeredBy: 'manual',
      })
    );
    // Guard against regressing to the bug: the feature-link id must never be
    // written as the config_policy_id.
    expect(valuesMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ configPolicyId: 'fl-custom' })
    );
  });

  it('sets configItemName to automation.name', async () => {
    const automation = makeConfigPolicyAutomation({ name: 'Custom Name' });
    mockResolveConfigPolicyId('cp-1');
    const run = {
      id: 'run-1',
      automationId: null,
      configItemName: 'Custom Name',
      status: 'running',
    };
    const valuesMock = mockInsertCapturingValues([run]);

    const result = await createConfigPolicyAutomationRun({
      configPolicyId: 'cp-1',
      automation,
      targetDeviceIds: ['dev-1'],
      triggeredBy: 'scheduler',
    });

    expect(result.configItemName).toBe('Custom Name');
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: null,
        configItemName: 'Custom Name',
      })
    );
  });

  it('throws a domain error when the feature link cannot be resolved (#1855)', async () => {
    // resolveConfigPolicyId returns null (orphaned/missing feature link). The
    // function must fail loudly rather than write a null config_policy_id (which
    // the RLS WITH CHECK would reject with an opaque error).
    mockResolveConfigPolicyId(null);
    const valuesMock = mockInsertCapturingValues([{ id: 'run-1' }]);

    await expect(
      createConfigPolicyAutomationRun({
      configPolicyId: 'cp-1',
        automation: makeConfigPolicyAutomation({ featureLinkId: 'fl-orphan' }),
        targetDeviceIds: ['dev-1'],
        triggeredBy: 'scheduler',
      })
    ).rejects.toThrow('Could not resolve configurationPolicies.id');
    // The insert must never be attempted when resolution fails.
    expect(valuesMock).not.toHaveBeenCalled();
  });

  it('throws when DB insert returns empty', async () => {
    mockResolveConfigPolicyId('cp-1');
    mockInsertReturning([]);

    await expect(
      createConfigPolicyAutomationRun({
      configPolicyId: 'cp-1',
        automation: makeConfigPolicyAutomation(),
        targetDeviceIds: ['dev-1'],
        triggeredBy: 'scheduler',
      })
    ).rejects.toThrow('Failed to create config policy automation run record');
  });

  it('records the correct number of targeted devices', async () => {
    const run = {
      id: 'run-1',
      automationId: null,
      devicesTargeted: 3,
      status: 'running',
    };
    mockResolveConfigPolicyId('cp-1');
    mockInsertReturning([run]);

    const result = await createConfigPolicyAutomationRun({
      configPolicyId: 'cp-1',
      automation: makeConfigPolicyAutomation(),
      targetDeviceIds: ['dev-1', 'dev-2', 'dev-3'],
      triggeredBy: 'scheduler',
    });

    expect(result.devicesTargeted).toBe(3);
  });

  it('includes triggeredBy and additional details in logs', async () => {
    const run = {
      id: 'run-1',
      automationId: null,
      status: 'running',
      logs: [{ timestamp: '2026-02-17T00:00:00Z', level: 'info', message: 'Config policy automation run created' }],
    };
    mockResolveConfigPolicyId('cp-1');
    mockInsertReturning([run]);

    const result = await createConfigPolicyAutomationRun({
      configPolicyId: 'cp-1',
      automation: makeConfigPolicyAutomation(),
      targetDeviceIds: ['dev-1'],
      triggeredBy: 'cron-worker',
      details: { scheduledAt: '2026-02-17T02:00:00Z' },
    });

    expect(result.status).toBe('running');
  });
});

describe('executeConfigPolicyAutomationRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installTransactionMock();
    resolveOwnedAutomationReferencesMock.mockResolvedValue(emptyResolvedReferences());
    seedActionResultsMock.mockResolvedValue(undefined);
    recordActionDispatchMock.mockResolvedValue(true);
    reconcileRunMock.mockResolvedValue(undefined);
    // Default fence read: no row, i.e. "not cancelled".
    vi.mocked(db.execute).mockResolvedValue([] as any);
  });

  it('throws when orgId cannot be resolved', async () => {
    // resolveConfigPolicyOrgId does a dynamic import of ../db/schema and then
    // db.select().from(...).innerJoin(...).where(...).limit(1)
    // The feature link resolves, but its parent policy has no org owner.
    mockSelectChain([{ configPolicyId: 'cp-1', orgId: null, partnerId: 'partner-1' }]);

    await expect(
      executeConfigPolicyAutomationRun(
        makeConfigPolicyAutomation(),
        'cp-1',
        ['dev-1'],
        'scheduler',
      )
    ).rejects.toThrow('Could not resolve orgId');
  });

  it('returns failed status when actions are malformed', async () => {
    const automation = makeConfigPolicyAutomation({ actions: 'not-an-array' });

    // First call: resolveConfigPolicyOrgId → returns orgId
    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // resolveConfigPolicyOrgId select
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ orgId: 'org-1' }]),
              }),
            }),
          }),
        } as any;
      }
      // Fallback for any other selects
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any;
    });

    // Mock insert for createConfigPolicyAutomationRun
    const run = { id: 'run-1', automationId: null, status: 'running', logs: [] };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([run]),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    // Mock update for status change with captured setMock
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    const result = await executeConfigPolicyAutomationRun(automation, 'cp-1', ['dev-1'], 'scheduler');
    expect(result.status).toBe('failed');
    expect(result.devicesSucceeded).toBe(0);
    expect(result.devicesFailed).toBe(1);
    // Verify final status was persisted to DB
    const lastSetCall = setMock.mock.calls[setMock.mock.calls.length - 1]![0];
    expect(lastSetCall.status).toBe('failed');
  });

  it('keeps the parent running after an accepted asynchronous command dispatch', async () => {
    const automation = makeConfigPolicyAutomation({
      actions: [{ type: 'execute_command', command: 'echo ok' }],
    });

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // resolveConfigPolicyOrgId
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ orgId: 'org-1' }]),
              }),
            }),
          }),
        } as any;
      }
      if (selectCallCount === 2) {
        // Load devices
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: 'dev-1', hostname: 'host-1', displayName: null, osType: 'linux', status: 'online' },
            ]),
          }),
        } as any;
      }
      // Empty for scripts / channels
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any;
    });

    // Mock insert for run creation
    const run = { id: 'run-1', automationId: null, status: 'running', logs: [] };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([run]),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    // Mock update with captured setMock
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    // Mock the dispatch core to succeed
    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: true, commandId: 'cmd-1', executionId: null, delivered: true, executedAt: new Date(),
    } as any);

    const result = await executeConfigPolicyAutomationRun(automation, 'cp-1', ['dev-1'], 'scheduler');
    expect(result.status).toBe('running');
    expect(result.devicesSucceeded).toBe(0);
    expect(result.devicesFailed).toBe(0);
    expect(seedActionResultsMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      device: expect.objectContaining({ id: 'dev-1' }),
      actions: [{ actionIndex: 0, actionType: 'execute_command' }],
    }));
    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', deviceId: 'dev-1', actionIndex: 0, status: 'delivered', commandId: 'cmd-1',
    }));
    expect(reconcileRunMock).toHaveBeenCalledWith('run-1');
    expect(setMock.mock.calls.map(([values]) => values)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ completedAt: expect.anything() })]),
    );

    // execute_command builds a 'raw' dispatch source — assert the mapping
    // reaching dispatchScriptToDevice: shell -> language, and provenance
    // stamped with this automation's id (used by scriptDispatch/audit to
    // attribute ad-hoc command content back to the triggering automation).
    expect(dispatchScriptToDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          kind: 'raw',
          content: 'echo ok',
          language: 'bash',
          provenance: `automation:${automation.id}`,
        },
      }),
    );
  });

  it('returns failed when device action fails and onFailure is stop', async () => {
    const automation = makeConfigPolicyAutomation({
      actions: [
        { type: 'execute_command', command: 'echo fail' },
        { type: 'execute_command', command: 'echo must-not-run' },
      ],
      onFailure: 'stop',
    });

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ orgId: 'org-1' }]),
              }),
            }),
          }),
        } as any;
      }
      if (selectCallCount === 2) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: 'dev-1', hostname: 'host-1', displayName: null, osType: 'linux', status: 'online' },
            ]),
          }),
        } as any;
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any;
    });

    const run = { id: 'run-1', automationId: null, status: 'running', logs: [] };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([run]),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    // Dispatch fails
    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: false, code: 'insert_failed', error: 'Queue error',
    } as any);

    const result = await executeConfigPolicyAutomationRun(automation, 'cp-1', ['dev-1'], 'scheduler');
    expect(result.status).toBe('failed');
    expect(result.devicesFailed).toBe(1);
    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', deviceId: 'dev-1', actionIndex: 0, status: 'failed',
    }));
    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', deviceId: 'dev-1', actionIndex: 1, status: 'skipped',
    }));
    expect(dispatchScriptToDevice).toHaveBeenCalledTimes(1);
    expect(reconcileRunMock).toHaveBeenCalledWith('run-1');
  });

  /**
   * #4919 — a maintenance window suppressing an `execute_command` action is
   * the operator's own schedule, not an automation defect. The whole point of
   * classifying it as `skipped` rather than `failed` is visible here: with
   * `onFailure: 'stop'` a failure would abort the device's remaining actions
   * and redden the run. A skip must do neither.
   */
  it('records a maintenance-suppressed execute_command as skipped, keeps the run green, and still runs the next action', async () => {
    const automation = makeConfigPolicyAutomation({
      actions: [
        { type: 'execute_command', command: 'echo one' },
        { type: 'execute_command', command: 'echo two' },
      ],
      onFailure: 'stop',
    });

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ orgId: 'org-1' }]),
              }),
            }),
          }),
        } as any;
      }
      if (selectCallCount === 2) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: 'dev-1', hostname: 'host-1', displayName: null, osType: 'linux', status: 'online' },
            ]),
          }),
        } as any;
      }
      return {
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      } as any;
    });

    const run = { id: 'run-1', automationId: null, status: 'running', logs: [] };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([run]),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);

    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: false,
      code: 'maintenance_suppressed',
      error: 'Device is in a maintenance window that suppresses script execution',
    } as any);

    const result = await executeConfigPolicyAutomationRun(automation, 'cp-1', ['dev-1'], 'scheduler');

    expect(result.status).not.toBe('failed');
    expect(result.devicesFailed).toBe(0);
    // Both actions were attempted — the first skip did not abort the device.
    expect(dispatchScriptToDevice).toHaveBeenCalledTimes(2);
    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', deviceId: 'dev-1', actionIndex: 0, status: 'skipped',
    }));
    // The skip REASON is persisted on the action result, not just the status —
    // `persistActionExecutionOutcome` had to learn to take `outcome.message`
    // for 'skipped' as well as 'failed', or the row records the generic log
    // line and the operator cannot tell a maintenance skip from any other.
    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', deviceId: 'dev-1', actionIndex: 1, status: 'skipped',
      message: expect.stringContaining('maintenance window'),
    }));
  });

  it('does not dispatch a later command after an earlier software refusal with stop', async () => {
    const automation = makeConfigPolicyAutomation({
      actions: [
        { type: 'deploy_software', catalogId: 'catalog-1' },
        { type: 'execute_command', command: 'echo must-not-run' },
      ],
      onFailure: 'stop',
    });
    resolveOwnedAutomationReferencesMock.mockResolvedValue({
      ...emptyResolvedReferences(),
      softwareCatalogsById: new Map([['catalog-1', {
        id: 'catalog-1', name: 'Tool', orgId: 'org-1', partnerId: null,
      }]]),
      softwareVersionsByCatalogId: new Map([['catalog-1', {
        id: 'version-1', catalogId: 'catalog-1', version: '1.0.0', supportedOs: ['linux'],
      }]]),
    });

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ orgId: 'org-1' }]),
              }),
            }),
          }),
        } as any;
      }
      if (selectCallCount === 2) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{
              id: 'dev-1', orgId: 'org-1', hostname: 'host-1', displayName: null,
              osType: 'linux', status: 'online',
            }]),
          }),
        } as any;
      }
      return {
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      } as any;
    });

    const run = { id: 'run-1', automationId: null, status: 'running', logs: [] };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([run]),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
    createSoftwareDeploymentMock.mockResolvedValue({
      deploymentId: 'deployment-1',
      status: 'pending',
      dispatchedDeviceIds: [],
      deviceResults: [{
        deviceId: 'dev-1', deploymentResultId: 'result-1', status: 'failed',
        deviceCommandId: null, message: 'policy denied',
      }],
    });

    const result = await executeConfigPolicyAutomationRun(automation, 'cp-1', ['dev-1'], 'scheduler');

    expect(result.status).toBe('failed');
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', deviceId: 'dev-1', actionIndex: 0, status: 'failed',
      deploymentResultId: 'result-1',
    }));
    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', deviceId: 'dev-1', actionIndex: 1, status: 'skipped',
    }));
  });

  it('returns partial when some devices fail and some succeed', async () => {
    const automation = makeConfigPolicyAutomation({
      actions: [{ type: 'execute_command', command: 'echo test' }],
      onFailure: 'continue',
    });

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ orgId: 'org-1' }]),
              }),
            }),
          }),
        } as any;
      }
      if (selectCallCount === 2) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: 'dev-1', hostname: 'host-1', displayName: null, osType: 'linux', status: 'online' },
              { id: 'dev-2', hostname: 'host-2', displayName: null, osType: 'linux', status: 'online' },
            ]),
          }),
        } as any;
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any;
    });

    const run = { id: 'run-1', automationId: null, status: 'running', logs: [] };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([run]),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    // First device fails, second succeeds (counter-based: dispatchScriptToDevice
    // does not receive deviceId directly, so we rely on call order)
    let cmdCallCount = 0;
    vi.mocked(dispatchScriptToDevice).mockImplementation(async () => {
      cmdCallCount++;
      if (cmdCallCount === 1) return { ok: false, code: 'insert_failed', error: 'fail' } as any;
      return { ok: true, commandId: 'cmd-2', executionId: null, delivered: true, executedAt: new Date() } as any;
    });

    const result = await executeConfigPolicyAutomationRun(automation, 'cp-1', ['dev-1', 'dev-2'], 'scheduler');
    expect(result.status).toBe('running');
    expect(result.devicesSucceeded).toBe(0);
    expect(result.devicesFailed).toBe(0);
  });

  // #3409 PR3 P2 — the N-connection trap. Before the hoist,
  // executeRunScriptAction called loadTenantVariableScope itself, so this run
  // (4 devices × 1 run_script action, inside runWithConcurrency(…, 5, …))
  // issued FOUR scope loads, each escaping the ambient context and taking a
  // second pooled connection. It must now issue exactly ONE, covering the
  // run's distinct org set.
  //
  // Mutation check for this test: move the load back inside
  // executeRunScriptAction and the call count becomes 4.
  it('loads the tenant-variable scope ONCE per run, not once per device (#3409 PR3 P2)', async () => {
    const automation = makeConfigPolicyAutomation({
      actions: [{ type: 'run_script', scriptId: 'script-1' }],
    });

    const scope = { orgIds: new Set(['org-1', 'org-2']) };
    vi.mocked(loadTenantVariableScope).mockResolvedValue(scope as any);

    // Four devices spread over two orgs — the load must be keyed by the
    // DISTINCT org set, not by the device list.
    const deviceRows = [
      { id: 'dev-1', orgId: 'org-1', hostname: 'host-1', displayName: null, osType: 'linux', status: 'online', agentId: 'a1', siteId: 'site-1', customFields: {} },
      { id: 'dev-2', orgId: 'org-2', hostname: 'host-2', displayName: null, osType: 'linux', status: 'online', agentId: 'a2', siteId: 'site-2', customFields: {} },
      { id: 'dev-3', orgId: 'org-1', hostname: 'host-3', displayName: null, osType: 'linux', status: 'online', agentId: 'a3', siteId: 'site-1', customFields: {} },
      { id: 'dev-4', orgId: 'org-2', hostname: 'host-4', displayName: null, osType: 'linux', status: 'online', agentId: 'a4', siteId: 'site-2', customFields: {} },
    ];

    // The script content MUST carry a {{var.*}} token: the preload is gated on
    // it, so a token-free fixture would still pass with the gate forced false.
    const scriptRows = [
      { id: 'script-1', orgId: null, osTypes: ['linux'], runAs: 'system', content: 'curl {{var.repo_url}}', language: 'bash', timeoutSeconds: 60 },
    ];
    resolveOwnedAutomationReferencesMock.mockResolvedValue({
      ...emptyResolvedReferences(),
      scriptsById: new Map(scriptRows.map((script) => [script.id, script])),
    });

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // resolveConfigPolicyOrgId
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ orgId: 'org-1' }]),
              }),
            }),
          }),
        } as any;
      }
      if (selectCallCount === 2) {
        return {
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(deviceRows) }),
        } as any;
      }
      if (selectCallCount === 4) {
        return {
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(scriptRows) }),
        } as any;
      }
      return {
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      } as any;
    });

    const run = { id: 'run-1', automationId: null, status: 'running', logs: [] };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([run]),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);

    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: true, commandId: 'cmd-1', executionId: null, delivered: true, deliveryOutcome: 'sent', executedAt: new Date(), runAs: 'system' as const, targetSessionId: null, ignoredParameters: [],
    } as any);

    const result = await executeConfigPolicyAutomationRun(
      automation,
      'cp-1',
      deviceRows.map((d) => d.id),
      'scheduler',
    );

    expect(result.devicesSucceeded).toBe(0);
    expect(dispatchScriptToDevice).toHaveBeenCalledTimes(4);

    // The assertion this test exists for.
    expect(loadTenantVariableScope).toHaveBeenCalledTimes(1);
    expect(loadTenantVariableScope).toHaveBeenCalledWith(['org-1', 'org-2']);

    // ...and every device's dispatch got that one snapshot.
    for (const [args] of vi.mocked(dispatchScriptToDevice).mock.calls) {
      expect((args as any).variableScope).toBe(scope);
    }
  });

  it('delegates terminal publication to reconciliation after accepted dispatch', async () => {
    const automation = makeConfigPolicyAutomation({
      actions: [{ type: 'execute_command', command: 'echo ok' }],
    });

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ orgId: 'org-1' }]),
              }),
            }),
          }),
        } as any;
      }
      if (selectCallCount === 2) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: 'dev-1', hostname: 'host-1', displayName: null, osType: 'linux', status: 'online' },
            ]),
          }),
        } as any;
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any;
    });

    const run = { id: 'run-1', automationId: null, status: 'running', logs: [] };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([run]),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: true, commandId: 'cmd-1', executionId: null, delivered: true, executedAt: new Date(),
    } as any);

    await executeConfigPolicyAutomationRun(automation, 'cp-1', ['dev-1'], 'scheduler');

    expect(publishEvent).not.toHaveBeenCalled();
    expect(reconcileRunMock).toHaveBeenCalledWith('run-1');
  });

  it('delegates refusal terminal publication to reconciliation', async () => {
    const automation = makeConfigPolicyAutomation({
      actions: [{ type: 'execute_command', command: 'echo fail' }],
    });

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ orgId: 'org-1' }]),
              }),
            }),
          }),
        } as any;
      }
      if (selectCallCount === 2) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: 'dev-1', hostname: 'host-1', displayName: null, osType: 'linux', status: 'online' },
            ]),
          }),
        } as any;
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any;
    });

    const run = { id: 'run-1', automationId: null, status: 'running', logs: [] };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([run]),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: false, code: 'insert_failed', error: 'Queue error',
    } as any);

    await executeConfigPolicyAutomationRun(automation, 'cp-1', ['dev-1'], 'scheduler');

    expect(publishEvent).not.toHaveBeenCalled();
    expect(reconcileRunMock).toHaveBeenCalledWith('run-1');
  });

  it('handles zero target devices gracefully', async () => {
    const automation = makeConfigPolicyAutomation({
      actions: [{ type: 'execute_command', command: 'echo ok' }],
    });

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ orgId: 'org-1' }]),
              }),
            }),
          }),
        } as any;
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any;
    });

    const run = { id: 'run-1', automationId: null, status: 'running', logs: [] };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([run]),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    const result = await executeConfigPolicyAutomationRun(automation, 'cp-1', [], 'scheduler');
    expect(result.status).toBe('completed');
    expect(result.devicesSucceeded).toBe(0);
    expect(result.devicesFailed).toBe(0);
    expect(reconcileRunMock).toHaveBeenCalledWith('run-1');
  });

  // #3525 W05 — the config-policy runner carries the same fence. Cancelling a
  // config-policy run is out of scope for the ROUTE (OD10-B), but the fence is
  // unconditional so a run cancelled through any other door still stops here.
  it('refuses to seed a config-policy run that was already cancelled', async () => {
    const automation = makeConfigPolicyAutomation({
      actions: [{ type: 'execute_command', command: 'echo nope' }],
    });

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ orgId: 'org-1' }]),
              }),
            }),
          }),
        } as any;
      }
      if (selectCallCount === 2) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: 'dev-1', hostname: 'host-1', displayName: null, osType: 'linux', status: 'online' },
            ]),
          }),
        } as any;
      }
      return { from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) } as any;
    });

    const run = { id: 'run-cp-cancelled', automationId: null, status: 'cancelled', logs: [] };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([run]),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
    // The FOR SHARE fence read sees the cancelled run.
    vi.mocked(db.execute).mockResolvedValueOnce([{ status: 'cancelled' }] as any);

    const result = await executeConfigPolicyAutomationRun(automation, 'cp-1', ['dev-1'], 'scheduler');

    expect(result).toEqual({
      runId: 'run-cp-cancelled',
      status: 'cancelled',
      devicesSucceeded: 0,
      devicesFailed: 0,
    });
    expect(seedActionResultsMock).not.toHaveBeenCalled();
    expect(recordActionDispatchMock).not.toHaveBeenCalled();
    expect(reconcileRunMock).not.toHaveBeenCalled();
  });

  it('propagates reconciliation publication failures', async () => {
    const automation = makeConfigPolicyAutomation({
      actions: [{ type: 'execute_command', command: 'echo ok' }],
    });

    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ orgId: 'org-1' }]),
              }),
            }),
          }),
        } as any;
      }
      if (selectCallCount === 2) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: 'dev-1', hostname: 'host-1', displayName: null, osType: 'linux', status: 'online' },
            ]),
          }),
        } as any;
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any;
    });

    const run = { id: 'run-1', automationId: null, status: 'running', logs: [] };
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([run]),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: true, commandId: 'cmd-1', executionId: null, delivered: true, executedAt: new Date(),
    } as any);

    reconcileRunMock.mockRejectedValueOnce(new Error('Redis down'));

    await expect(
      executeConfigPolicyAutomationRun(automation, 'cp-1', ['dev-1'], 'scheduler')
    ).rejects.toThrow('Redis down');
  });
});

describe('executeAutomationRun durable dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installTransactionMock();
    resolveOwnedAutomationReferencesMock.mockResolvedValue(emptyResolvedReferences());
    seedActionResultsMock.mockResolvedValue(undefined);
    recordActionDispatchMock.mockResolvedValue(true);
    reconcileRunMock.mockResolvedValue(undefined);
  });

  it('seeds ordinary-run actions and leaves accepted raw dispatch nonterminal', async () => {
    const run = {
      id: 'run-ordinary',
      automationId: 'auto-ordinary',
      status: 'running',
      triggeredBy: 'scheduler',
      logs: [],
    };
    const automation = {
      id: 'auto-ordinary',
      orgId: 'org-1',
      partnerId: null,
      name: 'Ordinary automation',
      trigger: { type: 'manual' },
      conditions: null,
      actions: [{ type: 'execute_command', command: 'echo ordinary' }],
      onFailure: 'stop',
      notificationTargets: null,
      createdBy: 'user-1',
    };
    let selectCall = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCall += 1;
      if (selectCall === 1 || selectCall === 2) {
        const rows = selectCall === 1 ? [run] : [automation];
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
          }),
        } as any;
      }
      if (selectCall === 3) {
        return {
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
        } as any;
      }
      const rows = [{
        id: 'dev-1', orgId: 'org-1', hostname: 'host-1', displayName: null,
        osType: 'linux', status: 'online', agentId: 'agent-1', siteId: null,
        customFields: null,
      }];
      return selectableRows(rows, { locked: selectCall >= 5 }) as any;
    });
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: true, commandId: 'cmd-ordinary', executionId: null, delivered: true,
      executedAt: new Date(), ignoredParameters: [],
    } as any);

    const result = await executeAutomationRun(run.id, ['dev-1']);

    expect(result).toEqual({ status: 'running', devicesSucceeded: 0, devicesFailed: 0 });
    expect(seedActionResultsMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.id,
      device: expect.objectContaining({ id: 'dev-1', orgId: 'org-1' }),
      actions: [{ actionIndex: 0, actionType: 'execute_command' }],
    }));
    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.id,
      deviceId: 'dev-1',
      actionIndex: 0,
      status: 'delivered',
      commandId: 'cmd-ordinary',
    }));
    expect(reconcileRunMock).toHaveBeenCalledWith(run.id);
  });

  it('re-locks the current owner boundary around a standalone software deployment batch', async () => {
    const run = {
      id: 'run-deploy-lock', automationId: 'auto-deploy-lock', status: 'running',
      triggeredBy: 'scheduler', logs: [],
    };
    const automation = {
      id: 'auto-deploy-lock', orgId: 'org-1', partnerId: null, name: 'Deploy lock',
      trigger: { type: 'manual' }, conditions: null,
      actions: [{ type: 'deploy_software', catalogId: 'catalog-1' }],
      onFailure: 'stop', notificationTargets: null, createdBy: 'user-1',
    };
    const device = {
      id: 'dev-1', orgId: 'org-1', hostname: 'host-1', displayName: null,
      osType: 'linux', status: 'online', agentId: 'agent-1', siteId: null, customFields: null,
    };
    resolveOwnedAutomationReferencesMock.mockResolvedValue({
      ...emptyResolvedReferences(),
      softwareCatalogsById: new Map([['catalog-1', {
        id: 'catalog-1', name: 'Tool', orgId: 'org-1', partnerId: null,
      }]]),
      softwareVersionsByCatalogId: new Map([['catalog-1', {
        id: 'version-1', catalogId: 'catalog-1', version: '1.0.0', supportedOs: ['linux'],
      }]]),
    });
    let selectCall = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCall += 1;
      if (selectCall === 1 || selectCall === 2) {
        return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(selectCall === 1 ? [run] : [automation]),
        }) }) } as any;
      }
      if (selectCall === 3) return selectableRows([{
        resourceKind: 'software_catalog', resourceId: 'catalog-1', state: 'active',
        expectedResourceOrgId: 'org-1', expectedResourcePartnerId: null,
        expectedResourceIsSystem: false,
      }]) as any;
      return selectableRows([device]) as any;
    });
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
    isDeviceSoftwareCurrentMock.mockResolvedValue(false);
    createSoftwareDeploymentMock.mockResolvedValue({
      deploymentId: 'deployment-1', status: 'pending', dispatchedDeviceIds: [device.id],
      deviceResults: [{
        deviceId: device.id, deploymentResultId: 'result-1', status: 'pending',
        deviceCommandId: 'command-1', message: null,
      }],
    });

    await executeAutomationRun(run.id, [device.id]);

    expect(createSoftwareDeploymentMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: device.orgId,
      deviceIds: [device.id],
    }));
    // Initial target load, per-action refresh, then the load-bearing locked
    // refresh enclosing createSoftwareDeployment.
    expect(selectCall).toBeGreaterThanOrEqual(6);
  });

  it('does not dispatch any action when a queued target has moved outside the automation owner org', async () => {
    const run = {
      id: 'run-moved',
      automationId: 'auto-source-org',
      status: 'running',
      triggeredBy: 'scheduler',
      logs: [],
    };
    const automation = {
      id: 'auto-source-org',
      orgId: 'org-source',
      partnerId: null,
      name: 'Source organization automation',
      trigger: { type: 'manual' },
      conditions: null,
      actions: [{ type: 'execute_command', command: 'echo must-not-run' }],
      onFailure: 'stop',
      notificationTargets: null,
      createdBy: 'user-1',
    };
    let selectCall = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCall += 1;
      if (selectCall === 1 || selectCall === 2) {
        const rows = selectCall === 1 ? [run] : [automation];
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
          }),
        } as any;
      }
      if (selectCall === 3) {
        return { from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) } as any;
      }
      // Simulate the stale bare-id lookup returning the same device after an
      // independently authorized move to another organization.
      return selectableRows([{
        id: 'dev-moved', orgId: 'org-destination', hostname: 'moved-host', displayName: null,
        osType: 'linux', status: 'online', agentId: 'agent-moved', siteId: null,
        customFields: null,
      }]) as any;
    });
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);

    await executeAutomationRun(run.id, ['dev-moved']);

    expect(seedActionResultsMock).not.toHaveBeenCalled();
    expect(recordActionDispatchMock).not.toHaveBeenCalled();
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(createSoftwareDeploymentMock).not.toHaveBeenCalled();
  });

  it('stops before the next action when a target moves outside the owner org during a run', async () => {
    const run = {
      id: 'run-mid-move', automationId: 'auto-mid-move', status: 'running',
      triggeredBy: 'scheduler', logs: [],
    };
    const automation = {
      id: 'auto-mid-move', orgId: 'org-source', partnerId: null,
      name: 'Mid-run movement automation', trigger: { type: 'manual' }, conditions: null,
      actions: [
        { type: 'execute_command', command: 'echo first' },
        { type: 'execute_command', command: 'echo second' },
      ],
      onFailure: 'stop', notificationTargets: null, createdBy: 'user-1',
    };
    const sourceDevice = {
      id: 'dev-mid-move', orgId: 'org-source', hostname: 'source-host', displayName: null,
      osType: 'linux', status: 'online', agentId: 'agent-source', siteId: null,
      customFields: null,
    };
    const movedDevice = { ...sourceDevice, orgId: 'org-destination', agentId: 'agent-destination' };
    let selectCall = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCall += 1;
      if (selectCall === 1 || selectCall === 2) {
        const rows = selectCall === 1 ? [run] : [automation];
        return { from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
        }) } as any;
      }
      if (selectCall === 3) {
        return { from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) } as any;
      }
      // Selects 4..8 are the admission load plus the WHOLE of action 0:
      // per-action load (5), then the lock sequence — candidate org read (6),
      // `organizations FOR SHARE` (7), `devices FOR NO KEY UPDATE` (8). The
      // device moves only once action 0 has fully dispatched, so action 1's
      // re-read at select 9 is the first to see it in the destination org.
      const rows = selectCall <= 8 ? [sourceDevice] : [movedDevice];
      return selectableRows(rows, { locked: selectCall === 8 }) as any;
    });
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: true, commandId: 'cmd-first', executionId: null, delivered: true,
      executedAt: new Date(), ignoredParameters: [],
    } as any);

    await executeAutomationRun(run.id, [sourceDevice.id]);

    expect(dispatchScriptToDevice).toHaveBeenCalledOnce();
    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.id, deviceId: sourceDevice.id, actionIndex: 1, status: 'failed',
      message: expect.stringContaining('no longer belongs'),
    }));
  });

  // #3525 W05 — the dispatch fence. A BullMQ job is not permission to
  // dispatch: before this wave neither runner checked run status, so a job
  // picked up after an operator hit Stop ran the whole automation anyway.
  it('refuses to seed anything at all for an already-cancelled run', async () => {
    const run = {
      id: 'run-cancelled',
      automationId: 'auto-cancelled',
      status: 'cancelled',
      triggeredBy: 'scheduler',
      logs: [],
    };
    const automation = {
      id: 'auto-cancelled',
      orgId: 'org-1',
      partnerId: null,
      name: 'Cancelled automation',
      trigger: { type: 'manual' },
      conditions: null,
      actions: [{ type: 'execute_command', command: 'echo nope' }],
      onFailure: 'stop',
      notificationTargets: null,
      createdBy: 'user-1',
    };
    let selectCall = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCall += 1;
      if (selectCall === 1 || selectCall === 2) {
        const rows = selectCall === 1 ? [run] : [automation];
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
          }),
        } as any;
      }
      if (selectCall === 3) {
        return { from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) } as any;
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            id: 'dev-1', orgId: 'org-1', hostname: 'host-1', displayName: null,
            osType: 'linux', status: 'online', agentId: 'agent-1', siteId: null,
            customFields: null,
          }]),
        }),
      } as any;
    });
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
    // The fence read (SELECT ... FOR SHARE) sees the cancelled run.
    vi.mocked(db.execute).mockResolvedValueOnce([{ status: 'cancelled' }] as any);

    const result = await executeAutomationRun(run.id, ['dev-1']);

    expect(result).toEqual({ status: 'cancelled', devicesSucceeded: 0, devicesFailed: 0 });
    expect(seedActionResultsMock).not.toHaveBeenCalled();
    expect(recordActionDispatchMock).not.toHaveBeenCalled();
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });
});
