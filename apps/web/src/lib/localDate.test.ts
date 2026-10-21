import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { localDateInputValue } from './localDate';

describe('localDateInputValue', () => {
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/Denver';
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });
  afterEach(() => vi.useRealTimers());

  it('returns the local calendar day, not the UTC day, in the evening', () => {
    vi.useFakeTimers();
    // 23:30 MDT on 2026-10-18 == 05:30Z on 10-19
    vi.setSystemTime(new Date('2026-10-19T05:30:00Z'));
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-10-19');
    expect(localDateInputValue()).toBe('2026-10-18');
  });

  it('accepts an explicit date and zero-pads', () => {
    expect(localDateInputValue(new Date(2026, 0, 5, 12))).toBe('2026-01-05');
  });
});
