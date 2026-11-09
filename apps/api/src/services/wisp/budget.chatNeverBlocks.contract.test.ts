/**
 * CONTRACT TEST — #10414 (docs/superpowers/specs/ai-mcp/2026-11-06-wisp-chat-grant-followups-spec.md
 * §4, Option 2): Wisp chat turns count toward the grant's daily budget, and
 * are NEVER refused by it.
 *
 * The grant budget gates BACKGROUND model work only, through
 * `chargeableUnderGrant`. Every caller is listed below with what it admits.
 * One of them (a specialist launch) can be requested from chat with the
 * `launch_specialist` tool: that launch is background work and is refused
 * `budget_exhausted` like any other, but the chat turn that asked for it
 * carries on. The chat path's hard stop is the org AI budget
 * (`checkBudgetDetailed` / `reserveAiBudget` in routes/ai.ts), which returns
 * 402 today.
 *
 * Pinned here:
 *  - the set of files that call `chargeableUnderGrant` is exactly the
 *    background admissions below (a new caller must be classified, so a
 *    grant-budget refusal cannot appear on a chat path unreviewed);
 *  - the chat request and turn path never reads grant spend at all; the only
 *    chat-side reader is the turn-end notice (`chatSpendCheck.ts`), fired with
 *    `void` from the Wisp turn-end hooks (`wisp/turnEnd.ts`, #10428) after
 *    `done`, and never awaited.
 *
 * Plain unit test — reads the source tree only.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(import.meta.dirname, '../..');

/** Source with comments removed, so a comment naming a symbol never satisfies or trips a check. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
const code = (relPath: string): string => stripComments(readFileSync(resolve(SRC, relPath), 'utf8'));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' || name === '__tests__' ? [] : walk(full);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

/** Every caller of the grant-budget refusal, and the background work it admits. */
const BACKGROUND_ADMISSIONS: Record<string, string> = {
  'services/wisp/budget.ts': 'defines it',
  'jobs/wispWakeScheduler.ts': 'the floor tick (a scheduled assessment)',
  'services/wisp/assessment.ts': 'event-driven assessment admission',
  'services/wisp/firstLook.ts': "a new grant's first-look assessment",
  'services/wisp/coordinator.ts': 'specialist launches, including one requested from chat via launch_specialist (the launch is refused; the chat turn is not)',
  'services/wisp/threadSummaryRefine.ts': 'model-written session summaries (sessionless overhead)',
  'services/wisp/specialists/assessmentLaunch.ts': 'the on-demand Wisp assessment launch (#10406): N orgs x the per-run estimate, requested from chat via launch_specialist (the launch is refused budget_exhausted; the chat turn is not)',
  'services/wisp/instructionExtractor.ts': 'turn-end standing-instruction extraction (#10428): sessionless overhead, run after `done` and never awaited by the turn; a refusal skips the capture, never the chat turn',
};

/** The chat request and turn path: the route, the SDK session wiring, the turn loop, and the Wisp chat gate. */
const CHAT_PATH_FILES = [
  'routes/ai.ts',
  'services/aiAgentSdk.ts',
  'services/streamingSessionManager.ts',
  'services/wisp/chatCeiling.ts',
  // #10428: the Wisp turn-end hooks the turn loop calls.
  'services/wisp/turnEnd.ts',
];

const GRANT_BUDGET_GATE = /\bchargeableUnderGrant\b/;
const GRANT_SPEND_READERS = /\b(?:spentUnderGrant|spendBreakdownUnderGrant|spendSummary)\b/;

describe('contract: the Wisp grant budget never blocks a chat turn (#10414)', () => {
  it('only the classified background admissions call chargeableUnderGrant', () => {
    const callers = walk(SRC)
      .filter((f) => GRANT_BUDGET_GATE.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(SRC, f).replace(/\\/g, '/'))
      .sort();
    expect(callers).toEqual(Object.keys(BACKGROUND_ADMISSIONS).sort());
  });

  it.each(CHAT_PATH_FILES)('%s never reads grant spend itself (only the chatSpendCheck notice may)', (file) => {
    const src = code(file);
    expect(src).not.toMatch(GRANT_BUDGET_GATE);
    expect(src).not.toMatch(GRANT_SPEND_READERS);
  });

  it('the notice path reads spend but never asks whether anything is chargeable', () => {
    const src = code('services/wisp/chatSpendCheck.ts');
    expect(src).toMatch(GRANT_SPEND_READERS);
    expect(src).not.toMatch(GRANT_BUDGET_GATE);
  });

  it('the turn-end hooks fire the notice once and never await it (off the response path)', () => {
    // #10428 moved the notice from the turn loop into the Wisp turn-end hooks,
    // which the turn loop calls after publishing `done`.
    expect(code('services/streamingSessionManager.ts')).not.toMatch(/chatSpendCheck|maybeNotifyChatCrossedBudget/);
    const src = code('services/wisp/turnEnd.ts');
    expect(src.match(/'\.\/chatSpendCheck'/g) ?? []).toHaveLength(1);
    expect(src.match(/\bmaybeNotifyChatCrossedBudget\(/g) ?? []).toHaveLength(1);
    expect(src.match(/\bvoid\s+maybeNotifyChatCrossedBudget\(/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(/\bawait\s+maybeNotifyChatCrossedBudget\(/);
  });

  it('the turn loop publishes `done` before it schedules the after-done hooks, and never awaits them', () => {
    const src = code('services/streamingSessionManager.ts');
    const done = src.search(/\.\.\.wispDone,/);
    const after = src.search(/\bscheduleWispTurnEndAfterDone\(/);
    expect(done).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(done);
    expect(src).not.toMatch(/\bawait\s+\S*scheduleWispTurnEndAfterDone\(/);
  });
});
