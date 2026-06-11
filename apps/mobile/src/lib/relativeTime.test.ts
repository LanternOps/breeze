import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { relativeTime } from './relativeTime';

describe('relativeTime', () => {
  const NOW = new Date('2026-05-07T12:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty string for null / undefined', () => {
    expect(relativeTime(null)).toBe('');
    expect(relativeTime(undefined)).toBe('');
  });

  it('returns empty string for invalid ISO input', () => {
    expect(relativeTime('not-a-date')).toBe('');
  });

  it('returns "just now" for diffs under 60 seconds', () => {
    const t = new Date(NOW - 30_000).toISOString();
    expect(relativeTime(t)).toBe('just now');
  });

  it('formats minute-scale diffs as "Nm ago"', () => {
    const t = new Date(NOW - 5 * 60_000).toISOString();
    expect(relativeTime(t)).toBe('5m ago');
  });

  it('crosses into the hour bucket at 60 minutes', () => {
    const t = new Date(NOW - 60 * 60_000).toISOString();
    expect(relativeTime(t)).toBe('1h ago');
  });

  it('formats hour-scale diffs as "Nh ago"', () => {
    const t = new Date(NOW - 5 * 60 * 60_000).toISOString();
    expect(relativeTime(t)).toBe('5h ago');
  });

  it('crosses into the day bucket at 24 hours', () => {
    const t = new Date(NOW - 24 * 60 * 60_000).toISOString();
    expect(relativeTime(t)).toBe('1d ago');
  });

  it('formats day-scale diffs as "Nd ago"', () => {
    const t = new Date(NOW - 3 * 24 * 60 * 60_000).toISOString();
    expect(relativeTime(t)).toBe('3d ago');
  });

  it('crosses into the week bucket at 7 days', () => {
    const t = new Date(NOW - 7 * 24 * 60 * 60_000).toISOString();
    expect(relativeTime(t)).toBe('1w ago');
  });

  it('formats week-scale diffs as "Nw ago"', () => {
    const t = new Date(NOW - 21 * 24 * 60 * 60_000).toISOString();
    expect(relativeTime(t)).toBe('3w ago');
  });

  it('treats negative diffs (future dates) as "just now"', () => {
    const t = new Date(NOW + 10_000).toISOString();
    expect(relativeTime(t)).toBe('just now');
  });
});
