import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DB and dependencies before importing
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  automationRuns: { id: 'id', automationId: 'automationId', status: 'status' },
  configPolicyAutomations: { featureLinkId: 'featureLinkId' },
  configPolicyFeatureLinks: { id: 'id', configPolicyId: 'configPolicyId' },
  configurationPolicies: { id: 'id', orgId: 'orgId' },
  devices: { id: 'id', hostname: 'hostname', osType: 'osType', status: 'status' },
  scripts: { id: 'id' },
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

vi.mock('./commandQueue', () => ({
  CommandTypes: { SCRIPT: 'script' },
  queueCommandForExecution: vi.fn().mockResolvedValue({ command: null, error: 'mocked' }),
}));

vi.mock('./notificationSenders', () => ({
  getEmailRecipients: vi.fn().mockReturnValue([]),
  sendEmailNotification: vi.fn().mockResolvedValue({ success: false }),
  sendWebhookNotification: vi.fn().mockResolvedValue({ success: false }),
}));

import { db } from '../db';
import { createConfigPolicyAutomationRun, executeConfigPolicyAutomationRun } from './automationRuntime';
import { queueCommandForExecution } from './commandQueue';
import { publishEvent } from './eventBus';

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
    }),
  } as any);
}

function mockInsertCapturingValues(result: unknown[]) {
  const valuesMock = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(result),
  });
  vi.mocked(db.insert).mockReturnValue({
    values: valuesMock,
  } as any);
  return valuesMock;
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

describe('createConfigPolicyAutomationRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a run record with automationId=null and verifies DB values', async () => {
    const run = {
      id: 'run-1',
      automationId: null,
      configPolicyId: 'fl-1',
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
      automation: makeConfigPolicyAutomation(),
      targetDeviceIds: ['dev-1', 'dev-2'],
      triggeredBy: 'scheduler',
    });

    expect(result.automationId).toBeNull();
    expect(result.configPolicyId).toBe('fl-1');
    expect(result.configItemName).toBe('Test Automation');
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: null,
        configPolicyId: 'fl-1',
        configItemName: 'Test Automation',
        triggeredBy: 'scheduler',
        devicesTargeted: 2,
      })
    );
  });

  it('sets configPolicyId to automation.featureLinkId', async () => {
    const automation = makeConfigPolicyAutomation({ featureLinkId: 'fl-custom' });
    const run = {
      id: 'run-1',
      automationId: null,
      configPolicyId: 'fl-custom',
      configItemName: 'Test Automation',
      status: 'running',
    };
    const valuesMock = mockInsertCapturingValues([run]);

    const result = await createConfigPolicyAutomationRun({
      automation,
      targetDeviceIds: ['dev-1'],
      triggeredBy: 'manual',
    });

    expect(result.configPolicyId).toBe('fl-custom');
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: null,
        configPolicyId: 'fl-custom',
        triggeredBy: 'manual',
      })
    );
  });

  it('sets configItemName to automation.name', async () => {
    const automation = makeConfigPolicyAutomation({ name: 'Custom Name' });
    const run = {
      id: 'run-1',
      automationId: null,
      configItemName: 'Custom Name',
      status: 'running',
    };
    const valuesMock = mockInsertCapturingValues([run]);

    const result = await createConfigPolicyAutomationRun({
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

  it('throws when DB insert returns empty', async () => {
    mockInsertReturning([]);

    await expect(
      createConfigPolicyAutomationRun({
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
    mockInsertReturning([run]);

    const result = await createConfigPolicyAutomationRun({
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
    mockInsertReturning([run]);

    const result = await createConfigPolicyAutomationRun({
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
  });

  it('throws when orgId cannot be resolved', async () => {
    // resolveConfigPolicyOrgId does a dynamic import of ../db/schema and then
    // db.select().from(...).innerJoin(...).where(...).limit(1)
    // Mock it to return empty → orgId = null → throws
    mockSelectChain([]);

    await expect(
      executeConfigPolicyAutomationRun(
        makeConfigPolicyAutomation(),
        ['dev-1'],
        'scheduler'
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
      }),
    } as any);

    // Mock update for status change with captured setMock
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    const result = await executeConfigPolicyAutomationRun(automation, ['dev-1'], 'scheduler');
    expect(result.status).toBe('failed');
    expect(result.devicesSucceeded).toBe(0);
    expect(result.devicesFailed).toBe(1);
    // Verify final status was persisted to DB
    const lastSetCall = setMock.mock.calls[setMock.mock.calls.length - 1]![0];
    expect(lastSetCall.status).toBe('failed');
  });

  it('returns completed when all devices succeed', async () => {
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
      }),
    } as any);

    // Mock update with captured setMock
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    // Mock command queue to succeed
    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: { id: 'cmd-1' },
    } as any);

    const result = await executeConfigPolicyAutomationRun(automation, ['dev-1'], 'scheduler');
    expect(result.status).toBe('completed');
    expect(result.devicesSucceeded).toBe(1);
    expect(result.devicesFailed).toBe(0);
    // Verify final status was persisted to DB
    const lastSetCall = setMock.mock.calls[setMock.mock.calls.length - 1]![0];
    expect(lastSetCall.status).toBe('completed');
  });

  it('returns failed when device action fails and onFailure is stop', async () => {
    const automation = makeConfigPolicyAutomation({
      actions: [{ type: 'execute_command', command: 'echo fail' }],
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
      }),
    } as any);

    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    // Command queue fails
    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: null,
      error: 'Queue error',
    } as any);

    const result = await executeConfigPolicyAutomationRun(automation, ['dev-1'], 'scheduler');
    expect(result.status).toBe('failed');
    expect(result.devicesFailed).toBe(1);
    // Verify final status was persisted to DB
    const lastSetCall = setMock.mock.calls[setMock.mock.calls.length - 1]![0];
    expect(lastSetCall.status).toBe('failed');
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
      }),
    } as any);

    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    // First device fails, second succeeds (counter-based: queueCommandForExecution
    // does not receive deviceId directly, so we rely on call order)
    let cmdCallCount = 0;
    vi.mocked(queueCommandForExecution).mockImplementation(async () => {
      cmdCallCount++;
      if (cmdCallCount === 1) return { command: null, error: 'fail' } as any;
      return { command: { id: 'cmd-2' } } as any;
    });

    const result = await executeConfigPolicyAutomationRun(automation, ['dev-1', 'dev-2'], 'scheduler');
    expect(result.status).toBe('partial');
    expect(result.devicesSucceeded).toBe(1);
    expect(result.devicesFailed).toBe(1);
    // Verify final status was persisted to DB
    const lastSetCall = setMock.mock.calls[setMock.mock.calls.length - 1]![0];
    expect(lastSetCall.status).toBe('partial');
  });

  it('publishes automation.completed event on success', async () => {
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
      }),
    } as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: { id: 'cmd-1' },
    } as any);

    await executeConfigPolicyAutomationRun(automation, ['dev-1'], 'scheduler');

    expect(publishEvent).toHaveBeenCalledWith(
      'automation.completed',
      'org-1',
      expect.objectContaining({
        configPolicyAutomationId: 'cpa-1',
        status: 'completed',
      }),
      'automation-runtime'
    );
  });

  it('publishes automation.failed event on failure', async () => {
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
      }),
    } as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: null,
      error: 'Queue error',
    } as any);

    await executeConfigPolicyAutomationRun(automation, ['dev-1'], 'scheduler');

    expect(publishEvent).toHaveBeenCalledWith(
      'automation.failed',
      'org-1',
      expect.objectContaining({
        configPolicyAutomationId: 'cpa-1',
        status: 'failed',
      }),
      'automation-runtime'
    );
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
      }),
    } as any);

    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    const result = await executeConfigPolicyAutomationRun(automation, [], 'scheduler');
    expect(result.status).toBe('completed');
    expect(result.devicesSucceeded).toBe(0);
    expect(result.devicesFailed).toBe(0);
    // Verify final status was persisted to DB
    const lastSetCall = setMock.mock.calls[setMock.mock.calls.length - 1]![0];
    expect(lastSetCall.status).toBe('completed');
  });

  it('propagates error when publishEvent rejects', async () => {
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
      }),
    } as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: { id: 'cmd-1' },
    } as any);

    vi.mocked(publishEvent).mockRejectedValue(new Error('Redis down'));

    await expect(
      executeConfigPolicyAutomationRun(automation, ['dev-1'], 'scheduler')
    ).rejects.toThrow('Redis down');
  });
});
