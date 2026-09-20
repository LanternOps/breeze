import { beforeEach, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../middleware/auth';
import type { PolicySources } from './loadSources';
const m = vi.hoisted(() => ({
  context: vi.fn(async (_context: unknown, fn: () => unknown) => fn()),
  authorize: vi.fn(),
  freshness: vi.fn(),
  sources: vi.fn(),
  devices: vi.fn(),
  equivalence: vi.fn(),
  prerequisites: vi.fn(),
  get: vi.fn(),
  setex: vi.fn(),
  add: vi.fn(),
  outside: vi.fn((fn: () => unknown) => fn()),
  transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{
              orgId: 'other-org',
              partnerId: null
            }]
        })
      })
    })
  }))
}));
vi.mock('../../../db', () => ({
  db: {
    transaction: m.transaction
  },
  withDbAccessContext: m.context,
  runOutsideDbContext: m.outside
}));
vi.mock('./previewScope', () => ({
  authorizePreview: m.authorize,
  previewFreshness: m.freshness,
  snapshotPreviewAccess: () => ({
    auth: {},
    dbContext: {}
  }),
  previewScopeHash: () => 'scope'
}));
vi.mock('./loadSources', () => ({
  loadPolicySources: m.sources
}));
vi.mock('./legacyBaseline', () => ({
  resolveDeviceIdsForPolicy: m.devices
}));
vi.mock('./equivalence', () => ({
  computeEquivalence: m.equivalence
}));
vi.mock('./prerequisites', () => ({
  missingConversionPrerequisites: m.prerequisites
}));
vi.mock('../../redis', () => ({
  getRedis: () => ({
    get: m.get,
    setex: m.setex
  })
}));
vi.mock('../../../jobs/monitorConversionPreviewWorker', () => ({
  getMonitorConversionPreviewQueue: () => ({
    add: m.add
  }),
  previewJobKey: (id: string, scope: string, freshness: string) => `preview:${id}:${scope}:${freshness}`
}));

import { buildPolicyConversionPreview, previewPolicyConversion } from './convert';
const auth = {
  scope: 'organization',
  user: {
    id: 'u'
  }
} as AuthContext;
const rule = {
  id: 'r',
  name: 'CPU',
  enabled: true,
  conditions: [{
      type: 'metric',
      metric: 'cpu',
      operator: 'gt',
      value: 90
    }],
  severity: 'high',
  cooldownMinutes: 5,
  autoResolve: true,
  autoResolveConditions: null,
  notificationChannelIds: [],
  escalationPolicyId: null
};
const sources: PolicySources = {
  policy: {
    id: 'policy',
    name: 'Policy',
    orgId: 'o',
    partnerId: null,
    parentPolicyId: null
  },
  links: {
    alertRule: 'link',
    monitoring: null,
    monitoringSettingsId: null,
    monitors: null
  },
  inlineRules: [rule as never],
  watches: [],
  policyAutomations: [],
  standaloneAutomations: [],
  openAlertsBySource: new Map([['r', 3]]),
  parentUnconverted: false
};

beforeEach(() => {
  vi.clearAllMocks();
  m.authorize.mockResolvedValue(sources.policy);
  m.sources.mockResolvedValue(structuredClone(sources));
  m.devices.mockResolvedValue(['d']);
  m.freshness.mockResolvedValue('fresh');
  m.prerequisites.mockReturnValue([]);
  m.equivalence.mockResolvedValue({
    devicesChecked: 1,
    deltas: []
  });
  m.get.mockResolvedValue(null);
  m.add.mockResolvedValue({});
});

it.each([0, 500])('runs %i devices inline', async (count) => {
  m.devices.mockResolvedValue(Array.from({
    length: count
  }, (_, i) => `${i}`));
  expect(await previewPolicyConversion('policy', auth)).toHaveProperty('previewHash');
  expect(m.equivalence).toHaveBeenCalled();
  expect(m.add).not.toHaveBeenCalled();
});

it('queues 501 devices with the caller snapshot outside DB context', async () => {
  m.devices.mockResolvedValue(Array.from({
    length: 501
  }, (_, i) => `${i}`));
  expect(await previewPolicyConversion('policy', auth)).toMatchObject({
    status: 'running',
    progress: {
      checked: 0,
      total: 501
    }
  });
  expect(m.equivalence).not.toHaveBeenCalled();
  expect(m.outside).toHaveBeenCalledOnce();
  expect(m.add).toHaveBeenCalledWith('preview', {
    policyId: 'policy',
    snapshot: {
      auth: {},
      dbContext: {}
    },
    scopeHash: 'scope',
    sourcesHash: 'fresh'
  }, expect.objectContaining({
    jobId: expect.not.stringContaining(':')
  }));
});

it('authorizes before cache reads and binds completed entries to both hashes', async () => {
  m.devices.mockResolvedValue(Array(501).fill('d'));
  m.authorize.mockRejectedValueOnce(new Error('denied'));
  await expect(previewPolicyConversion('policy', auth)).rejects.toThrow('denied');
  expect(m.get).not.toHaveBeenCalled();
  m.get.mockResolvedValue({});
  m.get.mockResolvedValueOnce(JSON.stringify({
    status: 'done',
    scopeHash: 'scope',
    sourcesHash: 'fresh',
    result: {
      previewHash: 'cached'
    }
  }));
  expect(await previewPolicyConversion('policy', auth)).toEqual({
    previewHash: 'cached'
  });
  m.get.mockResolvedValueOnce(JSON.stringify({
    status: 'done',
    scopeHash: 'other',
    sourcesHash: 'fresh',
    result: {
      previewHash: 'stale'
    }
  }));
  expect(await previewPolicyConversion('policy', auth)).toHaveProperty('status', 'running');
  expect(m.add).toHaveBeenCalledOnce();
});

it('recomputes failed cache entries and allows explicit inline mode', async () => {
  m.devices.mockResolvedValue(Array(501).fill('d'));
  m.get.mockResolvedValue(JSON.stringify({
    status: 'failed',
    scopeHash: 'scope',
    sourcesHash: 'fresh'
  }));
  await previewPolicyConversion('policy', auth);
  expect(m.add).toHaveBeenCalledOnce();
  await previewPolicyConversion('policy', auth, {
    mode: 'inline'
  });
  expect(m.equivalence).toHaveBeenCalledOnce();
});

it('blocks missing prerequisites and unconverted parents without applying a proposal', async () => {
  m.prerequisites.mockReturnValue(['missing']);
  expect(await buildPolicyConversionPreview('policy', {
    userId: 'u',
    auth
  })).toMatchObject({
    blockedBy: 'prerequisite_missing',
    missingPrerequisites: ['missing']
  });
  m.prerequisites.mockReturnValue([]);
  m.sources.mockResolvedValue({
    ...sources,
    parentUnconverted: true
  });
  expect(await buildPolicyConversionPreview('policy', {
    userId: 'u',
    auth
  })).toMatchObject({
    blockedBy: 'parent_unconverted'
  });
  expect(m.equivalence).not.toHaveBeenCalled();
});

it('merges enabled response actions before equivalence while keeping disabled responses unconverted', async () => {
  m.sources.mockResolvedValue({
    ...sources,
    standaloneAutomations: [{
        id: 'a',
        name: 'Active',
        enabled: true,
        actions: [{
            type: 'webhook',
            url: 'https://example.com'
          }],
        trigger: {
          type: 'event',
          eventType: 'alert.triggered',
          filter: {
            configPolicyAlertRuleId: 'r'
          }
        }
      }, {
        id: 'b',
        name: 'Disabled',
        enabled: false,
        actions: [{
            type: 'execute_command',
            command: 'inactive'
          }],
        trigger: {
          type: 'event',
          eventType: 'alert.triggered',
          filter: {
            configPolicyAlertRuleId: 'r'
          }
        }
      }]
  });
  const result = await buildPolicyConversionPreview('policy', {
    userId: 'u',
    auth
  });
  expect(result.items.find(i => i.sourceId === 'b')).toMatchObject({
    outcome: 'unconvertible'
  });
  expect(result.items[0]?.proposed[0]?.responses).toHaveLength(1);
  expect(result.items[0]?.openAlerts).toBe(3);
  expect(m.equivalence.mock.calls[0]?.[0].bySource[0].monitors[0].responses).toHaveLength(1);
});

it('refuses a preview when freshness changes across dry-run rollback', async () => {
  m.freshness.mockResolvedValueOnce('before').mockResolvedValueOnce('after');
  await expect(buildPolicyConversionPreview('policy', {
    userId: 'u',
    auth
  })).rejects.toMatchObject({
    code: 'preview_stale'
  });
});

it('refuses incompatible escalation owners before equivalence staging', async () => {
  m.sources.mockResolvedValue({
    ...sources,
    inlineRules: [{
        ...rule,
        escalationPolicyId: 'foreign'
      }]
  });
  const result = await buildPolicyConversionPreview('policy', {
    userId: 'u',
    auth
  });
  expect(result.items[0]).toMatchObject({
    outcome: 'unconvertible',
    reason: 'unconvertible:escalation_policy_axis',
    proposed: []
  });
  expect(m.equivalence.mock.calls[0]?.[0].bySource).toEqual([]);
});

it('orders response actions by source id regardless of database result order', async () => {
  const responses = [
    {
      id: 'b',
      name: 'Second',
      enabled: true,
      actions: [{
          type: 'execute_command',
          command: 'second'
        }],
      trigger: {
        type: 'event',
        eventType: 'alert.triggered',
        filter: {
          configPolicyAlertRuleId: 'r'
        }
      }
    },
    {
      id: 'a',
      name: 'First',
      enabled: true,
      actions: [{
          type: 'execute_command',
          command: 'first'
        }],
      trigger: {
        type: 'event',
        eventType: 'alert.triggered',
        filter: {
          configPolicyAlertRuleId: 'r'
        }
      }
    },
  ];
  m.sources.mockResolvedValue({
    ...sources,
    standaloneAutomations: responses
  });
  const first = await buildPolicyConversionPreview('policy', {
    userId: 'u',
    auth
  });
  m.sources.mockResolvedValue({
    ...sources,
    standaloneAutomations: [...responses].reverse()
  });
  const second = await buildPolicyConversionPreview('policy', {
    userId: 'u',
    auth
  });
  expect(first.previewHash).toBe(second.previewHash);
  expect(first.items[0]?.proposed[0]?.responses).toEqual([
    {
      type: 'execute_command',
      command: 'first'
    },
    {
      type: 'execute_command',
      command: 'second'
    },
  ]);
  expect(second.items[0]?.proposed[0]?.responses).toEqual(first.items[0]?.proposed[0]?.responses);
});

it('opens the complete preview in a caller-scoped repeatable-read context', async () => {
  await buildPolicyConversionPreview('policy', { userId: 'u', auth });
  expect(m.context).toHaveBeenCalledWith({}, expect.any(Function), { isolationLevel: 'repeatable read' });
  expect(m.context.mock.invocationCallOrder[0]).toBeLessThan(m.authorize.mock.invocationCallOrder[0]!);
});

it('rejects a job fingerprint that changed before its isolated snapshot opened', async () => {
  await expect(buildPolicyConversionPreview('policy', { userId: 'u', auth }, {
    expectedFreshness: 'old-job-fingerprint',
  })).rejects.toMatchObject({ code: 'preview_stale' });
  expect(m.equivalence).not.toHaveBeenCalled();
});
