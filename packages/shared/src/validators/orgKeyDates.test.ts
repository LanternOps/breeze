import { describe, expect, it } from 'vitest';
import { createKeyDateSchema, updateKeyDateSchema } from './orgKeyDates';

describe('orgKeyDates validators', () => {
  it('accepts a renewal with reminder', () => {
    const r = createKeyDateSchema.parse({
      label: 'Cyber insurance renewal',
      kind: 'insurance_renewal',
      date: '2027-03-01',
      recursAnnually: true,
      remindDaysBefore: 60,
    });
    expect(r.portalVisible).toBe(false);
  });
  it('rejects negative reminder days and bad dates', () => {
    expect(createKeyDateSchema.safeParse({ label: 'x', date: '2027-03-01', remindDaysBefore: -1 }).success).toBe(false);
    expect(createKeyDateSchema.safeParse({ label: 'x', date: 'March 1' }).success).toBe(false);
  });
  it('update is partial', () => expect(updateKeyDateSchema.parse({ notes: 'renewed' })).toEqual({ notes: 'renewed' }));
  it('update is strict', () => expect(updateKeyDateSchema.safeParse({ bogus: 1 }).success).toBe(false));
});
