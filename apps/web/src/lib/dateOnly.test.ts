import { describe, expect, it } from 'vitest';
import { formatDateOnly, parseDateOnly } from './dateOnly';

describe('dateOnly (TZ=America/Denver)', () => {
  it('keeps a bare YYYY-MM-DD on its own calendar day', () => {
    process.env.TZ = 'America/Denver';
    const d = parseDateOnly('2026-10-14');
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 9, 14]);
    expect(formatDateOnly('2026-10-14')).toBe(new Date(2026, 9, 14).toLocaleDateString());
  });
  it('passes full timestamps through and returns garbage unchanged', () => {
    expect(parseDateOnly('2026-10-14T12:00:00.000Z').toISOString()).toBe('2026-10-14T12:00:00.000Z');
    expect(formatDateOnly('garbage')).toBe('garbage');
  });
});
