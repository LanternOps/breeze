import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  WORKER_READINESS_MANIFEST,
  declareExpectedConsumers,
  initializeDeclaredWorkerGroup,
} from './workerReadinessManifest';

const NON_CONSUMERS = [
  'policyAlertBridge',
  'dnsThreatAlertSubscriber',
  'desktopSessionOrphanRecovery',
  'oauthRevocationRetryWorker',
  'incidentCorrelationWorker',
  'incidentTimelineEnricher',
  'incidentSlaMonitor',
];

function initializerKeys(): string[] {
  const indexPath = path.resolve(__dirname, '../index.ts');
  const source = ts.createSourceFile(
    indexPath,
    readFileSync(indexPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'workers'
      && node.initializer
      && ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        if (!ts.isArrayLiteralExpression(element)) continue;
        const key = element.elements[0];
        if (key && ts.isStringLiteral(key)) keys.push(key.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
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
    const names = WORKER_READINESS_MANIFEST.flatMap((entry) =>
      entry.kind === 'consumers' ? [...entry.consumers] : [],
    );
    expect(names).toHaveLength(102);
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
    const abuse = registry.expect.mock.calls.filter(([name]) => name === 'abuseSignalsWorker');
    expect(abuse).toEqual([['abuseSignalsWorker', false]]);
    expect(registry.disable).toHaveBeenCalledWith('abuseSignalsWorker', 'feature_disabled');
    expect(registry.expect.mock.calls.filter(([, required]) => required)).toHaveLength(101);
  });

  it('makes abuse signals required when configured on', () => {
    const registry = fakeRegistry();
    declareExpectedConsumers({ redisAvailable: true, abuseSignalsEnabled: true, registry });
    expect(registry.expect).toHaveBeenCalledWith('abuseSignalsWorker', true);
    expect(registry.disable).not.toHaveBeenCalled();
    expect(registry.expect).toHaveBeenCalledTimes(102);
  });

  it('records initialization failure for every consumer in a multi-consumer group', async () => {
    const registry = fakeRegistry();
    const error = new TypeError('startup failed');

    const result = await initializeDeclaredWorkerGroup({
      initializer: 'patchJobWorker',
      initialize: async () => { throw error; },
      registry,
    });

    expect(result).toBe(error);
    expect(registry.recordInitializationFailure.mock.calls).toEqual([
      ['patchJobWorker', error],
      ['patchJobDeviceWorker', error],
    ]);
  });

  it('does not manufacture failures when an initializer succeeds', async () => {
    const registry = fakeRegistry();
    const result = await initializeDeclaredWorkerGroup({
      initializer: 'patchJobWorker',
      initialize: async () => undefined,
      registry,
    });
    expect(result).toBeNull();
    expect(registry.recordInitializationFailure).not.toHaveBeenCalled();
  });
});
