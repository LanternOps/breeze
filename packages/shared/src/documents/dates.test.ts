import { describe, it, expect } from 'vitest';
import { documentDate } from './dates';

describe('documentDate', () => {
  it('a calendar date never shifts by timezone', () => {
    expect(documentDate('2026-03-01', 'en')).toEqual({ text: 'Mar 01, 2026', iso: '2026-03-01' });
    expect(documentDate('2026-03-01', 'pt-BR').text).toBe(
      new Intl.DateTimeFormat('pt-BR', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' })
        .format(new Date('2026-03-01T00:00:00Z')),
    );
  });

  it('keeps a non-calendar value as-is instead of throwing', () => {
    expect(documentDate('not-a-date', 'en')).toEqual({ text: 'not-a-date', iso: 'not-a-date' });
  });

  it('an unknown locale falls back to English rather than throwing', () => {
    expect(documentDate('2026-03-01', 'xx-invalid-@@').text).toBe('Mar 01, 2026');
  });
});
