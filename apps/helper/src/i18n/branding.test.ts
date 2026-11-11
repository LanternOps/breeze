// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { applyBrandingColors, sanitizeBranding } from './branding';

afterEach(() => {
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
});

describe('sanitizeBranding', () => {
  it('keeps valid known fields and nothing else', () => {
    expect(
      sanitizeBranding({
        displayName: 'Example Assist',
        companyName: 'Example IT',
        welcomeTitle: 'Hello',
        welcomeMessage: 'Welcome',
        supportLabel: 'Get help',
        portalLabel: 'Portal',
        primaryColor: '#336699',
        accentColor: '#aabbcc',
        logoUrl: 'https://evil.example/x.png',
        css: 'body{display:none}',
      }),
    ).toEqual({
      displayName: 'Example Assist',
      companyName: 'Example IT',
      welcomeTitle: 'Hello',
      welcomeMessage: 'Welcome',
      supportLabel: 'Get help',
      portalLabel: 'Portal',
      primaryColor: '#336699',
      accentColor: '#aabbcc',
    });
  });

  it('drops invalid values field by field', () => {
    const out = sanitizeBranding({
      displayName: 'x'.repeat(61),
      companyName: 'a\nb',
      welcomeTitle: 'spoof‮',
      supportLabel: 'ok',
      primaryColor: 'red',
      accentColor: '#abc',
    });
    expect(out).toEqual({ supportLabel: 'ok' });
  });

  it('counts code points and allows ZWJ', () => {
    expect(sanitizeBranding({ displayName: '😀'.repeat(60) }).displayName).toHaveLength(120);
    expect(sanitizeBranding({ displayName: '😀'.repeat(61) }).displayName).toBeUndefined();
    expect(sanitizeBranding({ displayName: 'a‍b' }).displayName).toBe('a‍b');
  });

  it.each([null, undefined, 'x', 3, []])('%s is no branding', (raw) => {
    expect(sanitizeBranding(raw)).toEqual({});
  });
});

describe('applyBrandingColors', () => {
  const style = () => document.documentElement.style;

  it('sets semantic CSS variables from a readable colour', () => {
    applyBrandingColors({ primaryColor: '#1F3A93', accentColor: '#7A1F5C' });
    expect(style().getPropertyValue('--ws-accent')).toBe('#1F3A93');
    expect(style().getPropertyValue('--ws-accent-contrast')).toBe('#FFFFFF');
    expect(style().getPropertyValue('--ws-brand-accent')).toBe('#7A1F5C');
  });

  it('does not apply an unreadable colour, and no branding sets nothing (Breeze palette)', () => {
    applyBrandingColors({ primaryColor: '#F7F7F7' });
    expect(style().getPropertyValue('--ws-accent')).toBe('');
    applyBrandingColors({});
    expect(document.documentElement.getAttribute('style') ?? '').toBe('');
  });

  it('clears colours a previous branding set', () => {
    applyBrandingColors({ primaryColor: '#1F3A93' });
    applyBrandingColors({});
    expect(style().getPropertyValue('--ws-accent')).toBe('');
  });
});
