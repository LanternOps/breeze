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
import { evaluateConditions, findRetiredConditionTypes, retiredConditionTypeError } from './index';
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
    expect(findRetiredConditionTypes([{ type: 'custom', customCondition: 'x' }])).toEqual(['custom']);
  });

  it('flags a bare root object, the shape the alert-template routes accept', () => {
    // Those routes validate `conditions` as z.record — an OBJECT, never an
    // array — so the un-wrapped shape is the dominant one there.
    expect(findRetiredConditionTypes({ type: 'custom' })).toEqual(['custom']);
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
    expect(findRetiredConditionTypes(payload)).toEqual(['custom']);
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
    expect(findRetiredConditionTypes(live)).toEqual([]);
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
    expect(findRetiredConditionTypes(supported)).toEqual([]);
  });

  it('walks into nested condition groups', () => {
    const tree = {
      logic: 'or',
      conditions: [
        { type: 'metric', metric: 'cpu', operator: 'gt', value: 85 },
        { logic: 'and', conditions: [{ type: 'custom' }] },
      ],
    };
    expect(findRetiredConditionTypes(tree)).toEqual(['custom']);
  });

  it('dedupes repeated retired types', () => {
    expect(findRetiredConditionTypes([{ type: 'custom' }, { type: 'custom' }])).toEqual(['custom']);
  });

  it('ignores non-object and typeless nodes rather than inventing an error', () => {
    expect(findRetiredConditionTypes([null, 'nope', 42, {}, { type: 7 }])).toEqual([]);
  });

  it('truncates a pathologically deep tree instead of blowing the stack', () => {
    let node: Record<string, unknown> = { type: 'custom' };
    for (let i = 0; i < 5000; i++) node = { logic: 'and', conditions: [node] };
    // Documents the deliberate fail-OPEN: past MAX_CONDITION_DEPTH the walk
    // reports nothing and the write is accepted. The evaluator has no depth
    // limit and still fails such a condition closed, so this degrades to the
    // pre-fix behaviour rather than to a false rejection.
    expect(findRetiredConditionTypes(node)).toEqual([]);
  });

  it('does not run away on a wide payload', () => {
    const wide = Array.from({ length: 20000 }, () => ({ type: 'metric', metric: 'cpu' }));
    expect(findRetiredConditionTypes(wide)).toEqual([]);
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

  it('names the offending type and says what to do about it', () => {
    const message = retiredConditionTypeError([{ type: 'custom' }]);
    expect(message).toContain('custom');
    expect(message).toContain('never fire');
    expect(message).toMatch(/remove or replace/i);
  });
});
