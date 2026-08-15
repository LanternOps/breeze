import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Contract test for the terminal `device_commands` payload erasure (#3409 PR4a).
 *
 * `device_commands` is deliberately system-scoped (no RLS) with unbounded
 * retention, and several command types carry credential material in their
 * payload — FileVault rotation's `password`/`currentRecoveryKey`, and the PR4
 * script secret envelope. Every writer that drives a command to a TERMINAL
 * state must therefore strip those keys in the same statement.
 *
 * This is a static grep-shaped guard rather than a behavioural test because
 * the failure mode is a NEW call site, not a regression in an existing one:
 * before PR4a, ten of eleven terminal writers retained the payload and code
 * review had never flagged it. The same reasoning as the tenant-cascade list
 * contract tests — mechanical coverage beats judgement here.
 */

// Derived from the vitest root (apps/api), not __dirname: the config's own
// __dirname handling differs between the native and legacy config loaders.
const API_SRC = path.resolve(process.cwd(), 'src');
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'timeout'];

/**
 * Extract the object literal passed to each `.set({...})` that follows an
 * `.update(deviceCommands)` in `source`. Brace-matched rather than a fixed
 * character window so a long `.where(...)` clause below can never be mistaken
 * for part of the update's SET list.
 */
function setClausesForDeviceCommands(source: string): string[] {
  const clauses: string[] = [];
  for (const segment of source.split('.update(deviceCommands)').slice(1)) {
    const setAt = segment.indexOf('.set({');
    if (setAt === -1) continue;
    // A `.set(` further away than the next `.update(` belongs to that one.
    const nextUpdate = segment.indexOf('.update(');
    if (nextUpdate !== -1 && nextUpdate < setAt) continue;

    let depth = 0;
    let end = -1;
    for (let i = setAt + '.set('.length; i < segment.length; i++) {
      const char = segment[i];
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end !== -1) clauses.push(segment.slice(setAt, end + 1));
  }
  return clauses;
}

let cachedMatches: string[] | null = null;

/**
 * Walks apps/api/src once and memoizes: the scan reads ~1400 files, which is
 * sub-second warm but several seconds cold — and much worse when the full suite
 * has eight workers competing for the same disk. Hence the generous per-test
 * timeout below; the work itself is trivial.
 */
function filesUpdatingDeviceCommands(): string[] {
  if (cachedMatches) return cachedMatches;
  const matches: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
        if (readFileSync(full, 'utf8').includes('update(deviceCommands)')) {
          matches.push(full);
        }
      }
    }
  };
  walk(API_SRC);
  cachedMatches = matches;
  return matches;
}

describe('terminal device_commands payload erasure coverage', () => {
  it('finds the known call sites (guard against a silently empty scan)', () => {
    const files = filesUpdatingDeviceCommands();
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(
      files.some((file) => file.endsWith(path.join('routes', 'agentWs.ts'))),
    ).toBe(true);
  }, 120_000);

  it('erases sensitive payload keys at every terminal writer', () => {
    const offenders: string[] = [];
    for (const file of filesUpdatingDeviceCommands()) {
      for (const clause of setClausesForDeviceCommands(readFileSync(file, 'utf8'))) {
        const setsTerminal = TERMINAL_STATUSES.some(
          (status) => clause.includes(`'${status}'`) || clause.includes(`"${status}"`),
        );
        if (setsTerminal && !clause.includes('terminalPayloadErasureSet()')) {
          offenders.push(
            `${path.relative(API_SRC, file)}: ${clause.slice(0, 140).replace(/\s+/g, ' ')}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  }, 120_000);
});
