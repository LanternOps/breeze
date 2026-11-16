import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Wisp analysis sessions W03 — continuation validation, chain handle
 * derivation, the seed builder and the manifest loader. `db` is a chain fake
 * (the `budget.test.ts` shape): each awaited select resolves the next queued
 * result, and every `.where(...)` condition is recorded so the org pin can be
 * compiled and asserted. The real-SQL behaviour is pinned in
 * `__tests__/integration/analysisChain.integration.test.ts`.
 */
const h = vi.hoisted(() => {
  const results: unknown[][] = [];
  const whereArgs: unknown[] = [];
  const chain = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (const m of ['innerJoin', 'leftJoin', 'limit', 'orderBy', 'from']) p[m] = vi.fn(() => p);
    p.where = vi.fn((cond: unknown) => { whereArgs.push(cond); return p; });
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(results.shift() ?? []).then(res, rej);
    return p;
  };
  return {
    results,
    whereArgs,
    db: { select: vi.fn(() => chain()), execute: vi.fn() },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('../../db', () => ({
  db: h.db,
  runOutsideDbContext: h.runOutsideDbContext,
  withSystemDbAccessContext: h.withSystemDbAccessContext,
  getCurrentDbAccessContext: vi.fn(() => undefined),
}));

import {
  ANALYSIS_CHAIN_HANDLE_CAP,
  analysisContinuationOf,
  buildAnalysisContinuationSeed,
  chainCommittedCents,
  chainRootOf,
  deriveChainHandles,
  isChainStageableArtifact,
  loadHandleManifest,
  type AnalysisChainPrior,
} from './analysisContinuation';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PRIOR = '00000000-0000-4000-8000-0000000000b1';
const ROOT = '00000000-0000-4000-8000-0000000000b0';
const OTHER_RUN = '00000000-0000-4000-8000-0000000000b9';
const GRANT = '00000000-0000-4000-8000-0000000000c1';
const OTHER_GRANT = '00000000-0000-4000-8000-0000000000c2';
const S_OTHER = '00000000-0000-4000-8000-0000000000d1';
const GRANTS = { datasets: ['devices', 'event_logs'], sensitiveGates: [] as [] };

const dialect = new PgDialect();
const compile = (s: unknown) => dialect.sqlToQuery(s as SQL);
const h_ = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 1000);

function priorRow(over: Record<string, unknown> = {}) {
  return {
    id: PRIOR, orgId: ORG, profile: 'analysis', grantId: GRANT, status: 'completed',
    chainRootRunId: null, chainDepth: 0,
    stagedInputs: { handles: [], deviceIds: [], region: 'eu' },
    triggerRef: { source: 'chat_analysis', goal: 'find BSODs', originSessionId: null },
    ...over,
    ...('originSessionId' in over ? { triggerRef: { source: 'chat_analysis', goal: 'find BSODs', originSessionId: over.originSessionId } } : {}),
  };
}

function prior(over: Partial<AnalysisChainPrior> = {}): AnalysisChainPrior {
  return {
    id: PRIOR, orgId: ORG, grantId: GRANT, chainRootRunId: null, chainDepth: 0,
    stagedInputs: { handles: [], deviceIds: [], region: 'eu' }, goal: 'g', originSessionId: null, ...over,
  };
}

/** A candidate row as the derivation select returns it. */
function cand(id: string, over: Record<string, unknown> = {}) {
  return {
    id, kind: 'output', createdByTool: 'workspace_collect', dataset: null, expiresAt: FUTURE,
    createdAt: new Date('2026-11-01T00:00:00Z'), producerId: PRIOR, producerGrantId: GRANT,
    producerChainRootRunId: null, ...over,
  };
}

beforeEach(() => {
  h.results.length = 0;
  h.whereArgs.length = 0;
  vi.clearAllMocks();
});

describe('chainRootOf / isChainStageableArtifact', () => {
  it('a root is its own chain root; a continuation names its root; a lost root is null', () => {
    expect(chainRootOf({ id: PRIOR, chainRootRunId: null, chainDepth: 0 })).toBe(PRIOR);
    expect(chainRootOf({ id: PRIOR, chainRootRunId: ROOT, chainDepth: 2 })).toBe(ROOT);
    expect(chainRootOf({ id: PRIOR, chainRootRunId: null, chainDepth: 1 })).toBeNull();
  });

  it('stages outputs and export_dataset captures that have not expired, nothing else', () => {
    const now = new Date();
    expect(isChainStageableArtifact({ kind: 'output', createdByTool: 'workspace_collect', expiresAt: FUTURE }, now)).toBe(true);
    expect(isChainStageableArtifact({ kind: 'input_capture', createdByTool: 'export_dataset', expiresAt: FUTURE }, now)).toBe(true);
    expect(isChainStageableArtifact({ kind: 'input_capture', createdByTool: 'search_logs', expiresAt: FUTURE }, now)).toBe(false);
    expect(isChainStageableArtifact({ kind: 'step_stdout', createdByTool: 'workspace_run', expiresAt: FUTURE }, now)).toBe(false);
    expect(isChainStageableArtifact({ kind: 'output', createdByTool: 'workspace_collect', expiresAt: PAST }, now)).toBe(false);
  });
});

describe('analysisContinuationOf', () => {
  it('refuses in spec order: a row failing every later check reports the earliest', async () => {
    h.results.push([priorRow({ profile: 'full', grantId: OTHER_GRANT, status: 'running' })]);
    expect(await analysisContinuationOf({ orgId: ORG, runId: PRIOR, grantId: GRANT }))
      .toEqual({ ok: false, refusal: 'analysis_continuation_wrong_kind' });
  });

  it.each([
    [null, 'analysis_continuation_not_found', 'no row'],
    [{ grantId: OTHER_GRANT }, 'analysis_continuation_other_grant', 'another grant'],
    [{ grantId: null }, 'analysis_continuation_other_grant', 'a grant-less analysis run is never continuable'],
    [{ grantId: OTHER_GRANT, status: 'running' }, 'analysis_continuation_other_grant', 'grant before settled'],
    [{ status: 'running' }, 'analysis_continuation_not_settled', 'running'],
    [{ status: 'queued' }, 'analysis_continuation_not_settled', 'queued'],
    [{ status: 'expired' }, 'analysis_continuation_not_settled', 'expired'],
  ] as const)('%o → %s (%s)', async (over, refusal) => {
    h.results.push(over === null ? [] : [priorRow(over)]);
    expect(await analysisContinuationOf({ orgId: ORG, runId: PRIOR, grantId: GRANT }))
      .toEqual({ ok: false, refusal });
  });

  it('the read is pinned to the caller org (another org reads as not found) and runs in a system context', async () => {
    h.results.push([]);
    await analysisContinuationOf({ orgId: ORG, runId: PRIOR });
    const q = compile(h.whereArgs[0]);
    expect(q.sql).toContain('"ai_agent_runs"."org_id" = $');
    expect(q.sql).toContain('"ai_agent_runs"."id" = $');
    expect(q.params).toEqual(expect.arrayContaining([PRIOR, ORG]));
    expect(h.runOutsideDbContext).toHaveBeenCalled();
    expect(h.withSystemDbAccessContext).toHaveBeenCalled();
  });

  it('a run id that is not a uuid is not found, without a query', async () => {
    expect(await analysisContinuationOf({ orgId: ORG, runId: 'nope' }))
      .toEqual({ ok: false, refusal: 'analysis_continuation_not_found' });
    expect(h.db.select).not.toHaveBeenCalled();
  });

  it('admits a settled analysis run under the same grant, whatever session launched it', async () => {
    h.results.push([priorRow({ originSessionId: S_OTHER, chainRootRunId: ROOT, chainDepth: 2 })]);
    const r = await analysisContinuationOf({ orgId: ORG, runId: PRIOR, grantId: GRANT });
    expect(r).toEqual({ ok: true, prior: expect.objectContaining({
      id: PRIOR, orgId: ORG, grantId: GRANT, chainRootRunId: ROOT, chainDepth: 2, originSessionId: S_OTHER, goal: 'find BSODs',
    }) });
  });

  it.each(['completed', 'failed', 'cancelled'])('a %s prior is settled', async (status) => {
    h.results.push([priorRow({ status })]);
    expect((await analysisContinuationOf({ orgId: ORG, runId: PRIOR, grantId: GRANT })).ok).toBe(true);
  });

  it('the advisory precheck (no grant) checks found, kind, a non-null grant and settled', async () => {
    h.results.push([priorRow({ grantId: OTHER_GRANT })]);
    expect((await analysisContinuationOf({ orgId: ORG, runId: PRIOR })).ok).toBe(true);
    h.results.push([priorRow({ grantId: null })]);
    expect(await analysisContinuationOf({ orgId: ORG, runId: PRIOR }))
      .toEqual({ ok: false, refusal: 'analysis_continuation_other_grant' });
  });

  it('reads goal, origin session and staged inputs defensively', async () => {
    h.results.push([priorRow({ triggerRef: { goal: 42, originSessionId: 7 }, stagedInputs: 'garbage' })]);
    const r = await analysisContinuationOf({ orgId: ORG, runId: PRIOR, grantId: GRANT });
    expect(r).toEqual({ ok: true, prior: expect.objectContaining({ goal: '', originSessionId: null, stagedInputs: null }) });
  });
});

describe('deriveChainHandles classification', () => {
  const derive = (p: AnalysisChainPrior = prior()) =>
    deriveChainHandles({ orgId: ORG, prior: p, grantId: GRANT, exportGrants: GRANTS });

  it('keeps stageable chain files and pins the read to the org', async () => {
    h.results.push([cand(h_(1)), cand(h_(2), { kind: 'input_capture', createdByTool: 'export_dataset', dataset: 'devices' })]);
    const r = await derive();
    expect(r.handles.sort()).toEqual([h_(1), h_(2)]);
    expect(r.dropped).toEqual([]);
    const q = compile(h.whereArgs[0]);
    expect(q.sql).toContain('"ai_run_artifacts"."org_id" = $');
    expect(q.params).toContain(ORG);
    expect(h.withSystemDbAccessContext).toHaveBeenCalled();
  });

  it('drops outside_chain, other_grant, kind, expired and dataset_not_permitted, first reason wins', async () => {
    h.results.push([
      // no producer AND wrong kind → outside_chain (first)
      cand(h_(1), { producerId: null, producerGrantId: null, kind: 'step_stdout' }),
      // producer outside the chain AND other grant → outside_chain
      cand(h_(2), { producerId: OTHER_RUN, producerChainRootRunId: OTHER_RUN, producerGrantId: OTHER_GRANT }),
      // other grant AND expired → other_grant
      cand(h_(3), { producerGrantId: OTHER_GRANT, expiresAt: PAST }),
      // wrong kind AND expired → kind
      cand(h_(4), { kind: 'input_capture', createdByTool: 'search_logs', expiresAt: PAST }),
      // expired export with a dataset not permitted → expired
      cand(h_(5), { kind: 'input_capture', createdByTool: 'export_dataset', dataset: 'alerts', expiresAt: PAST }),
      // live export whose dataset this launch's grants do not permit
      cand(h_(6), { kind: 'input_capture', createdByTool: 'export_dataset', dataset: 'alerts' }),
    ]);
    const r = await derive();
    expect(r.handles).toEqual([]);
    expect(r.dropped).toEqual([
      { handle: h_(1), reason: 'outside_chain' },
      { handle: h_(2), reason: 'outside_chain' },
      { handle: h_(3), reason: 'other_grant' },
      { handle: h_(4), reason: 'kind' },
      { handle: h_(5), reason: 'expired' },
      { handle: h_(6), reason: 'dataset_not_permitted' },
    ]);
  });

  it('a pre-W03 export with dataset NULL is dropped dataset_not_permitted', async () => {
    h.results.push([cand(h_(1), { kind: 'input_capture', createdByTool: 'export_dataset', dataset: null })]);
    expect(await derive()).toEqual({ handles: [], dropped: [{ handle: h_(1), reason: 'dataset_not_permitted' }] });
  });

  it('a file produced by another run of the same chain is kept', async () => {
    h.results.push([cand(h_(1), { producerId: OTHER_RUN, producerChainRootRunId: ROOT })]);
    const r = await derive(prior({ chainRootRunId: ROOT, chainDepth: 2 }));
    expect(r.handles).toEqual([h_(1)]);
  });

  it('a prior handle whose row is gone is dropped expired', async () => {
    h.results.push([cand(h_(1))]);
    const r = await derive(prior({ stagedInputs: { handles: [h_(1), h_(2)], deviceIds: [], region: 'eu' } }));
    expect(r).toEqual({ handles: [h_(1)], dropped: [{ handle: h_(2), reason: 'expired' }] });
  });

  it('keeps the 200 newest by created_at and drops the rest over_cap', async () => {
    const base = Date.parse('2026-11-01T00:00:00Z');
    h.results.push(Array.from({ length: 205 }, (_, i) => cand(h_(i), { createdAt: new Date(base + i * 1000) })));
    const r = await derive();
    expect(ANALYSIS_CHAIN_HANDLE_CAP).toBe(200);
    expect(r.handles).toHaveLength(200);
    expect(r.handles[0]).toBe(h_(204));
    expect(r.dropped).toEqual([0, 1, 2, 3, 4].map((i) => ({ handle: h_(i), reason: 'over_cap' })).reverse());
  });

  it('a prior with a deleted root drops every candidate outside_chain', async () => {
    h.results.push([cand(h_(1)), cand(h_(2))]);
    const r = await derive(prior({ chainRootRunId: null, chainDepth: 1 }));
    expect(r).toEqual({ handles: [], dropped: [
      { handle: h_(1), reason: 'outside_chain' }, { handle: h_(2), reason: 'outside_chain' },
    ] });
  });

  it('a non-uuid prior handle is dropped expired and never sent to SQL', async () => {
    h.results.push([]);
    const r = await derive(prior({ stagedInputs: { handles: ['nope'], deviceIds: [], region: 'eu' } }));
    expect(r).toEqual({ handles: [], dropped: [{ handle: 'nope', reason: 'expired' }] });
    expect(compile(h.whereArgs[0]).params).not.toContain('nope');
  });
});

describe('chainCommittedCents', () => {
  it('sums the chain under the org, excluding skipped and enqueue_failed rows, with a guarded allowance', async () => {
    const tx = { execute: vi.fn(async () => [{ runCount: 3, committedCents: '410' }]) };
    await expect(chainCommittedCents(tx as never, { orgId: ORG, chainRootRunId: ROOT }))
      .resolves.toEqual({ committedCents: 410, runCount: 3 });
    const q = compile((tx.execute.mock.calls[0] as unknown[])[0]);
    expect(q.params).toEqual(expect.arrayContaining([ORG, ROOT]));
    expect(q.sql).toContain("status <> 'skipped'");
    expect(q.sql).toContain("coalesce(error_code, '') = 'enqueue_failed'");
    expect(q.sql).toContain("jsonb_typeof(policy_snapshot #> '{effective,limits,analysisMaxBudgetCentsPerRun}') = 'number'");
    expect(q.sql).toContain("jsonb_typeof(policy_snapshot #> '{effective,limits,analysisMaxComputeCentsPerRun}') = 'number'");
    expect(q.sql).toContain('GREATEST(');
  });

  it('an empty chain is zero', async () => {
    const tx = { execute: vi.fn(async () => []) };
    await expect(chainCommittedCents(tx as never, { orgId: ORG, chainRootRunId: ROOT }))
      .resolves.toEqual({ committedCents: 0, runCount: 0 });
  });
});

describe('buildAnalysisContinuationSeed', () => {
  it('uses outcome.analysis (summary + findings), org-pinned', async () => {
    h.results.push([{ summary: 'column summary', outcome: { analysis: {
      summary: 'outcome summary',
      findings: [{ title: 'Driver X', severity: 'high', detail: 'd', artifactHandles: [] }],
      artifactHandles: [], proposedActions: [],
    } } }]);
    const seed = await buildAnalysisContinuationSeed({ orgId: ORG, prior: prior({ goal: 'find BSODs' }) });
    expect(seed).toContain('Earlier goal: find BSODs');
    expect(seed).toContain('Earlier summary: outcome summary');
    expect(seed).toContain('- [high] Driver X');
    expect(seed).not.toContain('column summary');
    expect(compile(h.whereArgs[0]).params).toEqual(expect.arrayContaining([PRIOR, ORG]));
  });

  it('falls back to the summary column when there is no readable outcome', async () => {
    h.results.push([{ summary: 'column summary', outcome: {} }]);
    const seed = await buildAnalysisContinuationSeed({ orgId: ORG, prior: prior() });
    expect(seed).toContain('Earlier summary: column summary');
    expect(seed).toMatch(/Findings:\n\(none\)/);
  });

  it('keeps at most 20 findings', async () => {
    h.results.push([{ summary: null, outcome: { analysis: {
      summary: 's',
      findings: Array.from({ length: 25 }, (_, i) => ({ title: `F${i}`, severity: 'low', detail: 'd', artifactHandles: [] })),
      artifactHandles: [], proposedActions: [],
    } } }]);
    const seed = await buildAnalysisContinuationSeed({ orgId: ORG, prior: prior() });
    expect(seed).toContain('- [low] F19');
    expect(seed).not.toContain('- [low] F20');
  });
});

describe('loadHandleManifest', () => {
  it('reads in the caller\'s context, org-pinned, newest first, omitting missing handles', async () => {
    h.results.push([
      { handle: h_(2), name: 'b.csv', bytes: 2, contentType: 'text/csv', kind: 'output', producedByRunId: PRIOR, producerChainDepth: 1 },
      { handle: h_(1), name: 'a.csv', bytes: '1', contentType: 'text/csv', kind: 'output', producedByRunId: null, producerChainDepth: null },
    ]);
    const entries = await loadHandleManifest({ orgId: ORG, handles: [h_(1), h_(2), h_(3)] });
    expect(entries.map((e) => e.handle)).toEqual([h_(2), h_(1)]);
    expect(entries[1]!.bytes).toBe(1);
    expect(h.withSystemDbAccessContext).not.toHaveBeenCalled();
    expect(compile(h.whereArgs[0]).params).toEqual(expect.arrayContaining([ORG]));
  });

  it('no handles reads nothing', async () => {
    expect(await loadHandleManifest({ orgId: ORG, handles: [] })).toEqual([]);
    expect(h.db.select).not.toHaveBeenCalled();
  });
});
