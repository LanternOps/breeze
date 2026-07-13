import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeExclusionPattern,
  normalizeExclusionPattern,
  compileExcludeMatcher,
  sanitizeExclusionPatterns,
  isUsableExclusionPattern,
  goPathMatch,
  MAX_EXCLUSION_PATTERN_LENGTH,
} from './backupExclusionGlob';

// ─────────────────────────────────────────────────────────────────────────────
// The TS half of the cross-language contract (issue #2473).
//
// The Go half — agent/internal/backup/exclude_contract_test.go — replays this
// SAME fixture file against the real agent matcher. Keeping both green is what
// makes it safe for the API to reject a glob on the agent's behalf.
//
// If a case here fails, the port has drifted from the agent. Fix the port, not
// the fixture.
// ─────────────────────────────────────────────────────────────────────────────

interface ValidityCase {
  pattern: string;
  usable: boolean;
  problem: 'empty' | 'syntax' | null;
  note: string;
  divergence?: string;
}

interface MatchingCase {
  patterns: string[];
  relPath: string;
  caseInsensitive: boolean;
  expected: boolean;
  note: string;
  divergence?: string;
}

interface PortLimitationCase {
  patterns: string[];
  relPath: string;
  caseInsensitive: boolean;
  go: boolean;
  tsPort: boolean;
  note: string;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/backup-exclusion-contract.json'), 'utf8'),
) as {
  validity: ValidityCase[];
  matching: MatchingCase[];
  matcherPortLimitations: PortLimitationCase[];
};

describe('backup exclusion glob — cross-language contract', () => {
  it('the fixture is not empty (a vacuous contract test is worse than none)', () => {
    expect(fixture.validity.length).toBeGreaterThan(20);
    expect(fixture.matching.length).toBeGreaterThan(20);
  });

  describe('validity — does the agent compile this pattern, or silently drop it?', () => {
    it.each(fixture.validity)('$pattern → usable=$usable ($note)', (tc) => {
      const verdict = describeExclusionPattern(tc.pattern);
      expect(verdict.usable).toBe(tc.usable);
      expect(verdict.problem ?? null).toBe(tc.problem);
      // Every rejection must carry an explanation — a bare "invalid" is what
      // this issue exists to eliminate.
      if (!verdict.usable) {
        expect(verdict.message).toBeTruthy();
      }
    });
  });

  describe('matching — semantics, not just validity', () => {
    it.each(fixture.matching)('$patterns vs $relPath → $expected ($note)', (tc) => {
      const matcher = compileExcludeMatcher(tc.patterns, tc.caseInsensitive);
      // A null matcher is the agent's nil matcher: "exclude nothing".
      const got = matcher?.matches(tc.relPath) ?? false;
      expect(got).toBe(tc.expected);
    });
  });

  describe('KNOWN matcher-port limitations (deliberate, documented)', () => {
    // The TS matcher is code-point based; Go's path.Match advances the name by
    // BYTES and lowercases with simple (not full Unicode) mapping. These cases
    // pin exactly where the port disagrees, so the boundary cannot silently
    // widen — and so nobody mistakes the matcher for exact.
    //
    // The Go suite asserts the other half (that the agent really behaves this
    // way). If the port is ever made byte-faithful, these move into matching[].
    //
    // This is a limitation of the MATCHER only. describeExclusionPattern — the
    // validator that actually gates an API save — is exhaustively exact.
    it.each(fixture.matcherPortLimitations)('$relPath — $note', (tc) => {
      const matcher = compileExcludeMatcher(tc.patterns, tc.caseInsensitive);
      const got = matcher?.matches(tc.relPath) ?? false;
      expect(got).toBe(tc.tsPort);
      expect(tc.tsPort).not.toBe(tc.go); // must genuinely still be a divergence
    });

    it('is not empty (if the port became exact, fold these into matching[])', () => {
      expect(fixture.matcherPortLimitations.length).toBeGreaterThan(0);
    });
  });

  it('covers the dialect divergences that motivated the contract', () => {
    // Guards against someone quietly deleting the interesting cases and leaving
    // a contract that only pins the boring ones.
    const divergences = [...fixture.validity, ...fixture.matching].filter((c) => c.divergence);
    expect(divergences.length).toBeGreaterThanOrEqual(10);
  });
});

describe('normalizeExclusionPattern', () => {
  it('folds Windows separators BEFORE trimming, so a trailing backslash is not an escape', () => {
    // Raw path.Match would call "temp\\" a trailing-escape syntax error.
    expect(normalizeExclusionPattern('temp\\')).toBe('temp');
    expect(normalizeExclusionPattern('AppData\\Local\\Temp')).toBe('AppData/Local/Temp');
  });

  it('trims whitespace and leading/trailing separators', () => {
    expect(normalizeExclusionPattern('  /var/log/  ')).toBe('var/log');
    expect(normalizeExclusionPattern('///')).toBe('');
  });

  it('never treats a backslash as an escape character', () => {
    // The single most likely way a naive port diverges.
    expect(normalizeExclusionPattern('foo\\*bar')).toBe('foo/*bar');
  });
});

describe('describeExclusionPattern — conservative by design', () => {
  it('accepts patterns that are merely unusual', () => {
    // Over-strict validation breaks a working policy save. These are all legal
    // to the agent, so they must be legal to us.
    for (const p of ['[z-a]', '[!a-z].txt', '***', 'abc]', ']abc', '[α-ω].txt', '?']) {
      expect(isUsableExclusionPattern(p), `${p} should be accepted`).toBe(true);
    }
  });

  it('rejects the trailing-dash character class with an actionable message', () => {
    // The headline case: valid in bash/minimatch, ErrBadPattern in Go.
    const v = describeExclusionPattern('[a-z0-9_-].log');
    expect(v.usable).toBe(false);
    expect(v.problem).toBe('syntax');
    expect(v.message).toMatch(/-/);
    expect(v.message).toMatch(/class/i);
  });

  it('rejects an unclosed character class with an actionable message', () => {
    const v = describeExclusionPattern('logs/[a-');
    expect(v.usable).toBe(false);
    expect(v.problem).toBe('syntax');
    expect(v.message).toMatch(/unclosed/i);
  });

  it('rejects a class split across a separator (per-segment validation)', () => {
    // Legal as one glob string; malformed once split on '/'. A whole-string
    // validator would wrongly accept this.
    expect(describeExclusionPattern('a[x/y]b').usable).toBe(false);
  });

  it('rejects an empty interior segment', () => {
    expect(describeExclusionPattern('a//b').problem).toBe('syntax');
  });

  it('flags blank patterns as empty, not as a syntax error', () => {
    // The API strips these rather than failing the save.
    expect(describeExclusionPattern('   ').problem).toBe('empty');
    expect(describeExclusionPattern('/').problem).toBe('empty');
  });

  it('enforces a length ceiling (API-only guard; the agent has none)', () => {
    const long = `${'a'.repeat(MAX_EXCLUSION_PATTERN_LENGTH + 1)}`;
    const v = describeExclusionPattern(long);
    expect(v.usable).toBe(false);
    expect(v.problem).toBe('too_long');
    // Exactly at the limit is fine.
    expect(isUsableExclusionPattern('a'.repeat(MAX_EXCLUSION_PATTERN_LENGTH))).toBe(true);
  });
});

describe('sanitizeExclusionPatterns', () => {
  it('drops blank lines (a textarea artifact) without touching real patterns', () => {
    expect(sanitizeExclusionPatterns(['*.tmp', '', '  ', '\\', 'node_modules/**'])).toEqual([
      '*.tmp',
      'node_modules/**',
    ]);
  });

  it('trims, but does NOT otherwise rewrite what the user typed', () => {
    // Trimming is lossless (the agent trims too). Folding '\\' to '/' would not
    // be: it would visibly change the pattern on round-trip.
    expect(sanitizeExclusionPatterns(['  AppData\\Local  '])).toEqual(['AppData\\Local']);
  });
});

describe('goPathMatch — the ported Go primitive', () => {
  it('reports ErrBadPattern independently of the name being matched', () => {
    // This is the Go 1.16 property the whole validator leans on: it lets us
    // probe validity with a dummy name.
    for (const name of ['probe', '', 'a', 'zzz', 'anything.txt']) {
      expect(goPathMatch('[a-', name).bad, `name=${name}`).toBe(true);
      expect(goPathMatch('*.tmp', name).bad, `name=${name}`).toBe(false);
    }
  });

  it('does not let * cross a separator', () => {
    expect(goPathMatch('a*c', 'a/c').matched).toBe(false);
  });

  it('does not reject an inverted range', () => {
    expect(goPathMatch('[z-a]', 'm')).toEqual({ matched: false, bad: false });
  });
});
