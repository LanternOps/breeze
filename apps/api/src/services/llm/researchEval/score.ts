import type { ResearchOutcome } from '@breeze/shared';
import type { ResearchEvalCase } from './cases';

export interface CaseRun { caseId: string; depth: 'quick' | 'deep'; status: string; errorCode: string | null; costCents: number; turns: number; outcome: ResearchOutcome | null; denial?: string }
export interface CaseScore { caseId: string; depth: 'quick' | 'deep'; costCents: number; turns: number; accepted: number; rejected: number; validity: number | null; expectationHit: boolean; forbiddenHit: boolean; failed: boolean }
export interface DepthSummary { depth: 'quick' | 'deep'; runs: number; failed: number; costP50: number; costP90: number; costMax: number; turnsP90: number; validity: number; expectationHitRate: number; forbiddenHits: number; recommendedCapCents: number }

type Item = ResearchOutcome['items'][number];
const kindOf = (item: Item) => item.kind;
const actionOf = (item: Item) => (item.kind === 'builtin_action' ? item.action : null);

export function scoreRun(c: ResearchEvalCase, run: CaseRun): CaseScore {
  const failed = run.status !== 'completed' || !run.outcome;
  const items = run.outcome?.items ?? [];
  const rejected = run.outcome?.rejected.length ?? 0;
  const submitted = items.length + rejected;
  const kinds = new Set<string>(items.map(kindOf));
  // A named builtinAction must match whenever the model chose a built-in at all.
  const builtinOk = !c.expect.builtinAction || !items.some((i) => i.kind === 'builtin_action') || items.some((i) => actionOf(i) === c.expect.builtinAction);
  const expectationHit = !failed && c.expect.anyOf.some((k) => (k === 'none' ? items.length === 0 : kinds.has(k))) && builtinOk;
  const forbiddenHit = items.some((i) => (c.expect.forbid ?? []).includes(actionOf(i) ?? i.kind));
  return {
    caseId: run.caseId, depth: run.depth, costCents: run.costCents, turns: run.turns,
    accepted: items.length, rejected, validity: failed ? null : submitted === 0 ? 1 : items.length / submitted,
    expectationHit, forbiddenHit, failed,
  };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

/** ceil(p90 x 1.25), at least 1 cent. */
export function recommendCapCents(p90: number): number {
  return Math.max(1, Math.ceil(p90 * 1.25));
}

export function summarizeDepth(scores: readonly CaseScore[], depth: 'quick' | 'deep'): DepthSummary {
  const s = scores.filter((x) => x.depth === depth);
  const costs = s.map((x) => x.costCents).sort((a, b) => a - b);
  const turns = s.map((x) => x.turns).sort((a, b) => a - b);
  const ok = s.filter((x) => !x.failed);
  const p90 = pct(costs, 0.9);
  return {
    depth, runs: s.length, failed: s.length - ok.length,
    costP50: pct(costs, 0.5), costP90: p90, costMax: costs.at(-1) ?? 0, turnsP90: pct(turns, 0.9),
    validity: ok.length ? ok.reduce((a, x) => a + (x.validity ?? 0), 0) / ok.length : 0,
    expectationHitRate: s.length ? s.filter((x) => x.expectationHit).length / s.length : 0,
    forbiddenHits: s.filter((x) => x.forbiddenHit).length,
    recommendedCapCents: recommendCapCents(p90),
  };
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

export function renderEvalMarkdown(
  summaries: readonly DepthSummary[], scores: readonly CaseScore[], defaults: { quick: number; deep: number },
): string {
  const out: string[] = ['# Research eval', ''];
  for (const s of summaries) {
    out.push(
      `## ${s.depth}`, '',
      '| runs | failed | cost p50 | cost p90 | cost max | turns p90 | validity | hit rate | forbidden | recommended cap | current default |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
      `| ${s.runs} | ${s.failed} | ${f(s.costP50)}c | ${f(s.costP90)}c | ${f(s.costMax)}c | ${f(s.turnsP90)} | ${f(s.validity)} | ${f(s.expectationHitRate)} | ${s.forbiddenHits} | ${s.recommendedCapCents}c | ${defaults[s.depth]}c |`,
      '',
    );
  }
  out.push(
    '## Per case', '',
    '| case | depth | cost | turns | accepted | rejected | validity | hit | forbidden | failed |',
    '|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const x of scores) {
    out.push(`| ${x.caseId} | ${x.depth} | ${f(x.costCents)}c | ${x.turns} | ${x.accepted} | ${x.rejected} | ${x.validity === null ? '-' : f(x.validity)} | ${x.expectationHit ? 'yes' : 'no'} | ${x.forbiddenHit ? 'YES' : 'no'} | ${x.failed ? 'YES' : 'no'} |`);
  }
  out.push('');
  return out.join('\n');
}
