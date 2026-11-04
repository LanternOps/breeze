import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidenceCursor } from '@breeze/shared';
import type { ConditionResult } from './types';

const { mockDbSelect, getLatestMetricMock } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(), getLatestMetricMock: vi.fn(),
}));
vi.mock('../../db', () => ({ db: { select: mockDbSelect } }));
vi.mock('./utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils')>();
  return { ...actual, getLatestMetric: getLatestMetricMock };
});

import { conditionRegistry, evaluateConditions, evaluateAutoResolveConditions, evidenceLeafPaths } from './index';

const evidence = { type: 'test_contract_evidence' };
const state = { type: 'test_contract_state' };
const cursor: EvidenceCursor = { ts: '2026-10-29T10:00:00Z', createdAt: '2026-10-29T10:01:00Z', id: 'row-1' };
const next: EvidenceCursor = { ...cursor, id: 'row-2' };
const evidenceEvaluate = vi.fn<(...args: unknown[]) => Promise<ConditionResult>>();
const stateEvaluate = vi.fn<(...args: unknown[]) => Promise<ConditionResult>>();

beforeEach(() => {
  evidenceEvaluate.mockReset().mockResolvedValue({ passed: true, description: 'evidence' });
  stateEvaluate.mockReset().mockResolvedValue({ passed: true, description: 'state' });
  getLatestMetricMock.mockReset().mockResolvedValue(undefined);
  conditionRegistry.register({ ...evidence, evidence: true, evaluate: evidenceEvaluate, validate: () => [] });
  conditionRegistry.register({ ...state, evaluate: stateEvaluate, validate: () => [] });
});

describe('evidence handler contract', () => {
  it('passes the cursor for its leaf path only to evidence handlers', async () => {
    await evaluateConditions([evidence, state], 'device-1', { cursors: { '0': cursor, '1': next }, side: 'trigger' });
    expect(evidenceEvaluate).toHaveBeenCalledWith(evidence, 'device-1', { evidenceAfter: cursor, side: 'trigger', legacyIngestedBefore: undefined });
    expect(stateEvaluate).toHaveBeenCalledWith(state, 'device-1');
  });

  it('collects evidenceWatermark per leaf path', async () => {
    evidenceEvaluate.mockResolvedValueOnce({ passed: false, description: 'first', evidenceWatermark: cursor })
      .mockResolvedValueOnce({ passed: true, description: 'second', evidenceWatermark: next });
    const result = await evaluateConditions([evidence, { logic: 'or', conditions: [evidence, state] }], 'device-1');
    expect(result.evidenceWatermarks).toEqual({ '0': cursor, '1.0': next });
  });

  it("evidenceLeafPaths returns [] for a state-only tree and ['0'] for and(evidence, state)", () => {
    expect(evidenceLeafPaths({ logic: 'and', conditions: [state] })).toEqual([]);
    expect(evidenceLeafPaths({ logic: 'and', conditions: [evidence, state] })).toEqual(['0']);
    expect(evidenceLeafPaths([evidence, state])).toEqual(['0']);
    expect(evidenceLeafPaths([state, { logic: 'or', conditions: [evidence] }])).toEqual(['1.0']);
    expect(evidenceLeafPaths(evidence)).toEqual(['root']);
    expect(evidenceLeafPaths({ type: 'event_log' })).toEqual(['root']);
    for (const invalid of [null, undefined, false, 42, 'invalid']) expect(evidenceLeafPaths(invalid)).toEqual([]);
  });

  it('omitting opts behaves exactly as today', async () => {
    const result = await evaluateConditions([evidence, state], 'device-1');
    expect(stateEvaluate).toHaveBeenCalledWith(state, 'device-1');
    expect(evidenceEvaluate.mock.calls[0]?.[2]).toBeUndefined();
    expect(result).toMatchObject({ triggered: true, dataState: 'ok', evidenceWatermarks: {}, conditionsNotMet: [] });
    expect(result.conditionsMet).toEqual(['evidence', 'state']);
  });

  it('passes nested-path cursors and applies the legacy cutoff only to leaves without cursors', async () => {
    const cutoff = new Date('2026-10-29T11:00:00Z');
    await evaluateConditions([evidence, { logic: 'and', conditions: [evidence] }], 'device-1', {
      cursors: { '1.0': cursor }, side: 'trigger', legacyIngestedBefore: cutoff,
    });
    expect(evidenceEvaluate).toHaveBeenNthCalledWith(1, evidence, 'device-1', { evidenceAfter: undefined, side: 'trigger', legacyIngestedBefore: cutoff });
    expect(evidenceEvaluate).toHaveBeenNthCalledWith(2, evidence, 'device-1', { evidenceAfter: cursor, side: 'trigger', legacyIngestedBefore: undefined });
  });

  it('uses root for a single leaf and passes auto-resolve metadata through', async () => {
    evidenceEvaluate.mockResolvedValue({ passed: true, description: 'recovered', evidenceWatermark: next });
    const result = await evaluateAutoResolveConditions(evidence, 'device-1', { cursors: { root: cursor }, side: 'resolve' });
    expect(evidenceEvaluate).toHaveBeenCalledWith(evidence, 'device-1', { evidenceAfter: cursor, side: 'resolve', legacyIngestedBefore: undefined });
    expect(result).toEqual({ shouldResolve: true, reason: 'Conditions cleared: recovered', evidenceWatermarks: { root: next }, dataState: 'ok' });
  });

  it('passes unknown data state through auto-resolve', async () => {
    evidenceEvaluate.mockResolvedValue({ passed: false, description: 'unavailable', dataAvailable: false });
    expect(await evaluateAutoResolveConditions(evidence, 'device-1')).toMatchObject({ shouldResolve: false, dataState: 'unknown', evidenceWatermarks: {} });
  });

  it('always returns empty watermarks for missing or invalid conditions', async () => {
    for (const conditions of [undefined, 'invalid', []]) {
      expect((await evaluateConditions(conditions, 'device-1')).evidenceWatermarks).toEqual({});
      expect(await evaluateAutoResolveConditions(conditions, 'device-1')).toMatchObject({ evidenceWatermarks: {}, dataState: conditions instanceof Array ? 'ok' : 'unknown' });
    }
  });
});
