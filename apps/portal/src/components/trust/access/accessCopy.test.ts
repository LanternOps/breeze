import { describe, expect, it, vi, afterEach } from 'vitest';
import { SUPPORTED_LOCALES } from '@breeze/shared';
import { copyParityProblems } from '../trustCopy';
import { accessCopy, detectAccessLocale } from './accessCopy';

describe('accessCopy', () => {
  it('has full parity across all locales', () => {
    expect(copyParityProblems(accessCopy)).toEqual([]);
  });
  it('translates every non-English locale (no all-English locale)', () => {
    for (const l of SUPPORTED_LOCALES) {
      if (l === 'en') continue;
      expect(accessCopy[l].submit, l).not.toBe(accessCopy.en.submit);
      expect(accessCopy[l].invalid, l).not.toBe(accessCopy.en.invalid);
    }
    expect(accessCopy['fr-CA']).not.toEqual(accessCopy['fr-FR']);
  });
  it('interpolates functions', () => {
    expect(accessCopy.en.verified('Acme')).toBe('Request confirmed. Acme will review it.');
    expect(accessCopy.en.expires('Oct 1')).toBe('This link works until Oct 1.');
  });
});

describe('detectAccessLocale', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('picks the first exact supported match', () => {
    vi.stubGlobal('navigator', { languages: ['ja', 'de-DE', 'fr-FR'] });
    expect(detectAccessLocale()).toBe('de-DE');
  });
  it('falls back to en', () => {
    vi.stubGlobal('navigator', { languages: ['ja', 'de'] });
    expect(detectAccessLocale()).toBe('en');
  });
});
