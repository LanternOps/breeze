import { describe, expect, it } from 'vitest';
import { lineDescriptionProps } from './lineDescription';

const labels = { workedVsBilled: (w: string, b: string) => `worked ${w}h, billed ${b}h` };

describe('lineDescriptionProps (staff row)', () => {
  it('splits a named line into title + blurb', () => {
    const p = lineDescriptionProps({ name: ' Server build ', description: ' Final build:\n• Dell ' }, labels);
    expect(p.title).toBe('Server build');
    expect(p.blurb).toBe('Final build:\n• Dell');
    expect(p.note).toBeNull();
    expect(p.descriptor).toEqual([]);
    expect(p.qtyFold).toBeNull();
  });

  it('falls back to the description as the title for legacy unnamed lines, with no blurb', () => {
    const p = lineDescriptionProps({ name: null, description: 'Legacy line' }, labels);
    expect(p).toMatchObject({ title: 'Legacy line', blurb: null });
  });

  it('notes worked-vs-billed only when they differ', () => {
    const base = { name: 'Time', description: '', quantity: '1.00' };
    expect(lineDescriptionProps({ ...base, workedMinutes: 90 }, labels).note).toBe('worked 1.50h, billed 1.00h');
    expect(lineDescriptionProps({ ...base, workedMinutes: 60 }, labels).note).toBeNull();
    expect(lineDescriptionProps(base, labels).note).toBeNull();
  });

  it('formats a work date only when both a date and a locale are given', () => {
    const l = { name: 'Time', description: '', workDate: '2026-07-04' };
    expect(lineDescriptionProps(l, labels).workDate).toBeNull();
    expect(lineDescriptionProps(l, { ...labels, locale: 'en-US' }).workDate?.iso).toBe('2026-07-04');
  });

  it('passes ticket text through', () => {
    expect(lineDescriptionProps({ name: 'x', description: '', ticketText: 'Ticket #4' }, labels).ticketText).toBe('Ticket #4');
  });
});
