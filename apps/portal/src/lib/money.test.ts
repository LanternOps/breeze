// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { money, portalLocale } from './money';

describe('portal money()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
  });

  it('formats with the shared formatter under the jsdom en-US locale', () => {
    expect(navigator.language).toBe('en-US');
    expect(money('1234.5', 'USD')).toBe('$1,234.50');
    expect(money('1000', 'JPY')).toBe('¥1,000');
  });

  it('falls back to "12.00 CODE" for an unknown currency code instead of throwing', () => {
    expect(money('12', 'ZZ1')).toBe('12.00 ZZ1');
  });

  it('treats a null amount as zero and a missing currency as USD', () => {
    expect(money(null, 'EUR')).toBe('€0.00');
    expect(money(undefined, 'USD')).toBe('$0.00');
    expect(money('5', null)).toBe('$5.00');
    expect(money('5', '')).toBe('$5.00');
  });

  it('uses the browser locale (navigator.language)', () => {
    Object.defineProperty(navigator, 'language', { value: 'de-DE', configurable: true });
    expect(portalLocale()).toBe('de-DE');
    expect(money('1234.5', 'EUR')).toBe('1.234,50\u00a0€');
  });

  it('is SSR-safe: no navigator → "en" without throwing', () => {
    vi.stubGlobal('navigator', undefined);
    expect(portalLocale()).toBe('en');
    expect(() => money('1234.5', 'USD')).not.toThrow();
    expect(money('1234.5', 'USD')).toBe('$1,234.50');
  });
});
