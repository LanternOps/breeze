import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fixtures from '../fixtures/cleanupRules.fixtures.json';
import {
  CLEANUP_GUARD_REJECTED_PREFIX,
  CLEANUP_RULES_VERSION,
  classifyCleanupPath,
  expandCleanupBraces,
  isCleanupDeniedRoot,
  matchCleanupComponentGlob,
  matchCleanupComponents,
  matchCleanupRule,
  normalizeCleanupPath,
  splitCleanupComponents,
  toCleanupOs,
  type CleanupOs,
} from './cleanupRules';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHARED_RULES_PATH = join(__dirname, 'cleanupRules.json');
// Amendment 1: go:embed cannot leave the agent module, so the table ships twice
// and the two copies are compared byte-for-byte from BOTH sides.
const AGENT_RULES_PATH = join(
  __dirname,
  '../../../../agent/internal/remote/tools/cleanup_rules.json',
);

describe('cleanup rule table (spec §6.1)', () => {
  it('pins the grammar: * is a within-component wildcard, ** is one-or-more components', () => {
    expect(matchCleanupComponentGlob('*', 'anything')).toBe(true);
    expect(matchCleanupComponentGlob('systemd-private-*', 'systemd-private-abc')).toBe(true);
    expect(matchCleanupComponentGlob('systemd-private-*', 'systemd-public-abc')).toBe(false);
    expect(matchCleanupComponentGlob('*.nupkg', 'foo.1.0.nupkg')).toBe(true);
    expect(matchCleanupComponentGlob('*.nupkg', 'foo.dll')).toBe(false);
    expect(matchCleanupComponentGlob('cache', 'cache')).toBe(true);
    expect(matchCleanupComponentGlob('cache', 'cache2')).toBe(false);

    expect(matchCleanupComponents(['tmp', '**'], ['tmp', 'a'])).toBe(true);
    expect(matchCleanupComponents(['tmp', '**'], ['tmp', 'a', 'b', 'c'])).toBe(true);
    // ** consumes at least one component, so the directory itself never matches.
    expect(matchCleanupComponents(['tmp', '**'], ['tmp'])).toBe(false);
    expect(matchCleanupComponents(['a', '**', '*.nupkg'], ['a', 'b', 'c', 'x.nupkg'])).toBe(true);
    expect(matchCleanupComponents(['a', '**', '*.nupkg'], ['a', 'b', 'c', 'x.dll'])).toBe(false);
  });

  it('expands brace alternation across component boundaries before splitting', () => {
    expect(expandCleanupBraces('a/{b,c}/d').sort()).toEqual(['a/b/d', 'a/c/d']);
    expect(expandCleanupBraces('a/{b/c,d}/e').sort()).toEqual(['a/b/c/e', 'a/d/e']);
    expect(expandCleanupBraces('{a,b}/{c,d}').sort()).toEqual(['a/c', 'a/d', 'b/c', 'b/d']);
    expect(expandCleanupBraces('plain/path')).toEqual(['plain/path']);
    expect(() => expandCleanupBraces('a/{b,{c,d}}/e')).toThrow(
      'nested brace alternation is not supported',
    );
  });

  it('normalizes Windows paths onto the <vol> anchor and POSIX paths as-is', () => {
    expect(normalizeCleanupPath('windows', 'C:\\Windows\\Temp\\A.TMP')).toBe('<vol>/windows/temp/a.tmp');
    expect(normalizeCleanupPath('windows', 'd:/Users//bob/')).toBe('<vol>/users/bob');
    expect(normalizeCleanupPath('windows', 'C:\\')).toBe('<vol>');
    expect(normalizeCleanupPath('darwin', '/')).toBe('/');
    // Per-OS normalisation (spec §13 row 10). Folding on POSIX changes identity.
    expect(normalizeCleanupPath('linux', '/TMP//a/')).toBe('/TMP/a');
    expect(normalizeCleanupPath('linux', '/tmp//a/')).toBe('/tmp/a');
    expect(normalizeCleanupPath('darwin', '/Users/Alice/Library/Caches')).toBe('/users/alice/library/caches');
    // darwin keeps a backslash as an ordinary filename character.
    expect(normalizeCleanupPath('darwin', '/Users/alice/.cache\\v')).toBe('/users/alice/.cache\\v');
    expect(splitCleanupComponents('<vol>/windows/temp')).toEqual(['<vol>', 'windows', 'temp']);
    expect(splitCleanupComponents('/tmp/a')).toEqual(['tmp', 'a']);
  });

  it('classifies every shared fixture case exactly as recorded', () => {
    expect(fixtures.cases.length).toBeGreaterThan(40);
    const now = new Date('2026-09-19T12:00:00Z');
    const failures: string[] = [];
    for (const c of fixtures.cases) {
      const modifiedAt = new Date(now.getTime() - c.ageHours * 3600_000);
      const got = classifyCleanupPath(c.os as CleanupOs, c.path, { modifiedAt, now });
      if (got.category !== c.category || got.granularity !== c.granularity) {
        failures.push(
          `${c.os} ${c.path}: expected ${c.category}/${c.granularity}, got ${got.category}/${got.granularity} (${c.note})`,
        );
      }
      expect(got.safe).toBe(c.category !== null);
    }
    expect(failures).toEqual([]);
  });

  it('applies the cleanup-denied roots from the shared fixture, root included', () => {
    expect(fixtures.deniedRoots.length).toBeGreaterThan(10);
    for (const c of fixtures.deniedRoots) {
      expect(`${c.os} ${c.path} -> ${isCleanupDeniedRoot(c.os as CleanupOs, c.path)}`).toBe(
        `${c.os} ${c.path} -> ${c.denied}`,
      );
    }
  });

  it('refuses a denied root even when a rule would otherwise match it', () => {
    // A hand-forged execute body aimed at a system directory that a sloppier
    // rule edit might one day make matchable. classify must still say no.
    expect(matchCleanupRule('linux', '/tmp/build.tmp')).not.toBeNull();
    expect(classifyCleanupPath('linux', '/etc/passwd').category).toBeNull();
    expect(classifyCleanupPath('windows', 'C:\\Windows\\System32\\config\\x').category).toBeNull();
  });

  it('maps device os_type values onto runtime.GOOS values', () => {
    expect(toCleanupOs('windows')).toBe('windows');
    expect(toCleanupOs('macos')).toBe('darwin');
    expect(toCleanupOs('darwin')).toBe('darwin');
    expect(toCleanupOs('linux')).toBe('linux');
    expect(toCleanupOs('freebsd')).toBeNull();
    expect(toCleanupOs(undefined)).toBeNull();
  });

  it('pins the guard rejection prefix the API parses', () => {
    expect(CLEANUP_GUARD_REJECTED_PREFIX).toBe('cleanup guard rejected:');
    expect(CLEANUP_RULES_VERSION).toBe(1);
  });

  it('is byte-identical to the copy the agent embeds', () => {
    const shared = readFileSync(SHARED_RULES_PATH);
    const agent = readFileSync(AGENT_RULES_PATH);
    expect(agent.equals(shared)).toBe(true);
  });
});
