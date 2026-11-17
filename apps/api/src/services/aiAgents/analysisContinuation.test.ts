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
    producerChainRootRunId: null,
    producerStagedInputs: { handles: [], deviceIds: [], region: 'eu', exportGrants: GRANTS }, ...over,
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
  ] as Array<[Record<string, unknown> | null, string, string]>)('%o → %s (%s)', async (over, refusal) => {
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

describe('deriveChainHandles: the producer run\'s frozen export grants', () => {
  const NARROW = { datasets: ['event_logs'], sensitiveGates: [] as string[] };
  const WIDE_GATE = { datasets: ['event_logs'], sensitiveGates: ['security_events'] };
  const derive = (exportGrants: { datasets: string[]; sensitiveGates: string[] } = NARROW) =>
    deriveChainHandles({ orgId: ORG, prior: prior(), grantId: GRANT, exportGrants: exportGrants as never });
  const producedUnder = (exportGrants: unknown) => ({ handles: [], deviceIds: [], region: 'eu', exportGrants });
  const exportOf = (id: string, over: Record<string, unknown> = {}) =>
    cand(id, { kind: 'input_capture', createdByTool: 'export_dataset', dataset: 'event_logs', ...over });

  it('drops an export made under a sensitive gate this launch does not hold, though its dataset is permitted', async () => {
    h.results.push([exportOf(h_(1), { producerStagedInputs: producedUnder(WIDE_GATE) })]);
    expect(await derive()).toEqual({ handles: [], dropped: [{ handle: h_(1), reason: 'grants_not_covered' }] });
  });

  it('drops an output derived under a sensitive gate this launch does not hold', async () => {
    h.results.push([cand(h_(1), { producerStagedInputs: producedUnder(WIDE_GATE) })]);
    expect(await derive()).toEqual({ handles: [], dropped: [{ handle: h_(1), reason: 'grants_not_covered' }] });
  });

  it('drops an output whose producer could export a dataset this launch cannot', async () => {
    h.results.push([cand(h_(1), { producerStagedInputs: producedUnder({ datasets: ['event_logs', 'alerts'], sensitiveGates: [] }) })]);
    expect(await derive()).toEqual({ handles: [], dropped: [{ handle: h_(1), reason: 'grants_not_covered' }] });
  });

  it.each([
    ['staged_inputs null', null],
    ['staged_inputs not an object', 'garbage'],
    ['exportGrants absent (never read as the legacy set)', { handles: [], deviceIds: [], region: 'eu' }],
    ['exportGrants null', producedUnder(null)],
    ['datasets not an array', producedUnder({ datasets: 'event_logs', sensitiveGates: [] })],
    ['a non-string dataset', producedUnder({ datasets: [1], sensitiveGates: [] })],
    ['sensitiveGates missing', producedUnder({ datasets: ['event_logs'] })],
    ['an unknown gate', producedUnder({ datasets: ['event_logs'], sensitiveGates: ['root'] })],
  ])('fails closed when the producer grants are unreadable: %s', async (_label, stagedInputs) => {
    h.results.push([cand(h_(1), { producerStagedInputs: stagedInputs })]);
    expect(await derive()).toEqual({ handles: [], dropped: [{ handle: h_(1), reason: 'grants_not_covered' }] });
  });

  it('keeps files whose producer grants equal or sit inside this launch\'s grants', async () => {
    h.results.push([
      exportOf(h_(1), { producerStagedInputs: producedUnder(WIDE_GATE) }),
      cand(h_(2), { producerStagedInputs: producedUnder({ datasets: [], sensitiveGates: [] }) }),
      cand(h_(3), { producerStagedInputs: producedUnder(NARROW) }),
    ]);
    const r = await derive({ datasets: ['event_logs', 'metrics'], sensitiveGates: ['security_events'] });
    expect(r.handles.sort()).toEqual([h_(1), h_(2), h_(3)]);
    expect(r.dropped).toEqual([]);
  });

  it('the earlier reasons win: expired and dataset_not_permitted are reported before grants_not_covered', async () => {
    h.results.push([
      cand(h_(1), { expiresAt: PAST, producerStagedInputs: null }),
      exportOf(h_(2), { dataset: 'alerts', producerStagedInputs: null }),
    ]);
    expect((await derive()).dropped).toEqual([
      { handle: h_(1), reason: 'expired' },
      { handle: h_(2), reason: 'dataset_not_permitted' },
    ]);
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

  it('refuses to derive for a prior under a different grant than the launch (caller bug)', async () => {
    await expect(deriveChainHandles({ orgId: ORG, prior: prior({ grantId: OTHER_GRANT }), grantId: GRANT, exportGrants: GRANTS }))
      .rejects.toThrow(/grant/);
    expect(h.db.select).not.toHaveBeenCalled();
  });

  it('warns when the prior\'s staged inputs are unreadable (its inherited files cannot be carried)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.results.push([priorRow({ stagedInputs: { handles: 'garbage' } })]);
    const r = await analysisContinuationOf({ orgId: ORG, runId: PRIOR, grantId: GRANT });
    expect(r).toMatchObject({ ok: true, prior: { stagedInputs: null } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('staged_inputs'), expect.objectContaining({ runId: PRIOR }));
    warn.mockRestore();
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

  it('fails closed (throws) when the aggregate row is missing or not a finite number', async () => {
    // An aggregate always returns one row; anything else must never read as "nothing committed".
    for (const rows of [[], [{ runCount: 1, committedCents: 'NaN' }], [{ runCount: null, committedCents: '5' }]]) {
      const tx = { execute: vi.fn(async () => rows) };
      await expect(chainCommittedCents(tx as never, { orgId: ORG, chainRootRunId: ROOT })).rejects.toThrow(/chain sum/);
    }
  });

  it('an empty chain sums to zero', async () => {
    const tx = { execute: vi.fn(async () => [{ runCount: 0, committedCents: '0' }]) };
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
    const seed = await buildAnalysisContinuationSeed({ orgId: ORG, prior: priorWith(GRANTS), exportGrants: GRANTS });
    expect(seed).toContain('Earlier goal: find BSODs');
    expect(seed).toContain('Earlier summary: outcome summary');
    expect(seed).toContain('- [high] Driver X');
    expect(seed).not.toContain('column summary');
    expect(compile(h.whereArgs[0]).params).toEqual(expect.arrayContaining([PRIOR, ORG]));
  });

  it('falls back to the summary column when there is no readable outcome', async () => {
    h.results.push([{ summary: 'column summary', outcome: {} }]);
    const seed = await buildAnalysisContinuationSeed({ orgId: ORG, prior: priorWith(GRANTS), exportGrants: GRANTS });
    expect(seed).toContain('Earlier summary: column summary');
    expect(seed).toMatch(/Findings:\n\(none\)/);
  });

  it('keeps at most 20 findings', async () => {
    h.results.push([{ summary: null, outcome: { analysis: {
      summary: 's',
      findings: Array.from({ length: 25 }, (_, i) => ({ title: `F${i}`, severity: 'low', detail: 'd', artifactHandles: [] })),
      artifactHandles: [], proposedActions: [],
    } } }]);
    const seed = await buildAnalysisContinuationSeed({ orgId: ORG, prior: priorWith(GRANTS), exportGrants: GRANTS });
    expect(seed).toContain('- [low] F19');
    expect(seed).not.toContain('- [low] F20');
  });

  // Carry-over from the W03 review: the seed is derived from what the prior
  // read, so it follows the same producer-grants rule carried files follow.
  const OUTCOME = [{ summary: 'col', outcome: { analysis: {
    summary: 'the secret summary',
    findings: [{ title: 'security finding', severity: 'high', detail: 'd', artifactHandles: [] }],
    artifactHandles: [], proposedActions: [],
  } } }];
  const priorWith = (exportGrants: unknown) =>
    prior({ goal: 'find BSODs', stagedInputs: { handles: [], deviceIds: [], region: 'eu', exportGrants } as never });

  it('keeps the summary and findings when the prior held a strict subset of this launch\'s grants', async () => {
    h.results.push(OUTCOME);
    const seed = await buildAnalysisContinuationSeed({
      orgId: ORG,
      prior: priorWith({ datasets: ['event_logs'], sensitiveGates: [] }),
      exportGrants: { datasets: ['event_logs', 'metrics'], sensitiveGates: ['security_events'] },
    });
    expect(seed).toContain('Earlier summary: the secret summary');
    expect(seed).toContain('- [high] security finding');
  });

  it.each([
    ['a sensitive gate this launch lacks', { datasets: ['event_logs'], sensitiveGates: ['security_events'] }],
    ['a dataset this launch lacks', { datasets: ['event_logs', 'vulnerabilities'], sensitiveGates: [] }],
    ['no recorded grants', undefined],
    ['malformed grants', { datasets: 'event_logs' }],
  ])('withholds the summary and findings when the prior held %s, and keeps the goal', async (_label, producerGrants) => {
    h.results.push(OUTCOME);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const seed = await buildAnalysisContinuationSeed({
        orgId: ORG,
        prior: priorWith(producerGrants),
        exportGrants: { datasets: ['event_logs', 'metrics'], sensitiveGates: [] },
      });
      expect(seed).not.toContain('the secret summary');
      expect(seed).not.toContain('security finding');
      expect(seed).not.toContain('col');
      expect(seed).toContain('Earlier goal: find BSODs');
      expect(seed).toContain('not included');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('seed withheld'), expect.objectContaining({ runId: PRIOR }));
    } finally {
      warn.mockRestore();
    }
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
