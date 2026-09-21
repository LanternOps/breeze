import { beforeEach, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../middleware/auth';
import type { PolicySources } from './loadSources';
const m = vi.hoisted(() => ({
  context: vi.fn(async (_context: unknown, fn: () => unknown) => fn()),
  currentContext: vi.fn(() => undefined),
  authorize: vi.fn(),
  freshness: vi.fn(),
  sources: vi.fn(),
  devices: vi.fn(),
  equivalence: vi.fn(),
  apply: vi.fn(),
  lifecycle: vi.fn(() => true),
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
  runOutsideDbContext: m.outside,
  // The conversion routes are self-managed (D30): pre-transaction reads take
  // the caller's own context, and only reuse one when it is already open.
  getCurrentDbAccessContext: m.currentContext
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
  loadPolicySources: m.sources, OPEN_ALERT_STATUSES: ['active', 'acknowledged', 'suppressed']
}));
vi.mock('./legacyBaseline', () => ({
  resolveDeviceIdsForPolicy: m.devices
}));
vi.mock('./equivalence', () => ({
  computeEquivalence: m.equivalence, applyProposalInTx: m.apply
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

vi.mock('./lifecycle', () => ({ isRevertAvailable: m.lifecycle, findLiveTargetDependencies: vi.fn(async () => new Set()) }));
vi.mock('../monitorService', () => ({ createMonitorDefinition: vi.fn(), deleteMonitorDefinition: vi.fn() }));
vi.mock('../../alertCooldown', () => ({ rekeyConfigPolicyCooldowns: vi.fn(), rekeyCooldownsBackToConfigPolicy: vi.fn() }));
import { rekeyConfigPolicyCooldowns, rekeyCooldownsBackToConfigPolicy } from '../../alertCooldown';
import { buildPolicyConversionPreview, previewPolicyConversion, convertPolicy, retireSource, revertConversion, convertPartnerLegacy, partnerPreviewHash, previewPartnerConversion, previewTemplateGroup, convertTemplateGroup, rekeyCommittedCooldowns } from './convert';
import { alertTemplates, alertRules, configPolicyMonitors, monitorConversions, monitorConversionOutputs, organizations, sites, partners } from '../../../db/schema';
vi.mock('../../configurationPolicy', () => ({ createConfigPolicy: vi.fn(), assignPolicy: vi.fn(), addFeatureLink: vi.fn() }));
import { createConfigPolicy, assignPolicy, addFeatureLink } from '../../configurationPolicy';
import { createMonitorDefinition } from '../monitorService';
const auth = {
  scope: 'organization',
  canAccessOrg: (id: string) => id === 'o',
  user: {
    id: 'u'
  }
} as unknown as AuthContext;
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
  m.lifecycle.mockReturnValue(true);
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

it('queues 501 devices with the authorized caller snapshot', async () => {
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
  expect(m.outside).not.toHaveBeenCalled();
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

it('stops retrying a repeatedly failing preview and tells the caller it failed', async () => {
  m.devices.mockResolvedValue(Array(501).fill('d'));
  // A preview that fails deterministically must not poll as `running` for ever:
  // after MAX_PREVIEW_ATTEMPTS the caller is told, instead of seeing progress
  // reset to 0 on every poll with no failure path in the contract at all.
  m.get.mockResolvedValue(JSON.stringify({
    status: 'failed', scopeHash: 'scope', sourcesHash: 'fresh', attempts: 3,
  }));
  expect(await previewPolicyConversion('policy', auth)).toHaveProperty('status', 'failed');
  expect(m.add).not.toHaveBeenCalled();
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

function mutationTx(rows: unknown[][]) {
  const query = () => {
    const result = rows.shift() ?? [];
    const chain: any = { then: (yes: any, no: any) => Promise.resolve(result).then(yes, no) };
    for (const method of ['from', 'where', 'limit', 'for', 'orderBy', 'innerJoin']) chain[method] = () => chain;
    return chain;
  };
  const writes: Array<{ table: unknown; values: any; }> = [];
  const tx: any = {
    select: vi.fn(query), execute: vi.fn(async () => []),
    insert: vi.fn((table) => ({
      values: (values: unknown) => {
        writes.push({ table, values });
        const result = [{ id: 'ledger', ...values as object }];
        const chain: any = { then: (yes: any, no: any) => Promise.resolve(result).then(yes, no), returning: async () => result };
        chain.onConflictDoNothing = () => chain; return chain;
      }
    })),
    update: vi.fn((table) => ({ set: (values: unknown) => { writes.push({ table, values }); return { where: () => ({ returning: async () => [{ id: 'source' }], then: (yes: any, no: any) => Promise.resolve([]).then(yes, no) }) }; } })),
    delete: vi.fn(),
  };
  tx.transaction = async (fn: (executor: unknown) => unknown) => fn(tx);
  return { tx, writes };
}
it('rejects a stale policy confirmation before any write', async () => {
  const { tx } = mutationTx([[{ partnerId: 'p' }], [sources.policy], [], [], [], [], []]);
  m.transaction.mockImplementationOnce(async fn => fn(tx));
  await expect(convertPolicy('policy', 'wrong', auth)).rejects.toMatchObject({ code: 'preview_stale' });
  expect(m.apply).not.toHaveBeenCalled(); expect(tx.insert).not.toHaveBeenCalled();
});
it('refuses an invisible policy source before the ledger index can be reached', async () => {
  m.authorize.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'policy_not_found' }));
  await expect(convertPolicy('foreign', 'hash', auth)).rejects.toMatchObject({ code: 'policy_not_found' });
  expect(m.apply).not.toHaveBeenCalled();
});
it('refuses invisible retirement sources without writing a ledger', async () => {
  const { tx } = mutationTx([[]]); m.transaction.mockImplementationOnce(async fn => fn(tx));
  await expect(retireSource('alert_templates', 'foreign', 'operator', auth)).rejects.toMatchObject({ code: 'source_not_found' });
  expect(tx.insert).not.toHaveBeenCalled(); expect(tx.update).not.toHaveBeenCalled();
});
it('validates the complete retirement reason vocabulary before writes', async () => {
  await expect(retireSource('alert_templates', 'source', 'bogus', auth)).rejects.toMatchObject({ code: 'invalid_reason' });
});
it('records an operator retirement with original source state and no outputs', async () => {
  const template = { id: 'source', orgId: 'o', partnerId: null, retiredAt: null, retiredReason: null, convertedToMonitorId: null };
  const { tx, writes } = mutationTx([[template], [{ partnerId: 'p' }], [template], [], []]);
  m.transaction.mockImplementationOnce(async fn => fn(tx));
  await expect(retireSource('alert_templates', 'source', 'operator', auth)).resolves.toEqual({ conversionId: 'ledger' });
  expect(writes.find(w => w.table === monitorConversions)?.values).toMatchObject({ sourceId: 'source', convertedBy: 'u', sourceState: { source: template } });
  expect(writes.find(w => w.table === alertTemplates)?.values).toMatchObject({ retiredReason: 'operator' });
});
it('revert refuses an invisible source without mutating the visible ledger', async () => {
  const { tx } = mutationTx([[{ id: 'ledger', orgId: 'o', partnerId: null, sourceTable: 'alert_templates', sourceId: 'foreign', sourceState: {}, revertedAt: null }], []]);
  m.transaction.mockImplementationOnce(async fn => fn(tx));
  await expect(revertConversion('ledger', auth)).rejects.toMatchObject({ code: 'source_not_found' });
  expect(tx.insert).not.toHaveBeenCalled(); expect(tx.update).not.toHaveBeenCalled(); expect(tx.delete).not.toHaveBeenCalled();
});
it('revert refuses a retired runtime before mutation', async () => {
  m.lifecycle.mockReturnValue(false);
  const { tx } = mutationTx([[{ id: 'ledger', orgId: 'o', partnerId: null, sourceTable: 'alert_templates', sourceId: 'source', sourceState: {}, revertedAt: null }]]);
  m.transaction.mockImplementationOnce(async fn => fn(tx));
  await expect(revertConversion('ledger', auth)).rejects.toMatchObject({ code: 'conversion_revert_unavailable' });
  expect(tx.insert).not.toHaveBeenCalled(); expect(tx.update).not.toHaveBeenCalled(); expect(tx.delete).not.toHaveBeenCalled();
});
it('partner conversion denies org tokens before enumerating another tenant', async () => {
  await expect(convertPartnerLegacy('foreign-partner', 'hash', auth)).rejects.toMatchObject({ code: 'partner_wide_denied' });
  expect(m.apply).not.toHaveBeenCalled();
});
it('partner confirmation changes when another org adds a source or changes a refusal', () => {
  const first = [{ sourceTable: 'alert_templates' as const, sourceId: 'a', inputHash: 'h1', reason: null }];
  expect(partnerPreviewHash('p', 'scope', first)).not.toBe(partnerPreviewHash('p', 'scope', [...first, { sourceTable: 'alert_templates', sourceId: 'b', inputHash: 'h2', reason: 'unconvertible:no_condition' }]));
  expect(partnerPreviewHash('p', 'scope', first)).not.toBe(partnerPreviewHash('p', 'narrower', first));
});
// Merge imports: previewTemplateGroup, convertTemplateGroup from ./convert;
// schema imports: alertRules, alertTemplates, monitorConversions, monitorConversionOutputs,
// configPolicyMonitors, organizations; monitorService:createMonitorDefinition;
// configurationPolicy:createConfigPolicy, assignPolicy, addFeatureLink.
// Add vi.mock('../../configurationPolicy', () => ({createConfigPolicy:vi.fn(), assignPolicy:vi.fn(), addFeatureLink:vi.fn()}));
// The existing equivalence/legacyBaseline mocks need not export signature functions for the
// empty-device cases below. A controller integration test exercises nonempty device behavior.

function templateHarness(members: Array<Record<string, unknown>>, sourceVisible = true) {
  const template = {
    id: 'template', orgId: 'o', partnerId: null, name: 'CPU', conditions: { type: 'metric', metric: 'cpu', operator: 'gt', value: 90 },
    severity: 'high', cooldownMinutes: 5, autoResolve: true, isBuiltIn: false, managedByMonitorId: null, retiredAt: null
  };
  let rows = new Map<unknown, unknown[]>([[alertTemplates, sourceVisible ? [template] : []], [alertRules, members], [organizations, [{ id: 'o', partnerId: 'partner' }]], [sites, [{ id: 'site', orgId: 'o' }]], [organizations, [{ id: 'o', partnerId: 'partner' }]]]);
  const mutations: Array<{ table: unknown; value: any; }> = [];
  const chain = (get: () => unknown[]) => {
    const c: any = { then: (yes: any, no: any) => Promise.resolve(get()).then(yes, no) };
    for (const method of ['where', 'limit', 'for', 'orderBy', 'innerJoin']) c[method] = () => c;
    return c;
  };
  const tx: any = {
    select: () => ({ from: (table: unknown) => chain(() => rows.get(table) ?? []) }),
    execute: vi.fn(),
    insert: (table: unknown) => ({
      values: (value: any) => {
        const created = { id: `row-${mutations.length}`, ...value };
        mutations.push({ table, value }); rows.set(table, [...(rows.get(table) ?? []), created]);
        const c: any = { ...chain(() => [created]), returning: () => chain(() => [created]) };
        c.onConflictDoNothing = () => c;
        return c;
      }
    }),
    update: (table: unknown) => ({
      set: (value: any) => ({
        where: () => {
          mutations.push({ table, value });
          return { ...chain(() => [{ id: 'retired' }]), returning: () => chain(() => [{ id: 'retired' }]) };
        }
      })
    }),
    transaction: async (callback: (inner: unknown) => unknown) => {
      const previous = new Map([...rows].map(([table, values]) => [table, structuredClone(values)]));
      try { return await callback(tx); } catch (error) { rows = previous; throw error; }
    },
  };
  let id = 0;
  vi.mocked(createConfigPolicy).mockImplementation(async () => ({ id: `policy-${++id}` }) as never);
  vi.mocked(assignPolicy).mockResolvedValue({} as never);
  vi.mocked(createMonitorDefinition).mockImplementation(async () => ({ id: `monitor-${++id}`, compiledAlertRuleId: `compiled-${id}` }) as never);
  vi.mocked(addFeatureLink).mockImplementation(async (_policy, _type, _target, settings) => {
    const items = (settings as any).items;
    const linkId = `link-${++id}`;
    rows.set(configPolicyMonitors, items.map((item: any) => ({ id: `attachment-${++id}`, featureLinkId: linkId, ...item })));
    return { id: linkId } as never;
  });
  return { tx, mutations, persisted: () => rows };
}
const templateRule = (id: string, targetType: string, targetId: string, isActive = true) => ({
  id, templateId: 'template', orgId: 'o', partnerId: null,
  name: id, targetType, targetId, isActive, overrideSettings: {}, managedByMonitorId: null, retiredAt: null
});

it('template preview rejects invisible sources before any ledger write', async () => {
  const h = templateHarness([], false);
  await expect(previewTemplateGroup('template', auth, h.tx)).rejects.toMatchObject({ code: 'source_not_found' });
  expect(h.mutations).toEqual([]);
});

it('template group preserves two targets and disabled member in exactly one live ledger', async () => {
  const h = templateHarness([templateRule('r1', 'org', 'o'), templateRule('r2', 'site', 'site', false)]);
  const preview = await previewTemplateGroup('template', auth, h.tx);
  expect(preview.blockedBy).toBeNull();
  expect(h.persisted().get(monitorConversions) ?? []).toEqual([]); // preview rolled back
  const result = await convertTemplateGroup('template', preview.previewHash, auth, h.tx);
  expect(result.convertedRuleIds).toEqual(['r1', 'r2']);
  expect(result.outputs.map((o) => o.sourceRuleId)).toEqual(['r1', 'r2']);
  expect(h.persisted().get(monitorConversions)).toHaveLength(1);
  expect(h.persisted().get(monitorConversionOutputs)).toHaveLength(2);
  expect(assignPolicy).toHaveBeenCalledWith(expect.any(String), 'organization', 'o', 0, 'u', undefined, undefined, h.tx);
  expect(assignPolicy).toHaveBeenCalledWith(expect.any(String), 'site', 'site', 0, 'u', undefined, undefined, h.tx);
  expect(createMonitorDefinition).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }), expect.anything(), {}, h.tx);
  expect(h.mutations.filter((m) => m.table === alertRules).every((m) => !('isActive' in m.value) && !('overrideSettings' in m.value))).toBe(true);
});

it('one unconvertible template member refuses the whole group without writes', async () => {
  const invalid = { ...templateRule('bad', 'org', 'o'), overrideSettings: { conditions: { type: 'custom' } } };
  const h = templateHarness([templateRule('r1', 'org', 'o'), invalid]);
  const preview = await previewTemplateGroup('template', auth, h.tx);
  expect(preview.blockedBy).toMatch(/^unconvertible:/);
  await expect(convertTemplateGroup('template', preview.previewHash, auth, h.tx)).rejects.toMatchObject({ code: 'blocked' });
  expect(h.mutations).toEqual([]);
});
// Append imports (or merge with current imports) before the tests below.
import { automations as revertAutomations, alerts as revertAlerts, configPolicyFeatureLinks as revertLinks, monitorDefinitions as revertDefinitions } from '../../../db/schema';
import { deleteMonitorDefinition as deleteRevertedMonitor } from '../monitorService';

function revertHarness(withOutput = true) {
  const originalTemplate = { id: 'source', orgId: 'o', partnerId: null, retiredAt: null, retiredReason: null, convertedToMonitorId: null };
  const originalRule = {
    id: 'original-rule', templateId: 'source', orgId: 'o', partnerId: null,
    isActive: false, overrideSettings: { severity: 'low' }, retiredAt: null, retiredReason: null, convertedToMonitorId: null
  };
  const ledger = {
    id: 'ledger', orgId: 'o', partnerId: null, sourceTable: 'alert_templates', sourceId: 'source',
    policyId: null, revertedAt: null, sourceState: withOutput ? { template: originalTemplate, rules: [originalRule] } : { source: originalTemplate }
  };
  const moved = {
    id: 'open-alert', ruleId: 'original-rule', configPolicyId: null, monitorId: null,
    context: { preserved: true, convertedFrom: { older: 'provenance' } }
  };
  const output = {
    id: 'output', conversionId: 'ledger', orgId: 'o', partnerId: null, sourceRuleId: 'original-rule',
    role: 'primary', monitorId: 'monitor', policyId: 'policy', attachmentId: 'own-attachment', reusedMonitor: false,
    movedAlertIds: ['open-alert'], movedAlertRefs: [moved]
  };
  const rows = new Map<unknown, unknown[]>([
    [monitorConversions, [ledger]], [alertTemplates, [{ ...originalTemplate, retiredAt: new Date(), retiredReason: 'converted' }]],
    [alertRules, [{ ...originalRule, retiredAt: new Date(), retiredReason: 'converted', convertedToMonitorId: 'monitor' }]],
    [monitorConversionOutputs, withOutput ? [output] : []], [organizations, [{ id: 'o', partnerId: 'p' }]],
    [revertDefinitions, [{ id: 'monitor', orgId: 'o', partnerId: null }]],
    [configPolicyMonitors, withOutput ? [{ id: 'own-attachment', featureLinkId: 'link', monitorId: 'monitor', enabled: true, overrides: null, sortOrder: 0 }] : []],
    [revertLinks, [{ id: 'link', policyId: 'policy', featureType: 'monitors', inlineSettings: { inheritance: 'cumulative', items: [] } }]],
  ]);
  const events: Array<{ kind: string; table?: unknown; value?: any; predicate?: unknown; }> = [];
  const chain = (get: () => unknown[]) => {
    let joined = false;
    const c: any = { then: (yes: any, no: any) => Promise.resolve(joined ? [] : get()).then(yes, no) };
    for (const method of ['where', 'limit', 'for', 'orderBy']) c[method] = () => c;
    c.innerJoin = () => { joined = true; return c; };
    c.returning = () => c;
    return c;
  };
  const tx: any = {
    select: vi.fn((selection?: unknown) => ({ from: (table: unknown) => chain(() => selection && table === monitorConversions ? [] : rows.get(table) ?? []) })),
    execute: vi.fn(async () => []),
    rollback: () => { throw new Error('rollback'); },
    update: vi.fn((table: unknown) => ({
      set: (value: any) => ({
        where: (predicate: unknown) => {
          events.push({ kind: 'update', table, value, predicate }); return chain(() => [{ id: 'source' }]);
        }
      })
    })),
    delete: vi.fn((table: unknown) => ({
      where: (predicate: unknown) => {
        events.push({ kind: 'delete', table, predicate }); rows.set(table, []); return chain(() => []);
      }
    })),
    insert: vi.fn(() => { throw new Error('Revert cannot create a new conversion'); }),
  };
  tx.transaction = async (fn: (inner: unknown) => unknown) => fn(tx);
  vi.mocked(deleteRevertedMonitor).mockImplementation(async () => { events.push({ kind: 'delete-monitor' }); });
  m.transaction.mockImplementationOnce(async fn => fn(tx));
  return { tx, events, moved, originalRule, originalTemplate, rows };
}

it('a post-commit cooldown rekey failure is logged, not thrown at the caller', async () => {
  // The rekey runs AFTER the transaction commits, so throwing here would report
  // a failure for a conversion that has already landed — and the retry would
  // then answer `already_converted`.
  vi.mocked(rekeyConfigPolicyCooldowns).mockRejectedValueOnce(new Error('redis down'));
  vi.mocked(rekeyCooldownsBackToConfigPolicy).mockResolvedValueOnce(2);
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(rekeyCommittedCooldowns(
    [{ sourceId: 's1', compiledRuleId: 'r1' }, { sourceId: 's2', compiledRuleId: null }],
    'to_monitor',
  )).resolves.toBeUndefined();
  // Control: the rejection is only meaningful because the rekey really ran,
  // and the null-compiledRule pair is skipped rather than rekeyed.
  expect(rekeyConfigPolicyCooldowns).toHaveBeenCalledTimes(1);
  expect(rekeyConfigPolicyCooldowns).toHaveBeenCalledWith('s1', 'r1');
  expect(err).toHaveBeenCalled();
  await expect(rekeyCommittedCooldowns([{ sourceId: 's3', compiledRuleId: 'r3' }], 'back_to_config_policy')).resolves.toBeUndefined();
  expect(rekeyCooldownsBackToConfigPolicy).toHaveBeenCalledWith('r3', 's3');
  err.mockRestore();
});

it('revert restores exact moved references before detaching its output or deleting compiled history', async () => {
  const h = revertHarness();
  await revertConversion('ledger', auth);
  const restored = h.events.findIndex(e => e.table === revertAlerts && e.value?.ruleId === 'original-rule' && e.value?.context === h.moved.context);
  expect(restored).toBeGreaterThanOrEqual(0);
  expect(h.events[restored]?.value).toEqual({ ruleId: h.moved.ruleId, configPolicyId: null, monitorId: null, context: h.moved.context });
  const detached = h.events.findIndex(e => e.kind === 'delete' && e.table === configPolicyMonitors);
  expect(detached).toBeGreaterThan(restored);
  expect(h.events.filter(e => e.kind === 'delete' && e.table === configPolicyMonitors)).toHaveLength(1);
  expect(h.events.find(e => e.table === alertRules)?.value).toMatchObject({ isActive: false, overrideSettings: { severity: 'low' }, retiredAt: null, retiredReason: null });
  expect(h.events.at(-1)).toMatchObject({ kind: 'update', table: monitorConversions, value: { revertedAt: expect.any(Date) } });
  expect(deleteRevertedMonitor).toHaveBeenCalledWith('monitor', auth, h.tx);
  expect(h.events.findIndex(e => e.kind === 'delete-monitor')).toBeGreaterThan(restored);
  expect(h.tx.insert).not.toHaveBeenCalled();
});

it('revert rehomes post-conversion alerts without changing terminal status, resolution or timestamps', async () => {
  const h = revertHarness();
  await revertConversion('ledger', auth);
  const rehome = h.events.find(e => e.table === revertAlerts && e.value?.ruleId === 'original-rule' && e.value?.context !== h.moved.context);
  expect(rehome?.value).toMatchObject({ ruleId: 'original-rule', configPolicyId: null, monitorId: null, context: expect.anything() });
  expect(Object.keys(rehome!.value).sort()).toEqual(['configPolicyId', 'context', 'monitorId', 'ruleId']);
  // SQL context merge preserves existing keys; no literal replacement object.
  expect(rehome!.value.context).toHaveProperty('queryChunks');
  expect(h.events.filter(e => e.kind === 'delete' && e.table === revertAlerts)).toEqual([]);
});

it('a retirement ledger with no outputs restores the source and marks itself reverted', async () => {
  const h = revertHarness(false);
  await revertConversion('ledger', auth);
  expect(h.events.find(e => e.table === alertTemplates)?.value).toMatchObject({ retiredAt: null, retiredReason: null, convertedToMonitorId: null });
  expect(h.events.at(-1)).toMatchObject({ kind: 'update', table: monitorConversions, value: { revertedAt: expect.any(Date) } });
  expect(h.tx.delete).not.toHaveBeenCalled();
  expect(deleteRevertedMonitor).not.toHaveBeenCalled();
});
it('template group preserves effective autoResolve overrides', async () => {
  const h = templateHarness([{ ...templateRule('r1', 'org', 'o'), overrideSettings: { autoResolve: false } }]);
  const preview = await previewTemplateGroup('template', auth, h.tx);
  expect(preview.blockedBy).toBeNull();
  expect(preview.plans[0]!.mapped).toMatchObject({ ok: true, proposed: [expect.objectContaining({ autoResolve: false })] });
  await convertTemplateGroup('template', preview.previewHash, auth, h.tx);
  expect(createMonitorDefinition).toHaveBeenCalledWith(expect.objectContaining({ autoResolve: false }), expect.anything(), {}, h.tx);
});

it('template group refuses custom autoResolve conditions before staging', async () => {
  const h = templateHarness([{ ...templateRule('r1', 'org', 'o'), overrideSettings: { autoResolveConditions: { type: 'custom' } } }]);
  const preview = await previewTemplateGroup('template', auth, h.tx);
  expect(preview.blockedBy).toBe('unconvertible:auto_resolve_conditions');
  expect(h.mutations).toEqual([]);
});

it('refuses a template member target outside the source owner before ledger writes', async () => {
  const h = templateHarness([templateRule('cross-org', 'org', 'foreign')]);
  const preview = await previewTemplateGroup('template', auth, h.tx);
  expect(preview.blockedBy).toBe('unconvertible:target_or_owner');
  expect(h.mutations).toEqual([]);
});

vi.mock('../monitorCompiler', () => ({ compileMonitorInTx: vi.fn(async () => ({})) }));
import { compileMonitorInTx } from '../monitorCompiler';
it('removes only the reverted response contribution from a retained monitor and recompiles', async () => {
  const h = revertHarness();
  const added = { type: 'execute_command', command: 'response' };
  const retained = { type: 'execute_command', command: 'retained' };
  const ledger = h.rows.get(monitorConversions)![0] as any;
  ledger.sourceTable = 'automations';
  const original = { id: 'source', orgId: 'o', partnerId: null, enabled: true, retiredAt: null, retiredReason: null, convertedToMonitorId: null };
  ledger.sourceState = { source: original, addedActions: [added], targetConversionId: 'already-reverted-target' };
  h.rows.set(revertAutomations, [{ ...original, retiredAt: new Date() }]);
  const output = h.rows.get(monitorConversionOutputs)![0] as any;
  output.role = 'response'; output.sourceRuleId = null; output.attachmentId = null; output.reusedMonitor = true; output.movedAlertRefs = [];
  h.rows.set(revertDefinitions, [{ id: 'monitor', orgId: 'o', partnerId: null, responses: [retained, added] }]);
  await revertConversion('ledger', auth);
  expect(h.events.find(e => e.table === revertDefinitions)?.value).toMatchObject({ responses: [retained] });
  expect(compileMonitorInTx).toHaveBeenCalled();
  expect(deleteRevertedMonitor).not.toHaveBeenCalled();
});

it('policy conversion rejects an org token for a partner-owned source', async () => {
  m.authorize.mockResolvedValue({ ...sources.policy, orgId: null, partnerId: 'p' });
  await expect(convertPolicy('policy', 'hash', auth)).rejects.toMatchObject({ code: 'partner_wide_denied' });
  expect(m.apply).not.toHaveBeenCalled();
});
it('policy conversion refuses fresh equivalence deltas before committing', async () => {
  m.equivalence.mockResolvedValue({ devicesChecked: 1, deltas: [{ deviceId: 'd', detail: 'changes delivery' }] });
  const preview = await buildPolicyConversionPreview('policy', { userId: 'u', auth });
  const { tx } = mutationTx([[{ partnerId: 'p' }], [sources.policy], [], [], []]);
  m.transaction.mockImplementationOnce(async fn => fn(tx));
  await expect(convertPolicy('policy', preview.previewHash, auth)).rejects.toMatchObject({ code: 'equivalence_delta' });
  expect(m.apply).not.toHaveBeenCalled();
});
it('policy conversion commits the confirmed proposal under serializable caller scope', async () => {
  const preview = await buildPolicyConversionPreview('policy', { userId: 'u', auth });
  const { tx } = mutationTx([[{ partnerId: 'p' }], [sources.policy], [], [], [], []]);
  m.transaction.mockImplementationOnce(async fn => fn(tx));
  m.apply.mockResolvedValue({ conversionIds: ['ledger'], retired: 1, monitorsCreated: 1 });
  await expect(convertPolicy('policy', preview.previewHash, auth)).resolves.toEqual({ conversionIds: ['ledger'], retired: 1, monitorsCreated: 1 });
  expect(m.context).toHaveBeenLastCalledWith({}, expect.any(Function), { isolationLevel: 'serializable' });
  expect(m.apply).toHaveBeenCalledWith(tx, expect.objectContaining({ previewHash: preview.previewHash, bySource: [expect.objectContaining({ sourceId: 'r' })] }), auth);
});
it('partner conversion refuses an invisible partner before source or ledger writes', async () => {
  const { tx } = mutationTx([[]]); m.transaction.mockImplementationOnce(async fn => fn(tx));
  await expect(convertPartnerLegacy('p', 'hash', { ...auth, scope: 'partner', partnerId: 'p', partnerOrgAccess: 'all' })).rejects.toMatchObject({ code: 'source_not_found' });
  expect(tx.insert).not.toHaveBeenCalled(); expect(tx.update).not.toHaveBeenCalled(); expect(m.apply).not.toHaveBeenCalled();
});
it('maps three rules and a threshold watch without hiding refusals or open-alert counts', async () => {
  m.sources.mockResolvedValue({
    ...sources, inlineRules: [rule, { ...rule, id: 'second' }, { ...rule, id: 'unsupported', conditions: [{ type: 'processCount', processName: 'legacy', operator: 'gt', value: 1 }] }],
    watches: [{ id: 'watch', name: 'Worker', watchType: 'process', enabled: true, processName: 'worker', alertOnStop: true, consecutiveFailures: 3, cpuThresholdPercent: 80, memoryThresholdMb: 256, severity: 'high' }]
  });
  const preview = await buildPolicyConversionPreview('policy', { userId: 'u', auth });
  expect(preview.items.map(i => i.outcome)).toEqual(['convertible', 'convertible', 'unconvertible', 'convertible']);
  expect(preview.items[3]?.proposed).toHaveLength(3);
  expect(preview.inheritanceMode).toBe('replace'); expect(preview.items[0]?.openAlerts).toBe(3);
});

it('partner preview rolls back its staged group and confirmation commits one atomic group', async () => {
  const h = templateHarness([templateRule('r1', 'org', 'o'), templateRule('r2', 'site', 'site', false)]);
  h.persisted().set(partners, [{ id: 'p' }]);
  const partnerAuth = { ...auth, scope: 'partner' as const, partnerId: 'p', partnerOrgAccess: 'all' as const };
  m.transaction.mockImplementationOnce(async fn => h.tx.transaction(fn));
  const preview = await previewPartnerConversion('p', partnerAuth);
  expect(preview).toMatchObject({ rows: 1, convertible: 1, unconvertible: [] });
  expect(h.persisted().get(monitorConversions) ?? []).toEqual([]);
  m.transaction.mockImplementationOnce(async fn => h.tx.transaction(fn));
  expect(await convertPartnerLegacy('p', preview.previewHash, partnerAuth)).toEqual({ policies: 0, converted: 1, unconvertible: 0 });
  expect(h.persisted().get(monitorConversions)).toHaveLength(1);
  expect(h.persisted().get(monitorConversionOutputs)).toHaveLength(2);
});
it('a stale partner confirmation leaves the entire staged plan rolled back', async () => {
  const h = templateHarness([templateRule('r1', 'org', 'o')]); h.persisted().set(partners, [{ id: 'p' }]);
  m.transaction.mockImplementationOnce(async fn => h.tx.transaction(fn));
  await expect(convertPartnerLegacy('p', 'stale', { ...auth, scope: 'partner', partnerId: 'p', partnerOrgAccess: 'all' })).rejects.toMatchObject({ code: 'preview_stale' });
  expect(h.persisted().get(monitorConversions) ?? []).toEqual([]);
  expect(h.persisted().get(monitorConversionOutputs) ?? []).toEqual([]);
});

it('rechecks retirement after a serialization race and reports already_converted without a duplicate ledger',async()=>{
  const retired={id:'source',orgId:'o',partnerId:null,retiredAt:new Date()};
  const {tx}=mutationTx([[retired],[{partnerId:'p'}],[retired]]);
  m.context.mockRejectedValueOnce(Object.assign(new Error('serialization race'),{code:'40001'}));
  m.transaction.mockImplementationOnce(async fn=>fn(tx));
  await expect(retireSource('alert_templates','source','operator',auth)).rejects.toMatchObject({code:'already_converted'});
  expect(tx.insert).not.toHaveBeenCalled();
});
it('a repeated policy confirmation checks visible completed sources before another ledger write',async()=>{
  const preview=await buildPolicyConversionPreview('policy',{userId:'u',auth});
  const completed={id:'ledger',sourceTable:'config_policy_alert_rules',sourceId:'r',previewHash:preview.previewHash};
  const {tx}=mutationTx([[{partnerId:'p'}],[sources.policy],[],[],[],[completed],[{...rule,featureLinkId:'link'}],[{configPolicyId:'policy'}],[sources.policy]]);
  m.transaction.mockImplementationOnce(async fn=>fn(tx));
  await expect(convertPolicy('policy',preview.previewHash,auth)).rejects.toMatchObject({code:'already_converted'});
  expect(m.apply).not.toHaveBeenCalled();expect(tx.insert).not.toHaveBeenCalled();
});
