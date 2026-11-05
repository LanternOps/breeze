/**
 * CONTRACT — Wisp delivery has one funnel (w00 A18; W06 plan Task 4).
 *
 *   - `createNotification(` appears under services/wisp/ ONLY in deliver.ts,
 *     and nowhere under services/aiAgents/.
 *   - `notifyUser(` (the nudge primitive: quiet hours, prefs, backoff, push)
 *     is called only by the four nudge producers below.
 *   - `deliverInApp(` is called only by notifyUser and W05's non-nudge notices
 *     (budget exhausted, orphaned watches, deterministic digest).
 *
 * Plain unit test over the source tree (comments stripped, tests excluded).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const SRC = resolve(import.meta.dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const FILES = walk(SRC).map((f) => ({ rel: relative(SRC, f), code: stripComments(readFileSync(f, 'utf8')) }));

/** Files that CALL `name(` (a declaration `function name(` does not count). */
function callers(name: string): string[] {
  const call = new RegExp(`(?<!function\\s)\\b${name}\\(`);
  return FILES.filter((f) => call.test(f.code)).map((f) => f.rel).sort();
}

describe('Wisp delivery funnel (w00 A18)', () => {
  it('createNotification is called under services/wisp/ only from deliver.ts, and never from the Wisp assessment path', () => {
    const sites = callers('createNotification');
    expect(sites.filter((f) => f.startsWith('services/wisp/'))).toEqual(['services/wisp/deliver.ts']);
    // Non-Wisp agent features (circuit breaker, fix watch, …) notify directly;
    // the Wisp assessment files never do.
    expect(sites.filter((f) => /^services\/aiAgents\/assessment/.test(f))).toEqual([]);
  });

  it('notifyUser is called only by the nudge producers', () => {
    const allowed = new Set([
      'services/aiAgents/assessmentFinalizer.ts', // the assessment `nudge` step (W05b's site; the plan said runFinalizers.ts)
      'services/wisp/incidentCorrelator.ts', // partner-level incident nudges (w00 reconciliation 9)
      'services/wisp/nudgeDigest.ts', // the 15-minute digest
      'services/wisp/brief.ts', // the morning brief (A28)
    ]);
    const sites = callers('notifyUser');
    expect(sites.filter((f) => !allowed.has(f))).toEqual([]);
    expect(sites).toContain('services/aiAgents/assessmentFinalizer.ts');
    expect(sites).toContain('services/wisp/incidentCorrelator.ts');
  });

  it('deliverInApp is called only by notifyUser and the non-nudge notices', () => {
    expect(callers('deliverInApp')).toEqual([
      'services/wisp/assessment.ts',
      'services/wisp/budget.ts',
      'services/wisp/notifyUser.ts',
      'services/wisp/watches.ts',
    ]);
  });
});
