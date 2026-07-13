import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSomeValidCveIds,
  isValidCveId,
  MIN_ENTRIES_FOR_RATIO_WARN,
  SKIP_ABSOLUTE_WARN_FLOOR,
  SKIP_RATIO_WARN_THRESHOLD,
  warnHighSkipRatio,
  warnMalformedCveIds,
} from './cveId';
import { captureMessage } from './sentry';

vi.mock('./sentry', () => ({
  captureMessage: vi.fn(),
}));

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

describe('warnHighSkipRatio', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(captureMessage).mockClear();
  });

  it('is a no-op when nothing was skipped', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnHighSkipRatio('Test', 0, 1000);
    expect(error).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('is a no-op when entryCount is zero', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnHighSkipRatio('Test', 5, 0);
    expect(error).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('stays quiet at exactly the threshold', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 1 of 100 = exactly SKIP_RATIO_WARN_THRESHOLD (1%)
    expect(SKIP_RATIO_WARN_THRESHOLD).toBe(0.01);
    warnHighSkipRatio('Test', 1, 100);
    expect(error).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('escalates above the threshold via console.error and a Sentry warning event', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnHighSkipRatio('Test', 20, 100);

    expect(error).toHaveBeenCalledTimes(1);
    const message = error.mock.calls[0]?.[0] as string;
    expect(message).toContain('[Test]');
    expect(message).toContain('20 of 100');
    expect(message).toContain('20.0%');
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(message, 'warning', {
      tag: 'Test',
      skippedCount: 20,
      entryCount: 100,
      ratio: 0.2,
      trigger: 'ratio',
    });
  });

  // The #2427 regression class: a huge absolute drop whose RATIO is tiny because
  // the feed is enormous. Ratio alone would stay silent on 5,000 missing CVEs.
  it('escalates on the absolute floor even when the ratio is far below threshold', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnHighSkipRatio('Test', 5_000, 1_000_000); // 0.5% — under the 1% ratio trigger

    expect(error).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(expect.any(String), 'warning', {
      tag: 'Test',
      skippedCount: 5_000,
      entryCount: 1_000_000,
      ratio: 0.005,
      trigger: 'absolute_floor',
    });
  });

  it('escalates at exactly the absolute floor', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(SKIP_ABSOLUTE_WARN_FLOOR).toBe(100);
    warnHighSkipRatio('Test', SKIP_ABSOLUTE_WARN_FLOOR, 1_000_000);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('does not let a tiny feed page anyone on ratio alone (below the min-entries guard)', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(MIN_ENTRIES_FOR_RATIO_WARN).toBe(50);
    // 1 of 3 = 33%, but 3 entries is statistically meaningless.
    warnHighSkipRatio('Test', 1, 3);
    expect(error).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
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
