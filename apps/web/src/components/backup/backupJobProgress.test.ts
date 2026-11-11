import { describe, expect, it } from 'vitest';
import {
  STALL_MS,
  deriveActivePhase,
  estimateRemainingMs,
  formatEta,
  nextSpeedSample,
  stallState,
} from './backupJobProgress';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('nextSpeedSample', () => {
  it('nextSpeedSample first sample uses running average', () => {
    const result = nextSpeedSample(undefined, { transferredSize: 1000, startedAt: iso(10_000) }, NOW);
    expect(result.bps).toBe(100);
    expect(result.sample).toEqual({ bytes: 1000, at: NOW });
  });

  it('uses the delta since the previous sample', () => {
    const result = nextSpeedSample({ bytes: 1000, at: NOW - 5000 }, { transferredSize: 6000, startedAt: iso(60_000) }, NOW);
    expect(result.bps).toBe(1000);
    expect(result.sample).toEqual({ bytes: 6000, at: NOW });
  });

  it('nextSpeedSample stalled delta yields no speed', () => {
    const result = nextSpeedSample({ bytes: 6000, at: NOW - 5000 }, { transferredSize: 6000, startedAt: iso(60_000) }, NOW);
    expect(result.bps).toBeUndefined();
    // The sample still advances so the next delta is measured from now.
    expect(result.sample).toEqual({ bytes: 6000, at: NOW });
  });

  it('yields no speed and no sample without a transferred size', () => {
    expect(nextSpeedSample(undefined, { transferredSize: null, startedAt: iso(10_000) }, NOW)).toEqual({
      bps: undefined,
      sample: undefined,
    });
  });

  it('yields no speed on a first sample with nothing transferred or no start time', () => {
    expect(nextSpeedSample(undefined, { transferredSize: 0, startedAt: iso(10_000) }, NOW).bps).toBeUndefined();
    expect(nextSpeedSample(undefined, { transferredSize: 500, startedAt: null }, NOW).bps).toBeUndefined();
  });
});

describe('stallState', () => {
  it('stallState uses keepalive, falls back to lastProgressAt', () => {
    // A fresh keepalive wins over an old lastProgressAt (one big file uploading).
    expect(
      stallState({ status: 'running', lastKeepaliveAt: iso(10_000), lastProgressAt: iso(10 * 60_000) }, NOW).stalled,
    ).toBe(false);
    // No keepalive (server predating #2798): lastProgressAt is liveness.
    expect(stallState({ status: 'running', lastKeepaliveAt: null, lastProgressAt: iso(5 * 60_000) }, NOW)).toEqual({
      stalled: true,
      minutes: 5,
    });
  });

  it('flags only after STALL_MS and reports at least one minute', () => {
    expect(stallState({ status: 'running', lastKeepaliveAt: iso(STALL_MS), lastProgressAt: null }, NOW).stalled).toBe(false);
    expect(stallState({ status: 'running', lastKeepaliveAt: iso(STALL_MS + 1), lastProgressAt: null }, NOW)).toEqual({
      stalled: true,
      minutes: 2,
    });
  });

  it('is never stalled for a non-running job or one with no liveness signal', () => {
    expect(stallState({ status: 'pending', lastKeepaliveAt: iso(60 * 60_000), lastProgressAt: null }, NOW).stalled).toBe(false);
    expect(stallState({ status: 'running', lastKeepaliveAt: null, lastProgressAt: null }, NOW).stalled).toBe(false);
  });
});

describe('estimateRemainingMs', () => {
  it('estimateRemainingMs null without total or speed', () => {
    expect(estimateRemainingMs({ transferredSize: 100, totalSize: null }, 10)).toBeNull();
    expect(estimateRemainingMs({ transferredSize: 100, totalSize: 0 }, 10)).toBeNull();
    expect(estimateRemainingMs({ transferredSize: 100, totalSize: 400 }, undefined)).toBeNull();
    expect(estimateRemainingMs({ transferredSize: 100, totalSize: 400 }, 0)).toBeNull();
  });

  it('estimateRemainingMs (100 of 400 bytes at 10 B/s) is 30000', () => {
    expect(estimateRemainingMs({ transferredSize: 100, totalSize: 400 }, 10)).toBe(30_000);
  });

  it('is null once transferred reaches the total', () => {
    expect(estimateRemainingMs({ transferredSize: 400, totalSize: 400 }, 10)).toBeNull();
  });
});

describe('deriveActivePhase', () => {
  const base = { lastKeepaliveAt: null, resumedAt: null, transferredSize: null, totalSize: null };

  it('waiting_for_device: pending with no keepalive', () => {
    expect(deriveActivePhase({ ...base, status: 'pending' })).toBe('waiting_for_device');
  });

  it('queued_on_device: pending with a keepalive', () => {
    expect(deriveActivePhase({ ...base, status: 'pending', lastKeepaliveAt: iso(1000) })).toBe('queued_on_device');
  });

  it('deriveActivePhase resuming', () => {
    expect(
      deriveActivePhase({ ...base, status: 'running', resumedAt: iso(1000), transferredSize: 0, totalSize: 4000 }),
    ).toBe('resuming');
    expect(deriveActivePhase({ ...base, status: 'running', resumedAt: iso(1000), transferredSize: null })).toBe('resuming');
  });

  it('a resumed run that has moved bytes is backing up again', () => {
    expect(
      deriveActivePhase({ ...base, status: 'running', resumedAt: iso(1000), transferredSize: 10, totalSize: 4000 }),
    ).toBe('backing_up');
  });

  it('scanning: running with no positive total', () => {
    expect(deriveActivePhase({ ...base, status: 'running', transferredSize: 10, totalSize: null })).toBe('scanning');
    expect(deriveActivePhase({ ...base, status: 'running', transferredSize: 10, totalSize: 0 })).toBe('scanning');
  });

  it('backing_up: running with a total', () => {
    expect(deriveActivePhase({ ...base, status: 'running', transferredSize: 10, totalSize: 4000 })).toBe('backing_up');
  });
});

describe('formatEta', () => {
  it('formatEta boundaries', () => {
    expect(formatEta(0)).toBe('<1m');
    expect(formatEta(59_999)).toBe('<1m');
    expect(formatEta(60_000)).toBe('1m');
    expect(formatEta(45 * 60_000)).toBe('45m');
    expect(formatEta(3_599_999)).toBe('59m');
    expect(formatEta(3_600_000)).toBe('1h 0m');
    expect(formatEta(3 * 3_600_000 + 10 * 60_000)).toBe('3h 10m');
    expect(formatEta(86_399_999)).toBe('23h 59m');
    expect(formatEta(86_400_000)).toBe('1d 0h');
    expect(formatEta(90_000_000)).toBe('1d 1h');
    expect(formatEta(2 * 86_400_000 + 4 * 3_600_000)).toBe('2d 4h');
  });
});
