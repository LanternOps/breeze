import { beforeEach, describe, expect, it } from 'vitest';
import {
  UPDATE_STATUS_DEDUPE_WINDOW_MS,
  beginAgentUpdateStatusWrite,
  finishAgentUpdateStatusWrite,
  getAgentUpdateStatusCoalescerMetrics,
  resetAgentUpdateStatusCoalescerForTests,
} from './agentUpdateStatusCoalescer';

describe('agentUpdateStatusCoalescer', () => {
  beforeEach(() => {
    resetAgentUpdateStatusCoalescerForTests();
  });

  it('absorbs frames while a write is in flight, whatever the version', () => {
    expect(beginAgentUpdateStatusWrite('a1', '1.0.0', 1_000)).toBe(true);
    expect(beginAgentUpdateStatusWrite('a1', '1.0.0', 1_001)).toBe(false);
    expect(beginAgentUpdateStatusWrite('a1', '2.0.0', 1_002)).toBe(false);
    expect(getAgentUpdateStatusCoalescerMetrics().absorbed).toBe(2);
  });

  it('absorbs the same version inside the window and writes it again after', () => {
    expect(beginAgentUpdateStatusWrite('a1', '1.0.0', 1_000)).toBe(true);
    finishAgentUpdateStatusWrite('a1', '1.0.0', true, 1_000);
    expect(beginAgentUpdateStatusWrite('a1', '1.0.0', 1_000 + UPDATE_STATUS_DEDUPE_WINDOW_MS - 1)).toBe(false);
    expect(beginAgentUpdateStatusWrite('a1', '1.0.0', 1_000 + UPDATE_STATUS_DEDUPE_WINDOW_MS)).toBe(true);
  });

  it('always writes a different target version once the previous write settled', () => {
    expect(beginAgentUpdateStatusWrite('a1', '1.0.0', 1_000)).toBe(true);
    finishAgentUpdateStatusWrite('a1', '1.0.0', true, 1_000);
    expect(beginAgentUpdateStatusWrite('a1', '1.0.1', 1_001)).toBe(true);
  });

  it('a failed write lets the next frame retry immediately', () => {
    expect(beginAgentUpdateStatusWrite('a1', '1.0.0', 1_000)).toBe(true);
    finishAgentUpdateStatusWrite('a1', '1.0.0', false, 1_000);
    expect(beginAgentUpdateStatusWrite('a1', '1.0.0', 1_001)).toBe(true);
  });

  it('keeps agents independent', () => {
    expect(beginAgentUpdateStatusWrite('a1', '1.0.0', 1_000)).toBe(true);
    expect(beginAgentUpdateStatusWrite('a2', '1.0.0', 1_000)).toBe(true);
  });

  it('sweeps settled, expired entries once the tracked set is large', () => {
    for (let i = 0; i < 10_000; i++) {
      beginAgentUpdateStatusWrite(`agent-${i}`, '1.0.0', 0);
      finishAgentUpdateStatusWrite(`agent-${i}`, '1.0.0', true, 0);
    }
    expect(getAgentUpdateStatusCoalescerMetrics().tracked).toBe(10_000);
    expect(beginAgentUpdateStatusWrite('fresh', '1.0.0', UPDATE_STATUS_DEDUPE_WINDOW_MS)).toBe(true);
    expect(getAgentUpdateStatusCoalescerMetrics().tracked).toBe(1);
  });
});
