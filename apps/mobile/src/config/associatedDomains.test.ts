import { describe, expect, it } from 'vitest';

import { resolveAssociatedDomains } from './associatedDomains';

const HOSTED = ['webcredentials:us.2breeze.app', 'webcredentials:eu.2breeze.app'];

describe('resolveAssociatedDomains', () => {
  describe('the published build is untouched', () => {
    it('returns the base list verbatim when nothing is configured', () => {
      for (const raw of [undefined, null, '', '   ']) {
        const result = resolveAssociatedDomains(HOSTED, raw);
        expect(result).toEqual(HOSTED);
      }
    });

    it('does not mutate or dedupe the caller list', () => {
      // Even a base list with a duplicate comes back exactly as given; this is
      // app.json's business, not ours, and quietly rewriting it would mean the
      // shipped entitlement no longer matches the file.
      const base = ['webcredentials:a.example.com', 'webcredentials:a.example.com'];
      const result = resolveAssociatedDomains(base, undefined);
      expect(result).toEqual(base);
      expect(result).not.toBe(base);
    });

    it('keeps the hosted regions first when adding', () => {
      const result = resolveAssociatedDomains(HOSTED, 'breeze.example.com');
      expect(result.slice(0, 2)).toEqual(HOSTED);
      expect(result).toHaveLength(3);
    });
  });

  describe('accepted input', () => {
    it('prefixes a bare hostname', () => {
      expect(resolveAssociatedDomains([], 'breeze.example.com')).toEqual([
        'webcredentials:breeze.example.com',
      ]);
    });

    it('accepts comma and whitespace separators', () => {
      const expected = ['webcredentials:a.example.com', 'webcredentials:b.example.com'];
      expect(resolveAssociatedDomains([], 'a.example.com,b.example.com')).toEqual(expected);
      expect(resolveAssociatedDomains([], 'a.example.com b.example.com')).toEqual(expected);
      expect(resolveAssociatedDomains([], ' a.example.com,  b.example.com ')).toEqual(expected);
    });

    // Semicolon is legal inside a URL path, so treating it as a separator
    // would reject a valid pasted URL.
    it('does not split on a semicolon inside a URL', () => {
      expect(resolveAssociatedDomains([], 'https://breeze.example.com/login;a=1')).toEqual([
        'webcredentials:breeze.example.com',
      ]);
    });

    it('extracts the host from a pasted URL', () => {
      for (const input of [
        'https://breeze.example.com',
        'https://breeze.example.com/',
        'https://breeze.example.com/login?next=/x#frag',
        'https://breeze.example.com:8443/login',
        'https://user:pw@breeze.example.com/path',
      ]) {
        expect(resolveAssociatedDomains([], input)).toEqual([
          'webcredentials:breeze.example.com',
        ]);
      }
    });

    it('lowercases, drops a trailing dot, and de-duplicates against the base', () => {
      expect(resolveAssociatedDomains(HOSTED, 'US.2Breeze.app')).toEqual(HOSTED);
      expect(resolveAssociatedDomains([], 'breeze.example.com.')).toEqual([
        'webcredentials:breeze.example.com',
      ]);
      expect(
        resolveAssociatedDomains([], 'breeze.example.com, BREEZE.EXAMPLE.COM')
      ).toEqual(['webcredentials:breeze.example.com']);
    });

    it('accepts a punycode host', () => {
      expect(resolveAssociatedDomains([], 'xn--bcher-kva.example.com')).toEqual([
        'webcredentials:xn--bcher-kva.example.com',
      ]);
    });

    // An internationalised domain must punycode identically whether it arrives
    // bare or as a URL; rejecting one and accepting the other is a trap.
    it('punycodes an internationalised domain consistently', () => {
      const expected = ['webcredentials:xn--bcher-kva.example.com'];
      expect(resolveAssociatedDomains([], 'b\u00fccher.example.com')).toEqual(expected);
      expect(resolveAssociatedDomains([], 'https://b\u00fccher.example.com')).toEqual(expected);
    });
  });

  // Silently skipping a bad entry would let the build succeed with the domain
  // missing from the entitlement, which surfaces much later as "autofill just
  // doesn't work". Failing the config evaluation is the kinder outcome.
  describe('rejected input throws rather than disappearing', () => {
    const bad: Array<[string, string]> = [
      ['localhost', 'not fully qualified'],
      ['example', 'no dot'],
      ['*.example.com', 'wildcard'],
      ['.example.com', 'leading dot / empty label'],
      ['example..com', 'empty inner label'],
      ['-example.com', 'leading hyphen'],
      ['example-.com', 'trailing hyphen'],
      ['foo_bar.example.com', 'underscore'],
      ['192.168.1.10', 'IPv4 address'],
      ['breeze.example.com:8443', 'bare host with a port'],
      ['applinks:example.com', 'service prefix not accepted'],
      ['example.com?mode=developer', 'query suffix not supported'],
      ['https://', 'no host'],
      [`${'a'.repeat(64)}.example.com`, 'label too long'],
      [`${'a'.repeat(60)}.`.repeat(5) + 'example.com', 'hostname too long'],
    ];

    for (const [input, why] of bad) {
      it(`rejects ${why}: ${input.slice(0, 40)}`, () => {
        expect(() => resolveAssociatedDomains(HOSTED, input)).toThrow(
          /BREEZE_ASSOCIATED_DOMAINS/
        );
      });
    }

    it('names the offending entry in the message', () => {
      expect(() => resolveAssociatedDomains([], '*.example.com')).toThrow(/\*\.example\.com/);
    });

    it('rejects the whole value if any entry is bad', () => {
      expect(() =>
        resolveAssociatedDomains(HOSTED, 'good.example.com, *.bad.example.com')
      ).toThrow(/BREEZE_ASSOCIATED_DOMAINS/);
    });
  });

  it('handles a missing base list', () => {
    expect(resolveAssociatedDomains(undefined, 'breeze.example.com')).toEqual([
      'webcredentials:breeze.example.com',
    ]);
    expect(resolveAssociatedDomains(undefined, undefined)).toEqual([]);
  });
});
