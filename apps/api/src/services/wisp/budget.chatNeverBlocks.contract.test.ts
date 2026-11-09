/**
 * CONTRACT TEST — #10414 (spec §4.2 Option 2): Wisp chat counts toward the
 * grant's daily budget, and is NEVER refused by it.
 *
 * The grant budget gates background model calls only (`chargeableUnderGrant`:
 * the floor tick, assessments, specialist launches, summary refines). The chat
 * path's hard stop is the org AI budget (`checkBudgetDetailed` /
 * `reserveAiBudget` in routes/ai.ts), which returns 402 today. A chat-path file
 * that reads the grant budget is the first step toward a grant-budget 402, so
 * none may; the only chat-side reader of grant spend is the turn-end notice
 * (`chatSpendCheck.ts`), fired and forgotten off the response path.
 *
 * Plain unit test — reads the source tree only.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(import.meta.dirname, '../..');

/** Source with comments removed, so a comment naming a symbol never satisfies or trips a check. */
function code(relPath: string): string {
  return readFileSync(resolve(SRC, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** The chat request and turn path: the route, the SDK session wiring, the turn loop, and the Wisp chat gate. */
const CHAT_PATH_FILES = [
  'routes/ai.ts',
  'services/aiAgentSdk.ts',
  'services/streamingSessionManager.ts',
  'services/wisp/chatCeiling.ts',
];

/** Grant-budget readers. `chargeableUnderGrant` is the refusal; the others read spend. */
const GRANT_BUDGET_GATE = /\bchargeableUnderGrant\b/;
const GRANT_SPEND_READERS = /\b(?:spentUnderGrant|spendBreakdownUnderGrant|spendSummary)\b/;

describe('contract: the Wisp grant budget never blocks chat (#10414)', () => {
  it.each(CHAT_PATH_FILES)('%s never references chargeableUnderGrant', (file) => {
    expect(code(file)).not.toMatch(GRANT_BUDGET_GATE);
  });

  it.each(CHAT_PATH_FILES)('%s never reads grant spend itself (only the chatSpendCheck notice may)', (file) => {
    expect(code(file)).not.toMatch(GRANT_SPEND_READERS);
  });

  it('the notice path reads spend but never asks whether anything is chargeable', () => {
    const src = code('services/wisp/chatSpendCheck.ts');
    expect(src).toMatch(GRANT_SPEND_READERS);
    expect(src).not.toMatch(GRANT_BUDGET_GATE);
  });

  it('the turn loop fires the notice and never awaits it (off the response path)', () => {
    const src = code('services/streamingSessionManager.ts');
    // Loaded lazily like the other Wisp modules here, and the whole chain is discarded with `void`.
    expect(src.match(/\bvoid\s+import\(\s*'\.\/wisp\/chatSpendCheck'\s*\)/g) ?? []).toHaveLength(1);
    expect(src.match(/'\.\/wisp\/chatSpendCheck'/g) ?? []).toHaveLength(1);
    expect(src.match(/\bmaybeNotifyChatCrossedBudget\(/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(/\bawait\s+(?:maybeNotifyChatCrossedBudget\(|import\(\s*'\.\/wisp\/chatSpendCheck')/);
  });
});
