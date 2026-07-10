import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSomeValidCveIds, isValidCveId, warnMalformedCveIds } from './cveId';

describe('isValidCveId', () => {
  it.each([
    'CVE-2023-38039',
    'CVE-1999-0001',
    'CVE-2024-123456789',
    // exactly 32 chars — the varchar(32) boundary
    `CVE-2023-${'1'.repeat(23)}`,
  ])('accepts canonical id %s', (id) => {
    expect(isValidCveId(id)).toBe(true);
  });

  it('rejects the malformed Mariner record that broke the MSRC sync (#2261)', () => {
    expect(isValidCveId('CVE-2023-38039 mariner - do not use this one')).toBe(false);
  });

  it.each([
    ['empty string', ''],
    ['missing prefix', '2023-38039'],
    ['lowercase prefix', 'cve-2023-38039'],
    ['too few sequence digits', 'CVE-2023-123'],
    ['non-numeric year', 'CVE-20XX-38039'],
    ['trailing text', 'CVE-2023-38039-extra'],
    ['leading whitespace', ' CVE-2023-38039'],
    ['trailing whitespace', 'CVE-2023-38039 '],
    ['longer than varchar(32)', `CVE-2023-${'9'.repeat(30)}`],
  ])('rejects %s', (_label, id) => {
    expect(isValidCveId(id)).toBe(false);
  });
});

describe('warnMalformedCveIds', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a no-op when nothing was skipped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnMalformedCveIds('Test', new Set());
    expect(warn).not.toHaveBeenCalled();
  });

  it('emits a single warning carrying the count and offending ids', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnMalformedCveIds('Test', new Set(['CVE-2023-38039 mariner - do not use this one']));

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('[Test]');
    expect(message).toContain('Skipped 1 distinct malformed CVE id(s)');
    expect(message).toContain('CVE-2023-38039 mariner - do not use this one');
  });

  it('truncates the sample list for large skip sets', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ids = new Set(Array.from({ length: 15 }, (_, i) => `bad-id-${i}`));
    warnMalformedCveIds('Test', ids);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('Skipped 15 distinct malformed CVE id(s)');
    expect(message).toContain('+5 more');
  });
});

describe('assertSomeValidCveIds', () => {
  it('does nothing for an empty feed', () => {
    expect(() =>
      assertSomeValidCveIds({ tag: 'Test', entryCount: 0, validCount: 0, malformedIds: new Set() })
    ).not.toThrow();
  });

  it('does nothing when at least one id is valid', () => {
    expect(() =>
      assertSomeValidCveIds({ tag: 'Test', entryCount: 2, validCount: 1, malformedIds: new Set(['garbage']) })
    ).not.toThrow();
  });

  it('throws when every entry has a malformed id (probable feed format change)', () => {
    expect(() =>
      assertSomeValidCveIds({ tag: 'Test', entryCount: 2, validCount: 0, malformedIds: new Set(['a', 'b']) })
    ).toThrow(/probable upstream feed format change/);
  });

  it('throws when every entry is missing its id', () => {
    expect(() =>
      assertSomeValidCveIds({ tag: 'Test', entryCount: 3, validCount: 0, malformedIds: new Set() })
    ).toThrow(/3 vulnerability entries but zero valid CVE ids/);
  });
});
