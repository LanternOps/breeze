import { describe, it, expect } from 'vitest';
import { parseVerifyArgs, summarize } from './verify-acceptance-hashes.lib';

describe('parseVerifyArgs', () => {
  it('defaults limit to 50', () => expect(parseVerifyArgs([]).limit).toBe(50));
  it('reads --limit and clamps to 5000', () => expect(parseVerifyArgs(['--limit', '9999']).limit).toBe(5000));
  it('rejects a non-uuid --org-id', () => expect(() => parseVerifyArgs(['--org-id', 'nope'])).toThrow(/org-id/));
  it('rejects a non-positive or non-numeric --limit', () => {
    expect(() => parseVerifyArgs(['--limit', '0'])).toThrow(/limit/);
    expect(() => parseVerifyArgs(['--limit', 'abc'])).toThrow(/limit/);
    expect(() => parseVerifyArgs(['--limit'])).toThrow(/limit/);
  });
  it('rejects unknown flags, the --flag=value form, stray positionals and lenient numbers', () => {
    expect(() => parseVerifyArgs(['--limt', '500'])).toThrow(/unknown argument/);
    expect(() => parseVerifyArgs(['--limit=500'])).toThrow(/unknown argument/);
    expect(() => parseVerifyArgs(['100'])).toThrow(/unknown argument/);
    expect(() => parseVerifyArgs(['--limit', '0x10'])).toThrow(/limit/);
    expect(() => parseVerifyArgs(['--limit', '1e2'])).toThrow(/limit/);
  });
  it('reads --partner-id and --since, rejecting a malformed date', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(parseVerifyArgs(['--partner-id', id, '--since', '2026-10-01'])).toEqual({ limit: 50, partnerId: id, since: '2026-10-01' });
    expect(() => parseVerifyArgs(['--since', 'yesterday'])).toThrow(/since/);
    expect(() => parseVerifyArgs(['--partner-id', 'x'])).toThrow(/partner-id/);
  });
});

describe('summarize', () => {
  it('exit 1 on any mismatch', () =>
    expect(summarize([{ acceptanceId: 'a', quoteId: 'q', hashVersion: 2, renderLocale: 'en', matches: false }]).exitCode).toBe(1));
  it('exit 2 on errors without mismatches', () =>
    expect(summarize([{ acceptanceId: 'a', quoteId: 'q', hashVersion: 2, renderLocale: 'en', matches: true, error: 'Quote not found' }]).exitCode).toBe(2));
  it('exit 0 when everything matches', () =>
    expect(summarize([{ acceptanceId: 'a', quoteId: 'q', hashVersion: 1, renderLocale: 'en', matches: true }]).exitCode).toBe(0));
  it('exit 0 with nothing checked', () => expect(summarize([])).toEqual({ checked: 0, matches: 0, mismatches: 0, errors: 0, exitCode: 0 }));
  it('counts matches, mismatches and errors separately (an errored row is never a match)', () =>
    expect(summarize([
      { acceptanceId: 'a', quoteId: 'q', hashVersion: 1, renderLocale: 'en', matches: true },
      { acceptanceId: 'b', quoteId: 'q', hashVersion: 2, renderLocale: 'fr-FR', matches: false },
      { acceptanceId: 'c', quoteId: 'q', hashVersion: 2, renderLocale: 'en', matches: false, error: 'boom' },
    ])).toEqual({ checked: 3, matches: 1, mismatches: 1, errors: 1, exitCode: 1 }));
});
