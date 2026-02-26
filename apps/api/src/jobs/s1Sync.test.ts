import { describe, expect, it } from 'vitest';
import {
  applyPollFailure,
  dedupeThreatDetections,
  normalizeThreatStatus
} from './s1Sync';

describe('s1Sync helpers', () => {
  it('deduplicates threat detections by SentinelOne threat ID', () => {
    const deduped = dedupeThreatDetections([
      { s1ThreatId: 'threat-a', severity: 'high' },
      { s1ThreatId: 'threat-a', severity: 'high' },
      { s1ThreatId: 'threat-b', severity: 'low' },
    ]);

    expect(deduped).toHaveLength(2);
    expect(deduped.map((row) => row.s1ThreatId)).toEqual(['threat-a', 'threat-b']);
  });

  it('maps provider mitigation statuses to normalized threat states', () => {
    expect(normalizeThreatStatus('resolved')).toBe('resolved');
    expect(normalizeThreatStatus('quarantine_pending')).toBe('quarantined');
    expect(normalizeThreatStatus('in_progress')).toBe('in_progress');
    expect(normalizeThreatStatus('new')).toBe('active');
  });

  it('transitions action polling failures to terminal failure at threshold', () => {
    const first = applyPollFailure({}, new Error('timeout'), 3);
    expect(first.failureCount).toBe(1);
    expect(first.shouldFail).toBe(false);

    const second = applyPollFailure(first.payload, new Error('timeout'), 3);
    expect(second.failureCount).toBe(2);
    expect(second.shouldFail).toBe(false);

    const third = applyPollFailure(second.payload, new Error('timeout'), 3);
    expect(third.failureCount).toBe(3);
    expect(third.shouldFail).toBe(true);
    expect(third.error).toContain('timeout');
  });
});
