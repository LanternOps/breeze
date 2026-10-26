/**
 * CONTRACT TEST — every terminal transition of an action intent wakes the
 * flow run that is waiting on it (tool catalog W04, #5219, plan Task A5).
 *
 * A Tier-3 flow step parks its run in `awaiting_approval` until its intent is
 * terminal. The run is resumed by a `flow-runs` slice enqueued AFTER the
 * terminal transition commits (`scheduleFlowRunWake`, services/flows/wake.ts).
 * The single-writer premise is false — decide, deny, cancel, revoke, expiry,
 * execution_lost, release completion/failure, the dispatch claim and several
 * domain cancels all write a terminal status — so the wake rides the one
 * helper they share, `publishIntentTerminalOutbox` (services/aiOperator/
 * taskOutbox.ts), and the two writers that bypass it (the expiry reaper's
 * direct outbox inserts) call `scheduleFlowRunWake` themselves.
 *
 * Modelled on the aiOperatorTerminalWriters inventory: the set of writers is
 * DISCOVERED from source (comments stripped) and every discovered file must be
 * classified here — a new writer cannot join silently.
 *
 * Discovery: a write to `action_intents` that sets `status` —
 *   - Drizzle `.update(actionIntents)` followed by a `.set({ … status: … })`;
 *   - raw SQL `UPDATE ${actionIntents}` / `UPDATE action_intents` with `SET status =`;
 *   - a call to `transitionIntent(` (the CAS primitive) outside its definition.
 * Then:
 *   - `wakes` — the file must call `publishIntentTerminalOutbox(` or
 *     `scheduleFlowRunWake(`;
 *   - `delegated` — the write lives in a store module whose caller (named)
 *     publishes;
 *   - `non_terminal` — the file only writes live statuses (named reason).
 * And every `publishIntentTerminalOutbox(` call passes `requestingFlowRunId`
 * (tsc enforces the field; this pins that it is threaded, not defaulted).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const SRC = resolve(import.meta.dirname, '../..');

type Classification =
  | { kind: 'wakes' }
  | { kind: 'delegated'; publishedBy: string }
  | { kind: 'non_terminal'; reason: string };

const WRITERS: Record<string, Classification> = {
  'services/actionIntents/intentService.ts': { kind: 'wakes' },
  'jobs/intentReleaseWorker.ts': { kind: 'wakes' },
  'jobs/intentExpiryReaper.ts': { kind: 'wakes' },
  'routes/approvals.ts': { kind: 'wakes' },
  'services/approvals/decideApprovalRequest.ts': { kind: 'wakes' },
  'services/actionIntents/revokeIntentsForSubject.ts': { kind: 'wakes' },
  'services/aiOperator/planApproval.ts': { kind: 'wakes' },
  'services/scriptProposals/intentLink.ts': { kind: 'wakes' },
  'services/flows/versions.ts': { kind: 'wakes' },
  'services/aiAgentSdk.ts': { kind: 'wakes' },
  'services/flows/intentClaimStore.ts': { kind: 'delegated', publishedBy: 'services/flows/intentClaim.ts' },
  'services/actionIntents/policyDecide.ts': {
    kind: 'non_terminal',
    reason: 'policy decide only CASes pending_approval → approved; release terminalizes',
  },
  'services/aiOperator/dispatchClaim.ts': {
    kind: 'non_terminal',
    reason: 'the task-linked claim CASes approved → executing and its revert executing → approved',
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === '__snapshots__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const files = walk(SRC).map((full) => ({ rel: relative(SRC, full), text: stripComments(readFileSync(full, 'utf8')) }));

function writesIntentStatus(text: string): boolean {
  const drizzle = /\.update\(\s*actionIntents\s*\)/g;
  for (let m = drizzle.exec(text); m; m = drizzle.exec(text)) {
    const window = text.slice(m.index, m.index + 400);
    const set = window.indexOf('.set(');
    if (set !== -1 && /\bstatus\s*:/.test(window.slice(set, set + 300))) return true;
  }
  const raw = /UPDATE\s+(?:\$\{\s*actionIntents\s*\}|action_intents)(?!\w)/g;
  for (let m = raw.exec(text); m; m = raw.exec(text)) {
    if (/SET\s+status\s*=/i.test(text.slice(m.index, m.index + 200))) return true;
  }
  return /(?<!function\s)\btransitionIntent\(/.test(text);
}

/** The text of each `publishIntentTerminalOutbox(` call, through its matching close paren. */
function publishCalls(text: string): string[] {
  const out: string[] = [];
  const re = /publishIntentTerminalOutbox\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
    let depth = 0;
    let i = m.index + 'publishIntentTerminalOutbox'.length;
    for (; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') { depth -= 1; if (depth === 0) break; }
    }
    out.push(text.slice(m.index, i + 1));
  }
  return out;
}

const discovered = files.filter((f) => writesIntentStatus(f.text)).map((f) => f.rel).sort();

describe('flow intent terminal writers', () => {
  it('discovery found the known writers (guards the regexes themselves)', () => {
    expect(discovered).toContain('jobs/intentExpiryReaper.ts');
    expect(discovered).toContain('services/approvals/decideApprovalRequest.ts');
    expect(discovered).toContain('services/flows/versions.ts');
    expect(discovered.length).toBeGreaterThanOrEqual(10);
  });

  it('every file that writes an intent status is classified', () => {
    const unclassified = discovered.filter((rel) => !(rel in WRITERS));
    expect(unclassified, `classify these action_intents status writers in WRITERS: ${unclassified.join(', ')}`).toEqual([]);
  });

  it('no stale entries', () => {
    const stale = Object.keys(WRITERS).filter((rel) => !discovered.includes(rel));
    expect(stale).toEqual([]);
  });

  it.each(Object.entries(WRITERS))('%s reaches the flow run wake', (rel, cls) => {
    const host = cls.kind === 'delegated' ? cls.publishedBy : rel;
    const text = files.find((f) => f.rel === host)?.text ?? '';
    if (cls.kind === 'non_terminal') {
      expect(cls.reason.length).toBeGreaterThan(10);
      return;
    }
    expect(/publishIntentTerminalOutbox\(|scheduleFlowRunWake\(/.test(text), `${host} must publish or wake`).toBe(true);
  });

  it('every publishIntentTerminalOutbox call threads requestingFlowRunId', () => {
    const offenders: string[] = [];
    let total = 0;
    for (const f of files) {
      for (const call of publishCalls(f.text)) {
        total += 1;
        if (!call.includes('requestingFlowRunId')) offenders.push(`${f.rel}: ${call.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    expect(total).toBeGreaterThanOrEqual(10);
    expect(offenders).toEqual([]);
  });

  it('publishIntentTerminalOutbox itself schedules the wake for a flow-origin intent', () => {
    const text = files.find((f) => f.rel === 'services/aiOperator/taskOutbox.ts')!.text;
    expect(text).toMatch(/if\s*\(\s*intent\.requestingFlowRunId\s*\)\s*\{?\s*scheduleFlowRunWake\(\s*intent\.requestingFlowRunId\s*\)/);
  });

  it('both expiry-reaper writers return requesting_flow_run_id and wake flow rows', () => {
    const text = files.find((f) => f.rel === 'jobs/intentExpiryReaper.ts')!.text;
    expect(text.match(/a\.requesting_flow_run_id/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(text.match(/scheduleFlowRunWake\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
