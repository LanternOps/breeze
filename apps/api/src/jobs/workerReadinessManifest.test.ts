import { describe, expect, it, vi } from 'vitest';
import { WORKER_REGISTRY } from '../services/workerRegistry';
import { WORKER_READINESS_MANIFEST, declareExpectedConsumers } from './workerReadinessManifest';

const NON_CONSUMERS = [
  'desktopSessionOrphanRecovery',
  'oauthRevocationRetryWorker',
  'incidentCorrelationWorker',
  'incidentTimelineEnricher',
  'incidentSlaMonitor',
];

// The two consumers main starts OUTSIDE the registry, role-gated in
// index.ts (eventDispatch when role !== 'api'; agentCommandRelay when
// role !== 'worker') and worker.ts (eventDispatch only).
const OUT_OF_REGISTRY_INITIALIZERS = ['eventDispatch', 'agentCommandRelay'] as const;

function initializerKeys(): string[] {
  return [...WORKER_REGISTRY.map((entry) => entry.name), ...OUT_OF_REGISTRY_INITIALIZERS];
}

/** Consumer names the manifest declares, in manifest order. */
function declaredConsumerNames(): string[] {
  return WORKER_READINESS_MANIFEST.flatMap((e) => (e.kind === 'consumers' ? [...e.consumers] : []));
}

/**
 * Cross-check against the REGISTRY, not the manifest: every initializer is a
 * registry entry or one of the two out-of-registry starters; non-consumers
 * declare nothing; multi-Worker initializers add (consumers.length - 1) extras.
 */
function expectedDeclaredCount(): number {
  const extras = WORKER_READINESS_MANIFEST.reduce(
    (sum, e) => sum + (e.kind === 'consumers' ? e.consumers.length - 1 : 0),
    0,
  );
  return WORKER_REGISTRY.length + OUT_OF_REGISTRY_INITIALIZERS.length - NON_CONSUMERS.length + extras;
}

/**
 * Mirror of the declare-time rules. Task 3 extends this with the role and the
 * event-dispatch / ai-agents flags; keep it the single place the rules live in
 * this file so the count tests cannot drift from the semantics tests.
 */
function expectedRequiredNames(flags: { abuseSignalsEnabled: boolean }): string[] {
  return WORKER_READINESS_MANIFEST.flatMap((e) => {
    if (e.kind !== 'consumers') return [];
    const required = e.requiredWhen === 'redis' || flags.abuseSignalsEnabled;
    return required ? [...e.consumers] : [];
  }).sort();
}

function fakeRegistry() {
  return {
    expect: vi.fn(),
    disable: vi.fn(),
    attach: vi.fn(),
    recordInitializationFailure: vi.fn(),
    snapshot: vi.fn(() => ({})),
    requiredConsumersRunnable: vi.fn(() => false),
  };
}

describe('worker readiness manifest', () => {
  it('classifies every initializeWorkers group exactly once', () => {
    const keys = initializerKeys().sort();
    const declared = WORKER_READINESS_MANIFEST.map(({ initializer }) => initializer).sort();
    expect(declared).toEqual(keys);
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('classifies only verified timer/subscriber initializers as non-consumers', () => {
    const actual = WORKER_READINESS_MANIFEST
      .filter(({ kind }) => kind === 'non_consumer')
      .map(({ initializer }) => initializer)
      .sort();
    expect(actual).toEqual([...NON_CONSUMERS].sort());
  });

  it('declares every stable consumer name exactly once', () => {
    const names = declaredConsumerNames();
    expect(names).toHaveLength(expectedDeclaredCount());
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not reinterpret Redis startup failure as a feature disable', () => {
    const registry = fakeRegistry();
    declareExpectedConsumers({ redisAvailable: false, abuseSignalsEnabled: false, registry });
    expect(registry.expect).not.toHaveBeenCalled();
    expect(registry.disable).not.toHaveBeenCalled();
  });

  it('declares Redis consumers required and abuse signals optional-disabled when configured off', () => {
    const registry = fakeRegistry();
    declareExpectedConsumers({ redisAvailable: true, abuseSignalsEnabled: false, registry });
    expect(registry.expect.mock.calls.filter(([name]) => name === 'abuseSignalsWorker')).toEqual([['abuseSignalsWorker', false]]);
    expect(registry.disable).toHaveBeenCalledWith('abuseSignalsWorker', 'feature_disabled');
    const required = registry.expect.mock.calls.filter(([, r]) => r).map(([n]) => n as string).sort();
    expect(required).toEqual(expectedRequiredNames({ abuseSignalsEnabled: false }));
    // Named, not numbered: exactly these consumers are optional on a box with every flag off.
    const optional = declaredConsumerNames().filter((n) => !required.includes(n)).sort();
    expect(optional).toEqual(['abuseSignalsWorker']);
  });

  it('makes abuse signals required when configured on', () => {
    const registry = fakeRegistry();
    declareExpectedConsumers({ redisAvailable: true, abuseSignalsEnabled: true, registry });
    expect(registry.expect).toHaveBeenCalledWith('abuseSignalsWorker', true);
    expect(registry.disable).not.toHaveBeenCalled();
    expect(registry.expect).toHaveBeenCalledTimes(declaredConsumerNames().length);
    expect(registry.expect.mock.calls.filter(([, r]) => r)).toHaveLength(expectedRequiredNames({ abuseSignalsEnabled: true }).length);
  });
});
