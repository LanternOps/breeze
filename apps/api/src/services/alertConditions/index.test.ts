import { describe, it, expect, vi, beforeEach } from 'vitest';

// utils.ts (transitively imported by the handlers) pulls in the db module at
// import time; stub it so importing the registry doesn't open a connection.
vi.mock('../../db', () => ({ db: {} }));

const { getRecentMetricsMock, getLatestMetricMock } = vi.hoisted(() => ({
  getRecentMetricsMock: vi.fn(),
  getLatestMetricMock: vi.fn(),
}));

// Mock only the db-touching helpers; keep the pure metric-map/compare helpers real.
vi.mock('./utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils')>();
  return { ...actual, getRecentMetrics: getRecentMetricsMock, getLatestMetric: getLatestMetricMock };
});

import './index';
import { conditionPayloadsFrom, evaluateConditions, findRetiredConditionTypes, retiredConditionTypeError } from './index';
import { conditionRegistry } from './registry';
import { offlineHandler } from './handlers/offline';

describe('condition registry wiring (issue #1857)', () => {
  it('resolves the legacy "status" condition type to the offline handler', () => {
    expect(conditionRegistry.get('status')).toBe(offlineHandler);
  });

  it('resolves the canonical "offline" condition type to the offline handler', () => {
    expect(conditionRegistry.get('offline')).toBe(offlineHandler);
  });

  it('returns an "Unknown condition type" result for a genuinely unregistered type', async () => {
    const result = await conditionRegistry.evaluate(
      { type: 'definitely-not-a-real-type' } as never,
      'device-1'
    );
    expect(result.passed).toBe(false);
    expect(result.description).toMatch(/Unknown condition type/);
  });
});

describe('evaluateConditions context.actualValue (issue #1980)', () => {
  beforeEach(() => {
    getRecentMetricsMock.mockReset();
    getLatestMetricMock.mockReset();
  });

  it('reports the window average (not the latest raw sample) for a fired metric rule', async () => {
    // avg(88, 95, 94) = 92.33 > 90 → fires. Latest raw sample is 88 (sub-threshold).
    getRecentMetricsMock.mockResolvedValue([
      { ramPercent: 88 },
      { ramPercent: 95 },
      { ramPercent: 94 },
    ] as never);
    getLatestMetricMock.mockResolvedValue({ ramPercent: 88 } as never);

    const result = await evaluateConditions(
      [{ type: 'metric', metric: 'ram', operator: 'gt', value: 90 }],
      'device-1'
    );

    expect(result.triggered).toBe(true);
    expect(result.context.metric).toBe('ram');
    expect(result.context.actualValue).toBeCloseTo(92.33, 1);
    // Must not be the latest sub-threshold sample.
    expect(result.context.actualValue).not.toBe(88);
  });
});

describe('findRetiredConditionTypes (issue #2948)', () => {
  it('flags the retired `custom` type, which never had an evaluator', () => {
    expect(findRetiredConditionTypes([{ type: 'custom', customCondition: 'x' }]).retired).toEqual(['custom']);
  });

  it('flags a bare root object, the shape the alert-template routes accept', () => {
    // Those routes validate `conditions` as z.record — an OBJECT, never an
    // array — so the un-wrapped shape is the dominant one there.
    expect(findRetiredConditionTypes({ type: 'custom' }).retired).toEqual(['custom']);
  });

  it('descends into the alert-template editor envelope (`conditions.triggers`)', () => {
    // AlertTemplateEditor posts { triggers, thresholdDefaults, notifications,
    // escalationRules, autoRemediation, suppression }. A walk that only
    // recursed on a `conditions` array missed this entirely, making the guard
    // on POST/PATCH /alert-templates dead code for the product's own UI.
    const payload = {
      triggers: [{ type: 'event', eventSource: 'x', pattern: 'y' }, { type: 'custom' }],
      thresholdDefaults: {},
      suppression: {},
    };
    expect(findRetiredConditionTypes(payload).retired).toEqual(['custom']);
  });

  it('does NOT flag live types that have no registry handler', () => {
    // The single most important case in this file. `dns_threat` is a seeded
    // built-in evaluated by the event-bus subscriber in
    // services/dnsThreatAlerts.ts, and `event` is what the alert-template
    // editor writes — neither is in conditionRegistry. A registry-allowlist
    // guard would 400 both, breaking the documented way to narrow a DNS-threat
    // rule (editing override_settings.conditions.categories).
    const live = [
      { type: 'dns_threat', eventType: 'dns.threat.blocked', categories: ['malware'] },
      { type: 'event', eventSource: 'system', pattern: 'disk' },
    ];
    expect(findRetiredConditionTypes(live).retired).toEqual([]);
    for (const condition of live) {
      expect(conditionRegistry.get(condition.type)).toBeUndefined();
    }
  });

  it('accepts every registry-backed type, aliases included', () => {
    const supported = [
      { type: 'metric', metric: 'cpu', operator: 'gt', value: 85 },
      { type: 'threshold', metric: 'cpuPercent', operator: 'gt', value: 85 },
      { type: 'status', duration: 10 },
      { type: 'offline', durationMinutes: 10 },
      { type: 'event_log', category: 'system', level: 'error' },
      { type: 'service_stopped', serviceName: 'spooler' },
      { type: 'cert_expiry', withinDays: 30 },
    ];
    expect(findRetiredConditionTypes(supported).retired).toEqual([]);
  });

  it('walks into nested condition groups', () => {
    const tree = {
      logic: 'or',
      conditions: [
        { type: 'metric', metric: 'cpu', operator: 'gt', value: 85 },
        { logic: 'and', conditions: [{ type: 'custom' }] },
      ],
    };
    expect(findRetiredConditionTypes(tree).retired).toEqual(['custom']);
  });

  it('dedupes repeated retired types', () => {
    expect(findRetiredConditionTypes([{ type: 'custom' }, { type: 'custom' }]).retired).toEqual(['custom']);
  });

  it('ignores non-object and typeless nodes rather than inventing an error', () => {
    expect(findRetiredConditionTypes([null, 'nope', 42, {}, { type: 7 }]).retired).toEqual([]);
  });

  it('reports truncation — never a clean result — on a pathologically deep tree', () => {
    let node: Record<string, unknown> = { type: 'custom' };
    for (let i = 0; i < 5000; i++) node = { logic: 'and', conditions: [node] };
    const scan = findRetiredConditionTypes(node);
    // The walk cannot reach the retired leaf, so `retired` is empty — but
    // `truncated` says the answer is inconclusive, and the caller must reject.
    expect(scan.retired).toEqual([]);
    expect(scan.truncated).toBe(true);
  });

  it('reports truncation on a payload wider than the node budget', () => {
    const wide = Array.from({ length: 20000 }, () => ({ type: 'metric', metric: 'cpu' }));
    expect(findRetiredConditionTypes(wide).truncated).toBe(true);
  });

  it('does not spend node budget on primitives inside arrays', () => {
    // A flat array of strings was the cheapest way to exhaust the budget and
    // blank the guard. Arrays of primitives must cost nothing.
    const padded = { targetIds: Array.from({ length: 20000 }, (_, i) => `device-${i}`), conditions: [{ type: 'custom' }] };
    const scan = findRetiredConditionTypes(padded);
    expect(scan.retired).toEqual(['custom']);
    expect(scan.truncated).toBe(false);
  });

  it('does not charge a nesting level for the array inside a group', () => {
    // A `{logic, conditions[]}` level costs ONE, matching the evaluator's own
    // recursion. Charging the array too halved the usable depth silently.
    let node: Record<string, unknown> = { type: 'custom' };
    for (let i = 0; i < 8; i++) node = { logic: 'and', conditions: [node] };
    expect(findRetiredConditionTypes(node).retired).toEqual(['custom']);
  });
});

describe('conditionPayloadsFrom (issue #2948)', () => {
  it('extracts only the two keys the evaluator reads back', () => {
    expect(conditionPayloadsFrom({
      conditions: [{ type: 'custom' }],
      autoResolveConditions: [{ type: 'metric' }],
      targetIds: ['a', 'b'],
      targets: { type: 'all' },
    })).toEqual([[{ type: 'custom' }], [{ type: 'metric' }]]);
  });

  it('returns nothing for non-records', () => {
    for (const v of [null, undefined, 'x', 7, [1, 2]]) expect(conditionPayloadsFrom(v)).toEqual([]);
  });
});

describe('retiredConditionTypeError (issue #2948)', () => {
  it('returns null when nothing was supplied', () => {
    expect(retiredConditionTypeError(undefined)).toBeNull();
    expect(retiredConditionTypeError(null)).toBeNull();
  });

  it('returns null for a supported condition', () => {
    expect(retiredConditionTypeError([{ type: 'metric', metric: 'cpu', operator: 'gt', value: 85 }])).toBeNull();
  });

  it('fails CLOSED when the payload is too big to scan conclusively', () => {
    // An inconclusive scan reported as clean re-opens the whole #2948 hole.
    const huge = Array.from({ length: 20000 }, () => ({ nested: { deep: {} } }));
    const message = retiredConditionTypeError(huge);
    expect(message).toMatch(/too large or too deeply nested/i);
  });

  it('names the offending type and says what to do about it', () => {
    const message = retiredConditionTypeError([{ type: 'custom' }]);
    expect(message).toContain('custom');
    expect(message).toContain('never fire');
    expect(message).toMatch(/remove or replace/i);
  });
});
