import { describe, expect, it, vi } from 'vitest';
import { matchesCronField, isCronDue } from './automationRuntime';

describe('matchesCronField (extended)', () => {
  // ============================================
  // Wildcard
  // ============================================

  it('wildcard matches any value', () => {
    expect(matchesCronField('*', 0, 0, 59)).toBe(true);
    expect(matchesCronField('*', 30, 0, 59)).toBe(true);
    expect(matchesCronField('*', 59, 0, 59)).toBe(true);
  });

  // ============================================
  // Exact values
  // ============================================

  it('matches a single exact value', () => {
    expect(matchesCronField('5', 5, 0, 59)).toBe(true);
    expect(matchesCronField('5', 6, 0, 59)).toBe(false);
  });

  it('matches zero', () => {
    expect(matchesCronField('0', 0, 0, 59)).toBe(true);
    expect(matchesCronField('0', 1, 0, 59)).toBe(false);
  });

  // ============================================
  // Comma-separated lists
  // ============================================

  it('matches comma-separated values', () => {
    expect(matchesCronField('1,15,30', 15, 0, 59)).toBe(true);
    expect(matchesCronField('1,15,30', 2, 0, 59)).toBe(false);
  });

  it('handles whitespace around comma values', () => {
    expect(matchesCronField('1, 15, 30', 15, 0, 59)).toBe(true);
  });

  // ============================================
  // Ranges
  // ============================================

  it('matches a value within a range', () => {
    expect(matchesCronField('1-5', 3, 0, 59)).toBe(true);
    expect(matchesCronField('1-5', 1, 0, 59)).toBe(true);
    expect(matchesCronField('1-5', 5, 0, 59)).toBe(true);
  });

  it('rejects a value outside the range', () => {
    expect(matchesCronField('1-5', 0, 0, 59)).toBe(false);
    expect(matchesCronField('1-5', 6, 0, 59)).toBe(false);
  });

  // ============================================
  // Step expressions
  // ============================================

  it('matches step on wildcard (*/15)', () => {
    expect(matchesCronField('*/15', 0, 0, 59)).toBe(true);
    expect(matchesCronField('*/15', 15, 0, 59)).toBe(true);
    expect(matchesCronField('*/15', 30, 0, 59)).toBe(true);
    expect(matchesCronField('*/15', 45, 0, 59)).toBe(true);
    expect(matchesCronField('*/15', 10, 0, 59)).toBe(false);
  });

  it('matches step on a range (1-6/2)', () => {
    expect(matchesCronField('1-6/2', 1, 0, 59)).toBe(true);
    expect(matchesCronField('1-6/2', 3, 0, 59)).toBe(true);
    expect(matchesCronField('1-6/2', 5, 0, 59)).toBe(true);
    expect(matchesCronField('1-6/2', 2, 0, 59)).toBe(false);
    expect(matchesCronField('1-6/2', 4, 0, 59)).toBe(false);
    expect(matchesCronField('1-6/2', 7, 0, 59)).toBe(false);
  });

  it('matches step */5 for hours', () => {
    expect(matchesCronField('*/5', 0, 0, 23)).toBe(true);
    expect(matchesCronField('*/5', 5, 0, 23)).toBe(true);
    expect(matchesCronField('*/5', 10, 0, 23)).toBe(true);
    expect(matchesCronField('*/5', 3, 0, 23)).toBe(false);
  });

  // ============================================
  // Edge cases
  // ============================================

  it('skips invalid non-numeric values gracefully', () => {
    expect(matchesCronField('abc', 5, 0, 59)).toBe(false);
  });

  it('handles empty string in comma list', () => {
    expect(matchesCronField('5,,10', 5, 0, 59)).toBe(true);
    expect(matchesCronField('5,,10', 10, 0, 59)).toBe(true);
  });
});

describe('isCronDue (extended)', () => {
  // ============================================
  // Basic matching
  // ============================================

  it('matches when all fields match', () => {
    // 2026-02-17 is a Tuesday (dayOfWeek=2), month=2, day=17
    const date = new Date('2026-02-17T14:30:00Z');
    expect(isCronDue('30 14 * * *', 'UTC', date)).toBe(true);
  });

  it('does not match when minute differs', () => {
    const date = new Date('2026-02-17T14:31:00Z');
    expect(isCronDue('30 14 * * *', 'UTC', date)).toBe(false);
  });

  it('does not match when hour differs', () => {
    const date = new Date('2026-02-17T15:30:00Z');
    expect(isCronDue('30 14 * * *', 'UTC', date)).toBe(false);
  });

  // ============================================
  // DOM/DOW OR semantics
  // ============================================

  it('uses AND when only DOM is non-wildcard (DOW is *)', () => {
    // 2026-02-17 is a Tuesday, dayOfMonth=17
    // Cron: minute=0, hour=10, DOM=17, month=*, DOW=*
    // Both non-wildcard? No, DOW is * → AND semantics → must match DOM AND DOW
    const date = new Date('2026-02-17T10:00:00Z');
    expect(isCronDue('0 10 17 * *', 'UTC', date)).toBe(true);
  });

  it('uses AND when only DOW is non-wildcard (DOM is *)', () => {
    // 2026-02-17 is a Tuesday (DOW=2)
    const date = new Date('2026-02-17T10:00:00Z');
    expect(isCronDue('0 10 * * 2', 'UTC', date)).toBe(true);
    // 2026-02-18 is a Wednesday (DOW=3), not matching DOW=2
    const date2 = new Date('2026-02-18T10:00:00Z');
    expect(isCronDue('0 10 * * 2', 'UTC', date2)).toBe(false);
  });

  it('uses OR when both DOM and DOW are non-wildcard', () => {
    // 2026-02-17 is a Tuesday (DOW=2), dayOfMonth=17
    // Cron: DOM=1 (doesn't match), DOW=2 (matches) → OR → true
    const date = new Date('2026-02-17T10:00:00Z');
    expect(isCronDue('0 10 1 * 2', 'UTC', date)).toBe(true);
  });

  it('OR: matches when only DOM matches (DOW does not)', () => {
    // 2026-02-17 is a Tuesday (DOW=2), dayOfMonth=17
    // Cron: DOM=17 (matches), DOW=5 (Friday, doesn't match) → OR → true
    const date = new Date('2026-02-17T10:00:00Z');
    expect(isCronDue('0 10 17 * 5', 'UTC', date)).toBe(true);
  });

  it('OR: does not match when neither DOM nor DOW matches', () => {
    // 2026-02-17 is a Tuesday (DOW=2), dayOfMonth=17
    // Cron: DOM=1 (doesn't match), DOW=5 (Friday, doesn't match) → OR → false
    const date = new Date('2026-02-17T10:00:00Z');
    expect(isCronDue('0 10 1 * 5', 'UTC', date)).toBe(false);
  });

  // ============================================
  // Sunday as 0 vs 7
  // ============================================

  it('Sunday matches DOW=0', () => {
    // 2026-02-15 is a Sunday
    const date = new Date('2026-02-15T10:00:00Z');
    expect(isCronDue('0 10 * * 0', 'UTC', date)).toBe(true);
  });

  it('Sunday matches DOW=7', () => {
    // 2026-02-15 is a Sunday
    const date = new Date('2026-02-15T10:00:00Z');
    expect(isCronDue('0 10 * * 7', 'UTC', date)).toBe(true);
  });

  // ============================================
  // Timezone support
  // ============================================

  it('evaluates cron in the specified timezone', () => {
    // 2026-02-17T05:30:00Z => 2026-02-17T00:30:00 America/New_York (EST = UTC-5)
    const date = new Date('2026-02-17T05:30:00Z');
    expect(isCronDue('30 0 * * *', 'America/New_York', date)).toBe(true);
    expect(isCronDue('30 5 * * *', 'America/New_York', date)).toBe(false);
  });

  // ============================================
  // Invalid cron
  // ============================================

  it('returns false for too few fields and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isCronDue('30 14 * *', 'UTC', new Date())).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid cron expression'));
    warnSpy.mockRestore();
  });

  it('returns false for too many fields and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isCronDue('30 14 * * * *', 'UTC', new Date())).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid cron expression'));
    warnSpy.mockRestore();
  });

  it('returns false for empty string and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isCronDue('', 'UTC', new Date())).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid cron expression'));
    warnSpy.mockRestore();
  });

  // ============================================
  // Month field
  // ============================================

  it('matches month field correctly', () => {
    // 2026-02-17 → month=2
    const date = new Date('2026-02-17T10:00:00Z');
    expect(isCronDue('0 10 * 2 *', 'UTC', date)).toBe(true);
    expect(isCronDue('0 10 * 3 *', 'UTC', date)).toBe(false);
  });

  // ============================================
  // Complex combined expression
  // ============================================

  it('matches a complex expression with steps', () => {
    // Every 15 minutes, every 2 hours, every day
    const date = new Date('2026-02-17T04:30:00Z');
    expect(isCronDue('*/15 */2 * * *', 'UTC', date)).toBe(true);
    const date2 = new Date('2026-02-17T03:30:00Z');
    expect(isCronDue('*/15 */2 * * *', 'UTC', date2)).toBe(false);
  });
});
