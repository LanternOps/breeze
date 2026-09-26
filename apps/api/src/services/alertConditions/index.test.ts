import { describe, it, expect, vi, beforeEach } from 'vitest';

// utils.ts (transitively imported by the handlers) pulls in the db module at
// import time; stub it so importing the registry doesn't open a connection.
// `select` is a real mock (not `{}`) so handlers that query the db directly
// (e.g. patchComplianceHandler) can be driven per-test.
const { mockDbSelect } = vi.hoisted(() => ({ mockDbSelect: vi.fn() }));
vi.mock('../../db', () => ({ db: { select: mockDbSelect } }));

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
import { conditionPayloadsFrom, evaluateConditions, findRetiredConditionTypes, interpolateTemplate, retiredConditionTypeError } from './index';
import { conditionRegistry } from './registry';
import { offlineHandler } from './handlers/offline';
import { interpolateAlertTemplate } from '@breeze/shared';
import { patchComplianceKind } from '../monitors/kinds/patchCompliance';
import { bandwidthKind } from '../monitors/kinds/bandwidth';
import { networkErrorsKind } from '../monitors/kinds/networkErrors';

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

describe('evaluateConditions dataState (issue #5290)', () => {
  beforeEach(() => {
    getRecentMetricsMock.mockReset();
    getLatestMetricMock.mockReset();
  });

  it('reports dataState "unknown" when the device has no metrics for a threshold condition', async () => {
    getRecentMetricsMock.mockResolvedValue([]);
    getLatestMetricMock.mockResolvedValue(undefined);

    const result = await evaluateConditions(
      [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 90 }],
      'device-with-no-metrics'
    );

    expect(result.triggered).toBe(false);
    expect(result.dataState).toBe('unknown');
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

describe('interpolateTemplate', () => {
  it('fills {{device}} from deviceName so stored titles do not leak the placeholder', () => {
    expect(interpolateTemplate('{{device}} offline', { deviceName: 'DESKTOP-8UG65K6' })).toBe(
      'DESKTOP-8UG65K6 offline',
    );
  });
});

describe('evaluateConditions context for non-threshold kinds (issue #6932)', () => {
  beforeEach(() => {
    mockDbSelect.mockReset();
    getRecentMetricsMock.mockReset();
    getLatestMetricMock.mockReset();
  });

  it('fills actualValue/operator/threshold for a patch_compliance condition, so the built-in template renders with no {{ left', async () => {
    // Drives db.select({...}).from(...).where(...).orderBy(...).limit(1).
    mockDbSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([{ patchComplianceScore: 50, capturedAt: new Date(), factorDetails: {} }]),
          }),
        }),
      }),
    });

    const result = await evaluateConditions(
      { type: 'patch_compliance', operator: 'lt', value: 80 },
      'device-1'
    );

    expect(result.triggered).toBe(true);
    expect(result.context.actualValue).toBe(50);
    expect(result.context.threshold).toBe(80);
    expect(result.context.operator).toBe('<');

    const title = interpolateAlertTemplate(patchComplianceKind.titleTemplate, {
      ...result.context,
      ruleName: 'Low patch compliance',
      deviceName: 'DESKTOP-8UG65K6',
    });
    const message = interpolateAlertTemplate(patchComplianceKind.messageTemplate, {
      ...result.context,
      ruleName: 'Low patch compliance',
      deviceName: 'DESKTOP-8UG65K6',
    });

    expect(title).not.toContain('{{');
    expect(message).toBe('Low patch compliance: patch compliance 50% (< 80%)');
  });

  it('fills actualValue/operator/threshold for a bandwidth_high condition', async () => {
    getRecentMetricsMock.mockResolvedValue([
      // 15,000,000 bytes/sec from the agent = 120 Mbps.
      { bandwidthInBps: 15_000_000, bandwidthOutBps: 0 },
    ] as never);

    const result = await evaluateConditions(
      { type: 'bandwidth_high', direction: 'in', operator: 'gt', value: 100 },
      'device-1'
    );

    expect(result.triggered).toBe(true);
    expect(result.context.actualValue).toBe(120);
    expect(result.context.threshold).toBe(100);
    expect(result.context.operator).toBe('>');

    const message = interpolateAlertTemplate(bandwidthKind.messageTemplate, {
      ...result.context,
      ruleName: 'High bandwidth',
      direction: 'in',
    });
    expect(message).not.toContain('{{');
    expect(message).toBe('High bandwidth: in bandwidth 120 Mbps (> 100 Mbps)');
  });

  it('fills actualValue/operator/threshold for a network_errors condition', async () => {
    // Cumulative counters, newest first: 12 errors accrued across the window.
    const now = Date.now();
    getRecentMetricsMock.mockResolvedValue([
      { timestamp: new Date(now), interfaceStats: [{ name: 'eth0', inErrors: 112, outErrors: 0 }] },
      { timestamp: new Date(now - 2 * 60_000), interfaceStats: [{ name: 'eth0', inErrors: 100, outErrors: 0 }] },
    ] as never);

    const result = await evaluateConditions(
      { type: 'network_errors', errorType: 'in', operator: 'gt', value: 5 },
      'device-1'
    );

    expect(result.triggered).toBe(true);
    expect(result.context.actualValue).toBe(12);
    expect(result.context.threshold).toBe(5);
    expect(result.context.operator).toBe('>');

    const message = interpolateAlertTemplate(networkErrorsKind.messageTemplate, {
      ...result.context,
      ruleName: 'Network errors',
      errorType: 'in',
    });
    expect(message).not.toContain('{{');
  });
});

describe('evaluateConditions primary actualValue is deterministic, not a race (follow-up to #6932)', () => {
  // Two synthetic handlers whose resolution order the test controls
  // explicitly (via `pendingResolvers`), independent of their position in
  // the conditions array — sibling leaves under a group run through
  // `Promise.all`, so "whichever settles first" and "array order" are two
  // different things, and only array (tree) order is allowed to matter.
  let pendingResolvers: Array<() => void>;

  function registerControlledHandler(type: string, actualValue: number) {
    conditionRegistry.register({
      type,
      evaluate: () =>
        new Promise((resolve) => {
          pendingResolvers.push(() =>
            resolve({ passed: true, description: `${type} fired`, actualValue }),
          );
        }),
      validate: () => [],
    });
  }

  beforeEach(() => {
    pendingResolvers = [];
    registerControlledHandler('test_order_leaf_a', 111);
    registerControlledHandler('test_order_leaf_b', 222);
  });

  it('picks the FIRST-IN-ARRAY leaf even when it is the LAST to resolve (no threshold/metric leaf present)', async () => {
    const resultPromise = evaluateConditions(
      {
        logic: 'or',
        conditions: [
          { type: 'test_order_leaf_a' }, // array position 0 — must win
          { type: 'test_order_leaf_b' }, // array position 1 — resolves first in time
        ],
      },
      'device-1',
    );

    // Resolve out of array order: b (index 1) completes before a (index 0).
    pendingResolvers[1]!();
    await Promise.resolve();
    pendingResolvers[0]!();

    const result = await resultPromise;
    expect(result.context.actualValue).toBe(111);
  });

  it('still prefers a threshold/metric leaf over a non-threshold leaf that resolves first', async () => {
    // A real macrotask delay (not just an extra microtask hop) so the
    // non-threshold leaf UNAMBIGUOUSLY finishes first in wall-clock time —
    // this is what makes the test a genuine red-first guard for the
    // preference rule itself, not just for tree order (test above).
    getRecentMetricsMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([{ ramPercent: 92 }]), 5)),
    );
    getLatestMetricMock.mockResolvedValue({ ramPercent: 92 });

    const resultPromise = evaluateConditions(
      {
        logic: 'or',
        conditions: [
          { type: 'metric', metric: 'ram', operator: 'gt', value: 50 }, // array position 0, real threshold handler — settles LAST
          { type: 'test_order_leaf_a' }, // array position 1, non-threshold — settles FIRST
        ],
      },
      'device-1',
    );

    // Resolved on the next microtask, long before the real handler's 5ms timer.
    pendingResolvers[0]!();

    const result = await resultPromise;
    expect(result.context.actualValue).toBe(92);
  });
});
