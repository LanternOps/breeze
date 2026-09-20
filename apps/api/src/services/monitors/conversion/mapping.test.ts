import { describe, expect, it } from 'vitest';
import type { ConversionPreviewItem, ProposedMonitor } from './types';
import { fingerprintAction, mapInlineRule, mapWatch, mapStandaloneRule, mapAutomationResponses, mergeResponseProposals, monitorSignature, previewHash, UNCONVERTIBLE } from './mapping';

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'r1', featureLinkId: 'l1', name: 'High CPU', severity: 'high', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }],
  cooldownMinutes: 10, autoResolve: true, autoResolveConditions: null, titleTemplate: 't', messageTemplate: 'm', sortOrder: 0,
  rationale: 'because', escalationPolicyId: null, notificationChannelIds: null, retiredAt: null, retiredReason: null, convertedToMonitorId: null,
  createdAt: new Date(), updatedAt: new Date(), ...over,
});
const watch = (over: Record<string, unknown> = {}) => ({
  id: 'w1', settingsId: 's1', watchType: 'service', name: 'Spooler', displayName: null, enabled: true, alertOnStop: true,
  alertAfterConsecutiveFailures: 3, alertSeverity: 'critical', cpuThresholdPercent: null, memoryThresholdMb: null, thresholdDurationSeconds: 300,
  autoRestart: false, maxRestartAttempts: 3, restartCooldownSeconds: 300, rationale: null, sortOrder: 0,
  retiredAt: null, retiredReason: null, convertedToMonitorId: null, createdAt: new Date(), updatedAt: new Date(), ...over,
});

describe('mapInlineRule', () => {
  it('single metric condition → cpu monitor with delivery inherit and description from rationale', () => {
    const r = mapInlineRule(rule() as never);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposed).toHaveLength(1);
    expect(r.proposed[0]).toMatchObject({ role: 'primary', kind: 'cpu', condition: { operator: 'gt', value: 80 }, severity: 'high', cooldownMinutes: 10, autoResolve: true, deliveryMode: 'inherit', deliveryChannelIds: [], escalationPolicyId: null, description: 'because', responses: [] });
    expect(r.notes.join(' ')).toMatch(/kind's templates/);
  });
  it('channels non-empty → deliveryMode channels; escalation carried', () => {
    const r = mapInlineRule(rule({ notificationChannelIds: ['c1'], escalationPolicyId: 'e1' }) as never);
    expect(r.ok && r.proposed[0]).toMatchObject({ deliveryMode: 'channels', deliveryChannelIds: ['c1'], escalationPolicyId: 'e1' });
  });
  it('2..10 conditions → composite match=all with children in order', () => {
    const r = mapInlineRule(rule({ conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }, { type: 'offline', durationMinutes: 5 }] }) as never);
    expect(r.ok && r.proposed[0]).toMatchObject({ kind: 'composite', condition: { match: 'all', children: [{ kind: 'cpu', condition: { operator: 'gt', value: 80 } }, { kind: 'offline', condition: { durationMinutes: 5 } }] } });
  });
  it('flat or-group → composite match=any; nested group → nested_group', () => {
    const flat = mapInlineRule(rule({ conditions: { logic: 'or', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }, { type: 'metric', metric: 'ram', operator: 'gt', value: 90 }] } }) as never);
    expect(flat.ok && flat.proposed[0]?.condition).toMatchObject({ match: 'any' });
    const nested = mapInlineRule(rule({ conditions: { logic: 'and', conditions: [{ logic: 'or', conditions: [] }, { type: 'offline' }] } }) as never);
    expect(nested).toMatchObject({ ok: false, reason: `unconvertible:${UNCONVERTIBLE.nestedGroup}` });
  });
  it('processCount → metric_without_kind; custom → custom_condition; autoResolveConditions → auto_resolve_conditions; 11 conditions → too_many_conditions', () => {
    expect(mapInlineRule(rule({ conditions: [{ type: 'metric', metric: 'processCount', operator: 'gt', value: 500 }] }) as never)).toMatchObject({ ok: false, reason: 'unconvertible:metric_without_kind' });
    expect(mapInlineRule(rule({ conditions: [{ type: 'custom', script: 'x' }] }) as never)).toMatchObject({ ok: false, reason: 'unconvertible:custom_condition' });
    expect(mapInlineRule(rule({ autoResolveConditions: [{ type: 'metric', metric: 'cpu', operator: 'lt', value: 50 }] }) as never)).toMatchObject({ ok: false, reason: 'unconvertible:auto_resolve_conditions' });
    expect(mapInlineRule(rule({ conditions: Array.from({ length: 11 }, () => ({ type: 'offline', durationMinutes: 5 })) }) as never)).toMatchObject({ ok: false, reason: 'unconvertible:too_many_conditions' });
  });
});

describe('mapWatch', () => {
  it('service watch → service monitor with consecutiveFailures, kind-default severity, inherit delivery, and the never-alerted note', () => {
    const r = mapWatch(watch() as never);
    expect(r.ok && r.proposed).toEqual([expect.objectContaining({ role: 'primary', kind: 'service', name: 'Spooler', condition: { serviceName: 'Spooler', consecutiveFailures: 3 }, severity: 'high', deliveryMode: 'inherit', responses: [] })]);
    expect(r.notes.join(' ')).toMatch(/never raised an inbox alert/);
  });
  it('autoRestart → restart_service response with empty command and the row\'s knobs', () => {
    const r = mapWatch(watch({ autoRestart: true, maxRestartAttempts: 5, restartCooldownSeconds: 900 }) as never);
    expect(r.ok && r.proposed[0]?.responses).toEqual([{ type: 'execute_command', kind: 'restart_service', command: '', maxAttempts: 5, cooldownSeconds: 900, whenOffline: 'queue' }]);
  });
  it('process watch with both thresholds → three monitors (primary + cpu + memory), durationMinutes rounded up', () => {
    const r = mapWatch(watch({ watchType: 'process', name: 'sqlservr.exe', cpuThresholdPercent: 80, memoryThresholdMb: 4096, thresholdDurationSeconds: 90 }) as never);
    expect(r.ok && r.proposed.map((p) => p.role)).toEqual(['primary', 'resource_cpu', 'resource_memory']);
    expect(r.ok && r.proposed[1]).toMatchObject({ kind: 'process_resource', name: 'sqlservr.exe — CPU', condition: { resource: 'cpu', processName: 'sqlservr.exe', operator: 'gt', value: 80, durationMinutes: 2 } });
    expect(r.ok && r.proposed[2]).toMatchObject({ condition: { resource: 'memory', value: 4096, durationMinutes: 2 } });
  });
});

it('keeps every disabled auto-restart watch output disabled', () => {
  const result = mapWatch(watch({ enabled: false, autoRestart: true, cpuThresholdPercent: 80 }) as never);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.proposed.every((p) => p.enabled === false)).toBe(true);
  expect(result.proposed[0]!.responses).toHaveLength(1);
});

describe('fingerprint / signature / previewHash', () => {
  it('fingerprintAction is key-order independent', () => {
    expect(fingerprintAction({ type: 'run_script', scriptId: 'a', whenOffline: 'queue' })).toBe(fingerprintAction({ whenOffline: 'queue', scriptId: 'a', type: 'run_script' }));
  });
  it('monitorSignature ignores name/description and changes on any behavioural field', () => {
    const base = { enabled: true, kind: 'cpu', condition: { operator: 'gt', value: 80 }, severity: 'high', cooldownMinutes: 5, autoResolve: false, deliveryMode: 'inherit', deliveryChannelIds: [], escalationPolicyId: null, responses: [] } satisfies Omit<ProposedMonitor, 'role' | 'name'>;
    expect(monitorSignature({ ...base })).toBe(monitorSignature({ ...base }));
    expect(monitorSignature({ ...base, severity: 'low' })).not.toBe(monitorSignature(base));
  });
  it('hashes action payload and order before conversion, and refuses overflow', () => {
    const r = mapInlineRule(rule() as never); if (!r.ok) throw new Error('Invalid fixture');
    const items: ConversionPreviewItem[] = [
      { sourceTable: 'config_policy_alert_rules', sourceId: 'rule', name: 'CPU', outcome: 'convertible', proposed: r.proposed, notes: [], openAlerts: 0 },
      { sourceTable: 'automations', sourceId: 'auto', name: 'Respond', outcome: 'convertible', proposed: [], notes: [], openAlerts: 0,
        responseTargetSourceId: 'rule', responseActions: [{ type: 'execute_command', command: 'first' }, { type: 'execute_command', command: 'second' }] },
    ];
    const merged = mergeResponseProposals(items);
    expect(merged[0]!.proposed[0]!.responses).toEqual(items[1]!.responseActions);
    const hash = (i: ConversionPreviewItem[]) => previewHash({ policyId: 'policy', items: i, inheritanceMode: 'replace' });
    const changed = structuredClone(items); changed[1]!.responseActions!.reverse();
    expect(hash(merged)).not.toBe(hash(mergeResponseProposals(changed)));
    changed[1]!.responseActions = Array.from({ length: 11 }, (_, i) => ({ type: 'execute_command', command: `echo ${i}` }));
    expect(mergeResponseProposals(changed).map((i) => i.reason)).toEqual(['unconvertible:too_many_responses', 'unconvertible:too_many_responses']);
  });
  it('previewHash is stable for the same items and differs on inheritance mode', () => {
    const items = [{ sourceTable: 'config_policy_alert_rules', sourceId: 'r1', name: 'x', outcome: 'convertible', proposed: [], notes: [], openAlerts: 0 }] as never;
    expect(previewHash({ policyId: 'p', items, inheritanceMode: 'replace' })).toBe(previewHash({ policyId: 'p', items, inheritanceMode: 'replace' }));
    expect(previewHash({ policyId: 'p', items, inheritanceMode: 'replace' })).not.toBe(previewHash({ policyId: 'p', items, inheritanceMode: 'cumulative' }));
  });
});

const template = (over: Record<string, unknown> = {}) => ({
  conditions: rule().conditions, severity: 'medium', cooldownMinutes: 15,
  autoResolve: true, description: 'Template description', ...over,
});
const standalone = (over: Record<string, unknown> = {}) => ({
  name: 'Standalone', isActive: false, overrideSettings: null, ...over,
});
const responseItems = (actions: unknown[]): ConversionPreviewItem[] => {
  const mapped = mapInlineRule(rule() as never);
  if (!mapped.ok) throw new Error('Invalid fixture');
  return [
    { sourceTable: 'config_policy_alert_rules', sourceId: 'r1', name: 'CPU', outcome: 'convertible', proposed: mapped.proposed, notes: [], openAlerts: 0 },
    { sourceTable: 'automations', sourceId: 'a1', name: 'Response', outcome: 'convertible', proposed: [], notes: [], openAlerts: 0, responseTargetSourceId: 'r1', responseActions: actions },
  ];
};

describe('mapping boundaries', () => {
  it.each([
    [null, 'no_condition'], [[], 'no_condition'], [[null], 'no_condition'],
    [[{ type: 'metric', metric: 'unknown' }], 'metric_without_kind'],
    [[{ type: 'offline', durationMinutes: 5 }, { type: 'custom' }], 'custom_condition'],
    [[{ type: 'offline', durationMinutes: 5 }, { type: 'service_stopped', serviceName: 'Spooler' }], 'child_kind_not_composable'],
  ])('refuses unsupported conditions %j with %s', (conditions, code) => {
    expect(mapInlineRule(rule({ conditions }) as never)).toMatchObject({ ok: false, reason: `unconvertible:${code}` });
  });
  it('accepts ten conditions and a single stored root, with empty channels inherited', () => {
    for (const conditions of [Array.from({ length: 10 }, () => ({ type: 'offline', durationMinutes: 5 })), { type: 'offline', durationMinutes: 5 }]) {
      const mapped = mapInlineRule(rule({ conditions, notificationChannelIds: [], autoResolveConditions: [] }) as never);
      expect(mapped.ok && mapped.proposed[0]).toMatchObject({ enabled: true, deliveryMode: 'inherit' });
    }
  });
  it('copies disabled state to all watch outputs, keeps zero thresholds and omits zero duration', () => {
    const mapped = mapWatch(watch({ enabled: false, cpuThresholdPercent: 0, memoryThresholdMb: 0, thresholdDurationSeconds: 0, alertOnStop: false }) as never);
    if (!mapped.ok) throw new Error('Invalid fixture');
    expect(mapped.proposed.every((p) => !p.enabled)).toBe(true);
    expect(mapped.proposed.slice(1).map((p) => p.condition)).toEqual([
      { resource: 'cpu', processName: 'Spooler', operator: 'gt', value: 0 },
      { resource: 'memory', processName: 'Spooler', operator: 'gt', value: 0 },
    ]);
    expect(mapped.proposed.slice(1).every((p) => p.severity === 'medium' && p.responses.length === 0)).toBe(true);
    expect(mapped.notes.join(' ')).toMatch(/alertOnStop=false.*ignored/);
  });
  it('standalone overrides win; template defaults and enabled state survive', () => {
    const mapped = mapStandaloneRule(standalone({ overrideSettings: { conditions: { type: 'offline', durationMinutes: 7 }, severity: 'low', cooldownMinutes: 2, notificationChannelIds: ['c1'], escalationPolicyId: 'e1' } }) as never, template() as never);
    expect(mapped.ok && mapped.proposed[0]).toMatchObject({ kind: 'offline', enabled: false, name: 'Standalone', severity: 'low', cooldownMinutes: 2, autoResolve: true, description: 'Template description', deliveryMode: 'channels', deliveryChannelIds: ['c1'], escalationPolicyId: 'e1' });
    const defaults = mapStandaloneRule(standalone() as never, template() as never);
    expect(defaults.ok && defaults.proposed[0]).toMatchObject({ kind: 'cpu', severity: 'medium', cooldownMinutes: 15, deliveryMode: 'inherit', escalationPolicyId: null });
    expect(mapStandaloneRule(standalone() as never, template({ conditions: { triggers: [], thresholdDefaults: {} } }) as never)).toMatchObject({ ok: false, reason: 'unconvertible:no_condition' });
  });
  it('preserves normalized automation actions verbatim and handles missing actions', () => {
    const actions = [{ type: 'execute_command', kind: 'restart_service', command: '', maxAttempts: 5, cooldownSeconds: 900, whenOffline: 'queue' }];
    expect(mapAutomationResponses({ name: 'Restart', actions } as never).actions).toEqual(actions);
    expect(mapAutomationResponses({ name: 'Empty', actions: null } as never).actions).toEqual([]);
  });
});

describe('response merging and behavioral hashes', () => {
  it('deduplicates against existing and appended responses in source order without mutating inputs', () => {
    const items = responseItems([{ type: 'execute_command', command: 'one', id: 'new' }, { type: 'execute_command', command: 'two' }, { command: 'two', type: 'execute_command' }]);
    items[0]!.proposed[0]!.responses = [{ type: 'execute_command', command: 'one', id: 'old' }];
    const before = structuredClone(items);
    const merged = mergeResponseProposals(items);
    expect(merged[0]!.proposed[0]!.responses).toEqual([items[0]!.proposed[0]!.responses[0], items[1]!.responseActions![1]]);
    expect(items).toEqual(before);
    expect(merged[1]!.notes.join(' ')).toContain('1 actions appended to High CPU; 2 duplicates skipped');
  });
  it('refuses missing or unconvertible response targets and accepts exactly ten actions', () => {
    for (const target of ['missing', 'unconvertible', 'no-primary']) {
      const items = responseItems([]);
      if (target === 'missing') items[1]!.responseTargetSourceId = 'missing';
      if (target === 'unconvertible') items[0]!.outcome = 'unconvertible';
      if (target === 'no-primary') items[0]!.proposed = [];
      expect(mergeResponseProposals(items)[1]).toMatchObject({ outcome: 'unconvertible', reason: 'unconvertible:target_unconvertible' });
    }
    const items = responseItems(Array.from({ length: 10 }, (_, i) => ({ type: 'execute_command', command: String(i) })));
    expect(mergeResponseProposals(items)[0]!.proposed[0]!.responses).toHaveLength(10);
  });
  it('strips only top-level volatile action keys and preserves nested payload and action order', () => {
    expect(fingerprintAction({ type: 'x', id: 'a', createdAt: 'a', updatedAt: 'a' })).toBe(fingerprintAction({ type: 'x' }));
    expect(fingerprintAction({ payload: { id: 'a' } })).not.toBe(fingerprintAction({ payload: { id: 'b' } }));
    const items = responseItems([]);
    const base = items[0]!.proposed[0]!;
    expect(monitorSignature({ ...base, deliveryChannelIds: ['a', 'b'] })).toBe(monitorSignature({ ...base, deliveryChannelIds: ['b', 'a'] }));
    for (const change of [
      { enabled: false }, { kind: 'memory' }, { condition: { operator: 'gt', value: 81 } },
      { severity: 'low' }, { cooldownMinutes: 6 }, { autoResolve: false },
      { deliveryMode: 'none' }, { deliveryChannelIds: ['a'] }, { escalationPolicyId: 'e' },
      { responses: [{ type: 'execute_command', command: 'changed' }] },
    ] satisfies Partial<ProposedMonitor>[]) expect(monitorSignature({ ...base, ...change })).not.toBe(monitorSignature(base));
    expect(monitorSignature({ ...base, name: 'Renamed', description: 'Changed' } as ProposedMonitor)).toBe(monitorSignature(base));
  });
  it('preserves policy workflows and includes their payload in the preview hash', () => {
    const items: ConversionPreviewItem[] = [{ sourceTable: 'config_policy_automations', sourceId: 'w', name: 'Workflow', outcome: 'convertible', proposed: [], notes: [], openAlerts: 0, workflow: { policyId: 'p', sourceId: 'w', name: 'Workflow', enabled: false, actions: [{ type: 'run_script', scriptId: 's' }], onFailure: 'continue' } }];
    expect(mergeResponseProposals(items)).toEqual(items);
    const hash = previewHash({ policyId: 'p', items, inheritanceMode: 'replace' });
    items[0]!.workflow!.enabled = true;
    expect(previewHash({ policyId: 'p', items, inheritanceMode: 'replace' })).not.toBe(hash);
  });
});
