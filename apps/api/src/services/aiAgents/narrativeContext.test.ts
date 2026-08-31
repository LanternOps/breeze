/**
 * Phase 2 wave P2-3 (weekly org narrative) task 5 — the bounded 7-day org
 * context.
 *
 * Two suites, same split as `sweepEvidence.test.ts`:
 *  - the PURE assembler (`assembleNarrativeContext`), driven entirely from
 *    fixtures: the top-N caps, the WHOLE-context byte ceiling and its trim
 *    ORDER, name sanitizing, and the honest availability/`unavailable`
 *    bookkeeping;
 *  - the DB loaders, asserted on their COMPILED SQL rather than on an opaque
 *    builder chain: the org pin actually bound on the primary AND every
 *    joined tenant-bearing table, the rule-owner admission clause, the
 *    category `partner_id` join, `LIMIT 11` on the two top-N statements, the
 *    `jsonb_typeof` guards, and per-loader failure isolation. Real-Postgres
 *    proof lives in the wave's integration suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_ALERT_VERDICT_CLASSIFICATIONS, AI_SWEEP_KINDS, AI_SWEEP_SEVERITIES } from '@breeze/shared';

/** Raw drizzle SQL objects handed to db.execute(), in call order. */
const executed: unknown[] = [];
/** SQL fragments whose statement must REJECT (per-loader isolation tests). */
let failOn: string[] = [];
/** Rows to serve, matched by an SQL fragment rather than by call index, so a
 *  reordered loader list does not silently re-point the fixtures. */
let rowsFor: Array<{ match: string; rows: unknown[] }> = [];
/** Opt-in: once a statement has failed, every LATER statement fails too —
 *  the real 25P02 "current transaction is aborted" behaviour of the single
 *  shared transaction every loader runs inside. Off by default so the other
 *  tests can exercise one failure at a time. */
let poisonAfterFailure = false;
let poisoned = false;

vi.mock('../../db', () => ({
  db: {
    execute: vi.fn((statement: unknown) => {
      executed.push(statement);
      const text = compiled(statement);
      if (poisoned) {
        return Promise.reject(new Error('current transaction is aborted, commands ignored until end of transaction block'));
      }
      if (failOn.some((fragment) => text.includes(fragment))) {
        if (poisonAfterFailure) poisoned = true;
        return Promise.reject(new Error('db unavailable'));
      }
      const hit = rowsFor.find((entry) => text.includes(entry.match));
      return Promise.resolve(hit ? hit.rows : []);
    }),
  },
}));

/** Arguments every `getSecurityPostureTrend` call was made with. */
const postureCalls: unknown[] = [];
let postureRows: Array<Record<string, string | number>> = [];
let postureRejects = false;

vi.mock('../sentry', () => ({ captureException: vi.fn() }));

vi.mock('../securityPosture', () => ({
  getSecurityPostureTrend: vi.fn((params: unknown) => {
    postureCalls.push(params);
    return postureRejects
      ? Promise.reject(new Error('posture unavailable'))
      : Promise.resolve(postureRows);
  }),
}));

import { captureException } from '../sentry';
import {
  assembleNarrativeContext,
  loadNarrativeContext,
  NARRATIVE_CONTEXT_HARD_LIMIT_BYTES,
  NARRATIVE_TOP_N,
  type RawNarrativeInputs,
} from './narrativeContext';

// --- compiled-SQL helpers (the P2-2 sweepEvidence.test.ts idiom) ----------
function sqlText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) return n.queryChunks.map(sqlText).join('');
  if (Array.isArray(n.value) && !('encoder' in n)) return (n.value as unknown[]).join('');
  return '';
}
function boundParams(node: unknown, out: unknown[] = []): unknown[] {
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean' || node instanceof Date) {
    out.push(node);
    return out;
  }
  // A `null` interpolated into a drizzle template is a BOUND null chunk, not
  // an absent one — the distinction the fail-closed partner clause rests on.
  if (node === null) {
    out.push(null);
    return out;
  }
  if (typeof node !== 'object') return out;
  // drizzle renders an interpolated JS array as a parenthesised list of
  // individually bound chunks (`IN ($1, $2)`), so flatten into the elements.
  if (Array.isArray(node)) {
    for (const chunk of node) boundParams(chunk, out);
    return out;
  }
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) {
    for (const chunk of n.queryChunks) boundParams(chunk, out);
    return out;
  }
  if ('encoder' in n && 'value' in n) out.push(n.value);
  return out;
}
/** Whitespace-collapsed SQL of one statement. */
function compiled(node: unknown): string {
  return sqlText(node).replace(/\s+/g, ' ');
}
/** The one executed statement containing `fragment` (fails loudly if the
 *  fragment matched zero or several statements — an ambiguous match would
 *  make every assertion below it meaningless). */
function stmt(fragment: string): { sql: string; params: unknown[] } {
  const hits = executed.filter((node) => compiled(node).includes(fragment));
  expect(hits, `expected exactly one statement containing ${fragment}`).toHaveLength(1);
  return { sql: compiled(hits[0]), params: boundParams(hits[0]) };
}
function orgPins(sql: string): number {
  return (sql.match(/org_id = /g) ?? []).length;
}

// --- assembler fixtures ---------------------------------------------------
const PERIOD = { start: '2026-08-22T07:00:00+00:00', end: '2026-08-29T07:00:00+00:00' };

const zeroed = <K extends string>(keys: readonly K[]): Record<K, number> => {
  const out = {} as Record<K, number>;
  for (const key of keys) out[key] = 0;
  return out;
};

function rawInputs(overrides: Partial<RawNarrativeInputs> = {}): RawNarrativeInputs {
  return {
    period: PERIOD,
    org: { name: 'Acme Ltd', partnerName: 'Northwind MSP', timezone: 'UTC', deviceCount: 12, siteCount: 2 },
    alerts: {
      created: 40, resolved: 33, autoResolved: 18, critical: 4, currentlySuppressed: 1,
      topRules: [{ name: 'Disk space low', count: 12, highOrCritical: 3 }],
      verdicts: { ...zeroed(AI_ALERT_VERDICT_CLASSIFICATIONS), actionable: 5 },
      feedbackUp: 3, feedbackDown: 1, groupsCreated: 2,
    },
    sweeps: {
      runs: 7, completed: 6, failed: 1,
      findingsByKind: { ...zeroed(AI_SWEEP_KINDS), disk_pressure: 4 },
      findingsBySeverity: { ...zeroed(AI_SWEEP_SEVERITIES), high: 4 },
      proposals: { intent_created: 2, refused: 1, cap_reached: 0, error: 0 },
      evidenceTruncatedRuns: 1,
    },
    fixes: {
      runVerdicts: { remediated: 3, needs_attention: 1, partial: 0, no_action: 2 },
      intentsByStatus: { pending_approval: 2, approved: 1, executing: 0, completed: 4, failed: 0, rejected: 0, expired: 1, cancelled: 0 },
      watches: { heldQualified: 2, recurred: 1, inconclusive: 0, watching: 3 },
    },
    tickets: {
      opened: 9, closed: 7, openedHigh: 2,
      byCategory: [{ name: 'Hardware', opened: 4, closed: 3 }],
    },
    patching: {
      patchScoreThisWeek: 88.2, patchScorePriorWeek: 81.5, overallScoreThisWeek: 76,
      pendingPatches: 31, devicesPending: 6, installed7d: 54,
    },
    backups: { ok: 18, failed: 2, partial: 0, devicesFailed: 1 },
    fleet: {
      total: 12, online: 10, offline: 2, decommissioned: 0,
      enrolled7d: 1, stale: 1, avgUptime7dPct: 97.4,
    },
    ...overrides,
  };
}

const longName = (i: number) => `rule-${i}-${'x'.repeat(240)}`;

describe('assembleNarrativeContext', () => {
  it('passes a small context through untouched and reports it as measured', () => {
    const ctx = assembleNarrativeContext(rawInputs());
    expect(ctx.truncated).toBe(false);
    expect(ctx.period).toEqual(PERIOD);
    expect(ctx.org).toEqual({ name: 'Acme Ltd', partnerName: 'Northwind MSP', timezone: 'UTC', deviceCount: 12, siteCount: 2 });
    expect(ctx.alerts.available).toBe(true);
    expect(ctx.alerts.topRules).toEqual([{ name: 'Disk space low', count: 12, highOrCritical: 3 }]);
    expect(ctx.alerts.topRulesTruncated).toBe(false);
    expect(ctx.sweeps.available).toBe(true);
    expect(ctx.fixes.available).toBe(true);
    expect(ctx.tickets.available).toBe(true);
    expect(ctx.tickets.byCategoryTruncated).toBe(false);
    expect(ctx.patching.available).toBe(true);
    expect(ctx.backups.available).toBe(true);
    expect(ctx.fleet.available).toBe(true);
  });

  // The two fixed keys are STRUCTURAL, not incidental: `alerts.suppressed_at`
  // does not exist and devices keep no status history, so those two figures
  // can never be measured however healthy the loaders are.
  it('always reports the two structurally unmeasurable inputs', () => {
    const ctx = assembleNarrativeContext(rawInputs());
    expect(ctx.unavailable).toEqual(['alerts.suppressedInWindow', 'fleet.onlineOfflineDelta']);
    expect(ctx.fleet.deltaAvailable).toBe(false);
  });

  it('derives the backup terminal total and success rate from the three outcome counts', () => {
    const ctx = assembleNarrativeContext(rawInputs());
    expect(ctx.backups.terminal).toBe(20);
    expect(ctx.backups.successRatePct).toBe(90);
  });

  it('reports a null success rate — not 0 — when no backup job reached a terminal state', () => {
    const ctx = assembleNarrativeContext(rawInputs({ backups: { ok: 0, failed: 0, partial: 0, devicesFailed: 0 } }));
    expect(ctx.backups.terminal).toBe(0);
    expect(ctx.backups.successRatePct).toBeNull();
  });

  it(`caps topRules at ${NARRATIVE_TOP_N} and flags it when the loader returned N+1`, () => {
    const topRules = Array.from({ length: NARRATIVE_TOP_N + 1 }, (_, i) => ({ name: `rule-${i}`, count: 20 - i, highOrCritical: 1 }));
    const ctx = assembleNarrativeContext(rawInputs({ alerts: { ...rawInputs().alerts!, topRules } }));
    expect(ctx.alerts.topRules).toHaveLength(NARRATIVE_TOP_N);
    expect(ctx.alerts.topRules[0]!.name).toBe('rule-0');
    expect(ctx.alerts.topRulesTruncated).toBe(true);
    // The N-cap is not a byte-ceiling event: `truncated` means the WHOLE
    // context had to be trimmed, which is a different (and much louder) fact.
    expect(ctx.truncated).toBe(false);
  });

  it(`caps byCategory at ${NARRATIVE_TOP_N} and flags it when the loader returned N+1`, () => {
    const byCategory = Array.from({ length: NARRATIVE_TOP_N + 1 }, (_, i) => ({ name: `cat-${i}`, opened: 20 - i, closed: 1 }));
    const ctx = assembleNarrativeContext(rawInputs({ tickets: { ...rawInputs().tickets!, byCategory } }));
    expect(ctx.tickets.byCategory).toHaveLength(NARRATIVE_TOP_N);
    expect(ctx.tickets.byCategoryTruncated).toBe(true);
    expect(ctx.truncated).toBe(false);
  });

  // The ceiling is measured over the ENTIRE serialized context (not per
  // array), and it drops the least load-bearing list first: a ticket-category
  // breakdown is nice to have, the noisiest alert rules are the story.
  it('trims to the byte ceiling by dropping the category tail FIRST, then the rule tail', () => {
    const topRules = Array.from({ length: NARRATIVE_TOP_N }, (_, i) => ({ name: longName(i), count: 20 - i, highOrCritical: 1 }));
    const byCategory = Array.from({ length: NARRATIVE_TOP_N }, (_, i) => ({ name: longName(100 + i), opened: 20 - i, closed: 1 }));
    const raw = rawInputs({
      alerts: { ...rawInputs().alerts!, topRules },
      tickets: { ...rawInputs().tickets!, byCategory },
    });

    // A ceiling that only the categories have to give way to.
    const roomy = assembleNarrativeContext(raw, { limitBytes: 5000 });
    expect(Buffer.byteLength(JSON.stringify(roomy), 'utf8')).toBeLessThanOrEqual(5000);
    expect(roomy.truncated).toBe(true);
    expect(roomy.tickets.byCategory.length).toBeLessThan(NARRATIVE_TOP_N);
    expect(roomy.tickets.byCategoryTruncated).toBe(true);
    expect(roomy.alerts.topRules).toHaveLength(NARRATIVE_TOP_N);
    expect(roomy.alerts.topRulesTruncated).toBe(false);

    // A ceiling tight enough that the rules must give way too — and only
    // after the categories are exhausted.
    const tight = assembleNarrativeContext(raw, { limitBytes: 2000 });
    expect(Buffer.byteLength(JSON.stringify(tight), 'utf8')).toBeLessThanOrEqual(2000);
    expect(tight.tickets.byCategory).toHaveLength(0);
    expect(tight.alerts.topRules.length).toBeLessThan(NARRATIVE_TOP_N);
    expect(tight.alerts.topRulesTruncated).toBe(true);
    expect(tight.truncated).toBe(true);
  });

  it('never emits a partial entry when trimming — every surviving entry is whole', () => {
    const topRules = Array.from({ length: NARRATIVE_TOP_N }, (_, i) => ({ name: longName(i), count: 20 - i, highOrCritical: 1 }));
    const ctx = assembleNarrativeContext(rawInputs({ alerts: { ...rawInputs().alerts!, topRules } }), { limitBytes: 2200 });
    expect(ctx.alerts.topRules.length).toBeGreaterThan(0);
    for (const rule of ctx.alerts.topRules) {
      // Whole entries only: a name is never sliced to make the budget fit,
      // and no field is dropped off an entry that survives.
      expect(rule.name).toMatch(/^rule-\d+-x{240}$/);
      expect(typeof rule.count).toBe('number');
      expect(typeof rule.highOrCritical).toBe('number');
    }
  });

  it('bails out rather than spinning when the envelope alone exceeds the ceiling', () => {
    const ctx = assembleNarrativeContext(rawInputs(), { limitBytes: 10 });
    expect(ctx.alerts.topRules).toHaveLength(0);
    expect(ctx.tickets.byCategory).toHaveLength(0);
    expect(ctx.truncated).toBe(true);
  });

  // Operator-authored names are the ONLY free-ish text this context carries.
  // A rule named with an embedded newline would forge a line in the
  // line-oriented narrative prompt — same hole `sanitizeSweepText` closes for
  // sweep evidence.
  it('flattens control characters in every operator-authored name and clamps to 256', () => {
    const ctx = assembleNarrativeContext(rawInputs({
      org: { name: 'Acme\nLtd', partnerName: 'North‮wind', timezone: 'UTC', deviceCount: 1, siteCount: 1 },
      alerts: { ...rawInputs().alerts!, topRules: [{ name: `Disk\nlow ${'y'.repeat(400)}`, count: 1, highOrCritical: 0 }] },
      tickets: { ...rawInputs().tickets!, byCategory: [{ name: 'Hard\tware', opened: 1, closed: 0 }] },
    }));
    expect(ctx.org.name).toBe('Acme Ltd');
    expect(ctx.org.partnerName).toBe('North wind');
    expect(ctx.tickets.byCategory[0]!.name).toBe('Hard ware');
    const ruleName = ctx.alerts.topRules[0]!.name;
    expect(ruleName).not.toContain('\n');
    expect(ruleName.length).toBeLessThanOrEqual(256);
  });

  // "The posture snapshots exist and say 88" and "nobody has computed a
  // posture snapshot for this org" are different facts; only the second may
  // read as unavailable, and the outstanding-patch counters stay measured
  // either way.
  it('reports patching as unavailable when neither posture snapshot exists, keeping the counters', () => {
    const ctx = assembleNarrativeContext(rawInputs({
      patching: { patchScoreThisWeek: null, patchScorePriorWeek: null, overallScoreThisWeek: null, pendingPatches: 31, devicesPending: 6, installed7d: 54 },
    }));
    expect(ctx.patching.available).toBe(false);
    expect(ctx.patching.pendingPatches).toBe(31);
    expect(ctx.unavailable).toContain('patching.postureScores');
    expect(ctx.unavailable).not.toContain('patching');
  });

  it('keeps patching available when only the prior week is missing (a first-week org)', () => {
    const ctx = assembleNarrativeContext(rawInputs({
      patching: { patchScoreThisWeek: 88, patchScorePriorWeek: null, overallScoreThisWeek: 70, pendingPatches: 0, devicesPending: 0, installed7d: 0 },
    }));
    expect(ctx.patching.available).toBe(true);
    expect(ctx.patching.patchScorePriorWeek).toBeNull();
  });

  it('zeroes a rejected block, names it in `unavailable`, and leaves every other block intact', () => {
    const ctx = assembleNarrativeContext(rawInputs({ tickets: null, backups: null }));
    expect(ctx.tickets).toEqual({ available: false, opened: 0, closed: 0, openedHigh: 0, byCategory: [], byCategoryTruncated: false });
    expect(ctx.backups.available).toBe(false);
    expect(ctx.backups.successRatePct).toBeNull();
    expect(ctx.unavailable).toContain('tickets');
    expect(ctx.unavailable).toContain('backups');
    // Everything else still measured.
    expect(ctx.alerts.available).toBe(true);
    expect(ctx.alerts.created).toBe(40);
    expect(ctx.fleet.avgUptime7dPct).toBe(97.4);
  });

  it('falls back to an empty header — never a throw — when the header loader rejected', () => {
    const ctx = assembleNarrativeContext(rawInputs({ org: null }));
    expect(ctx.org).toEqual({ name: '', partnerName: '', timezone: 'UTC', deviceCount: 0, siteCount: 0 });
    expect(ctx.unavailable).toContain('org');
  });

  it('emits every closed-enum bucket, zero-filled, so a missing key never reads as a missing measurement', () => {
    const ctx = assembleNarrativeContext(rawInputs({ sweeps: null, fixes: null, alerts: null }));
    expect(Object.keys(ctx.sweeps.findingsByKind).sort()).toEqual([...AI_SWEEP_KINDS].sort());
    expect(Object.keys(ctx.sweeps.findingsBySeverity).sort()).toEqual([...AI_SWEEP_SEVERITIES].sort());
    expect(Object.keys(ctx.sweeps.proposals).sort()).toEqual(['cap_reached', 'error', 'intent_created', 'refused']);
    expect(Object.keys(ctx.alerts.verdicts).sort()).toEqual([...AI_ALERT_VERDICT_CLASSIFICATIONS].sort());
    expect(Object.keys(ctx.fixes.runVerdicts).sort()).toEqual(['needs_attention', 'no_action', 'partial', 'remediated']);
    expect(Object.values(ctx.sweeps.findingsByKind).every((v) => v === 0)).toBe(true);
  });

  it('holds the real 16-KiB ceiling for the largest context the caps can produce', () => {
    const topRules = Array.from({ length: NARRATIVE_TOP_N + 1 }, (_, i) => ({ name: longName(i), count: 1, highOrCritical: 1 }));
    const byCategory = Array.from({ length: NARRATIVE_TOP_N + 1 }, (_, i) => ({ name: longName(100 + i), opened: 1, closed: 1 }));
    const ctx = assembleNarrativeContext(rawInputs({
      org: { name: 'o'.repeat(500), partnerName: 'p'.repeat(500), timezone: 'Australia/Lord_Howe', deviceCount: 9999, siteCount: 99 },
      alerts: { ...rawInputs().alerts!, topRules },
      tickets: { ...rawInputs().tickets!, byCategory },
    }));
    expect(Buffer.byteLength(JSON.stringify(ctx), 'utf8')).toBeLessThanOrEqual(NARRATIVE_CONTEXT_HARD_LIMIT_BYTES);
  });
});

// -------------------------------------------------------------------------

const ORG = 'org-9';
const PARTNER = 'partner-7';
const HEADER_ROWS = [{
  org_name: 'Acme Ltd', partner_id: PARTNER, partner_name: 'Northwind MSP',
  timezone: 'UTC', device_count: 12, site_count: 2,
}];

describe('loadNarrativeContext', () => {
  /** Loader failures are REPORTED, so the failure tests would otherwise spray
   *  the suite output. Captured rather than merely silenced — the telemetry
   *  test reads it back. */
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    executed.length = 0;
    failOn = [];
    poisonAfterFailure = false;
    poisoned = false;
    rowsFor = [{ match: 'FROM organizations', rows: HEADER_ROWS }];
    postureCalls.length = 0;
    postureRows = [];
    postureRejects = false;
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /** The reported loader-failure warnings, in call order. */
  const reportedFailures = (): Array<Record<string, unknown>> => (warnSpy.mock.calls as unknown[][])
    .filter((call) => String(call[0]).includes('context loader failed'))
    .map((call) => call[1] as Record<string, unknown>);

  it('resolves the org header and its partner from `organizations`, pinned by org id', async () => {
    const ctx = await loadNarrativeContext(ORG);
    const { sql, params } = stmt('FROM organizations');
    expect(sql).toContain('JOIN partners');
    // Primary pinned id-keyed (`o.id`), plus one pin per counted child table.
    expect(sql).toContain('o.id = ');
    expect(orgPins(sql)).toBe(2);
    expect(params.filter((v) => v === ORG)).toHaveLength(3);
    expect(ctx.org.name).toBe('Acme Ltd');
    expect(ctx.org.partnerName).toBe('Northwind MSP');
  });

  // Every statement runs under a SYSTEM DB context (full RLS bypass), so the
  // org predicate in the statement is the ONLY thing keeping one tenant's
  // narrative out of another tenant's rows.
  it('pins the org on EVERY statement it runs', async () => {
    await loadNarrativeContext(ORG);
    expect(executed.length).toBeGreaterThan(10);
    for (const node of executed) {
      const sql = compiled(node);
      expect(sql, sql).toMatch(/org_id = |o\.id = /);
      expect(boundParams(node), sql).toContain(ORG);
    }
  });

  it('never selects a free-text column from any table it reads', async () => {
    await loadNarrativeContext(ORG);
    const all = executed.map(compiled).join(' | ');
    for (const forbidden of ['t.subject', 't.description', 'a.title', 'a.message', 'bj.error_log', 'v.rationale', 'resolution_note', "->>'title'", "->>'detail'", "->>'evidence'"]) {
      expect(all, forbidden).not.toContain(forbidden);
    }
  });

  it('counts the alert lifecycle on alerts.org_id and reads an operator-less resolve as auto', async () => {
    await loadNarrativeContext(ORG);
    const { sql } = stmt('FROM alerts a WHERE');
    expect(orgPins(sql)).toBe(1);
    expect(sql).toContain('a.resolved_by IS NULL');
    expect(sql).toContain("a.severity = 'critical'");
    // Suppression is a CURRENT-STATE count: there is no suppressed_at column
    // to window on (reported via `unavailable`).
    expect(sql).toContain("a.status = 'suppressed'");
    expect(sql).not.toContain('suppressed_at');
  });

  // A partner-wide rule (org_id NULL) legitimately owns this org's alerts;
  // ANOTHER partner's rule never does. The admission lives in the ON clause,
  // so an inadmissible rule degrades the row to "no rule" instead of
  // surfacing a foreign tenant's rule name.
  it('admits a rule owner only when it is this org OR this org’s partner', async () => {
    await loadNarrativeContext(ORG);
    const { sql, params } = stmt('alert_rules r');
    expect(sql).toContain('LEFT JOIN alert_rules r ON r.id = a.rule_id');
    expect(sql).toContain('r.org_id = ');
    expect(sql).toContain('r.org_id IS NULL AND r.partner_id = ');
    expect(orgPins(sql)).toBe(2);
    expect(params.filter((v) => v === ORG)).toHaveLength(2);
    expect(params).toContain(PARTNER);
    // N+1 so the assembler can SEE that an 11th rule exists.
    expect(sql).toContain('LIMIT');
    expect(params).toContain(NARRATIVE_TOP_N + 1);
  });

  it('histograms only LIVE alert verdicts', async () => {
    await loadNarrativeContext(ORG);
    const { sql } = stmt('ai_alert_verdicts');
    expect(sql).toContain('v.superseded_by IS NULL');
    expect(orgPins(sql)).toBe(1);
    expect(sql).toContain("v.feedback = 'up'");
  });

  it('counts correlation groups created in the window', async () => {
    await loadNarrativeContext(ORG);
    const { sql } = stmt('alert_correlation_groups');
    expect(orgPins(sql)).toBe(1);
  });

  it('reads sweep runs on queued_at for the sweep profile only', async () => {
    await loadNarrativeContext(ORG);
    const { sql } = stmt('AS evidence_truncated_runs');
    expect(sql).toContain("r.profile = 'sweep'");
    expect(sql).toContain('r.queued_at >= ');
    expect(sql).toContain("r.status = 'completed'");
    expect(orgPins(sql)).toBe(1);
  });

  // A non-array `outcome` key would make `jsonb_array_elements` raise, taking
  // the whole loader down; the CASE guard keeps a malformed row as "no
  // findings" instead. WHERE-clause guards are NOT enough — the set-returning
  // function is not guaranteed to be evaluated after the filter.
  it('guards every jsonb array expansion with jsonb_typeof', async () => {
    await loadNarrativeContext(ORG);
    const findings = stmt("outcome->'sweepFindings'->'findings'");
    expect(findings.sql).toContain("jsonb_typeof(r.outcome->'sweepFindings'->'findings') = 'array'");
    expect(findings.sql).toContain('jsonb_array_elements');
    expect(orgPins(findings.sql)).toBe(1);
    const proposals = stmt("outcome->'sweepProposals'");
    expect(proposals.sql).toContain("jsonb_typeof(r.outcome->'sweepProposals') = 'array'");
    expect(orgPins(proposals.sql)).toBe(1);
  });

  it('buckets sweep findings and proposals against the closed shared enums, dropping anything else', async () => {
    rowsFor.push(
      { match: "outcome->'sweepFindings'->'findings'", rows: [
        { kind: 'disk_pressure', severity: 'high', count: 4 },
        { kind: 'not_a_kind', severity: 'nonsense', count: 99 },
        { kind: null, severity: null, count: 3 },
      ] },
      { match: "outcome->'sweepProposals'", rows: [
        { disposition: 'intent_created', count: 2 },
        { disposition: 'exfiltrate', count: 7 },
      ] },
    );
    const ctx = await loadNarrativeContext(ORG);
    expect(ctx.sweeps.findingsByKind.disk_pressure).toBe(4);
    expect(ctx.sweeps.findingsBySeverity.high).toBe(4);
    expect(Object.values(ctx.sweeps.findingsByKind).reduce((a, b) => a + b, 0)).toBe(4);
    expect(ctx.sweeps.proposals.intent_created).toBe(2);
    expect(Object.keys(ctx.sweeps.proposals)).not.toContain('exfiltrate');
  });

  it('reads the fix lane from run verdicts, ai_agent intents and fix watches — each org-pinned', async () => {
    rowsFor.push(
      { match: "outcome->>'runVerdict'", rows: [{ run_verdict: 'remediated', count: 3 }, { run_verdict: 'made_up', count: 9 }] },
      { match: 'FROM action_intents', rows: [{ status: 'completed', count: 4 }, { status: 'nope', count: 2 }] },
      { match: 'ai_agent_fix_watches', rows: [{ state: 'held_qualified', count: 2 }, { state: 'watching', count: 3 }, { state: 'pending', count: 5 }] },
    );
    const ctx = await loadNarrativeContext(ORG);

    const verdicts = stmt("outcome->>'runVerdict'");
    expect(orgPins(verdicts.sql)).toBe(1);
    const intents = stmt('FROM action_intents');
    expect(intents.sql).toContain("i.source = 'ai_agent'");
    expect(orgPins(intents.sql)).toBe(1);
    const watches = stmt('ai_agent_fix_watches');
    expect(orgPins(watches.sql)).toBe(1);

    expect(ctx.fixes.runVerdicts.remediated).toBe(3);
    expect(Object.keys(ctx.fixes.runVerdicts)).not.toContain('made_up');
    expect(ctx.fixes.intentsByStatus.completed).toBe(4);
    expect(ctx.fixes.intentsByStatus).not.toHaveProperty('nope');
    expect(ctx.fixes.watches).toEqual({ heldQualified: 2, recurred: 0, inconclusive: 0, watching: 3 });
  });

  it('joins ticket categories on the org’s partner and hides soft-deleted tickets', async () => {
    await loadNarrativeContext(ORG);
    const { sql, params } = stmt('ticket_categories c');
    expect(sql).toContain('JOIN ticket_categories c ON c.id = t.category_id AND c.partner_id = ');
    expect(params).toContain(PARTNER);
    expect(orgPins(sql)).toBe(1);
    expect(sql).toContain('t.deleted_at IS NULL');
    expect(params).toContain(NARRATIVE_TOP_N + 1);

    const totals = stmt('AS opened_high');
    expect(totals.sql).toContain('t.deleted_at IS NULL');
    expect(totals.sql).toContain("t.priority IN ('high', 'urgent')");
    expect(orgPins(totals.sql)).toBe(1);
  });

  // Omitting BOTH org filters makes getSecurityPostureTrend return
  // FLEET-WIDE data (securityPosture.ts:1077) — a cross-tenant leak straight
  // into a customer-facing narrative.
  it('always scopes the posture trend to this org over a 14-day window', async () => {
    await loadNarrativeContext(ORG);
    expect(postureCalls).toEqual([{ orgId: ORG, days: 14 }]);
  });

  it('splits the posture day-buckets into this week and the prior week', async () => {
    vi.setSystemTime(new Date('2026-08-29T07:00:00.000Z'));
    postureRows = [
      { timestamp: '2026-08-16', patch_compliance: 60, overall: 50 },  // prior week
      { timestamp: '2026-08-20', patch_compliance: 70, overall: 55 },  // prior week
      { timestamp: '2026-08-25', patch_compliance: 90, overall: 80 },  // this week
      { timestamp: '2026-08-28', patch_compliance: 80, overall: 70 },  // this week
    ];
    const ctx = await loadNarrativeContext(ORG);
    expect(ctx.patching.patchScoreThisWeek).toBe(85);
    expect(ctx.patching.patchScorePriorWeek).toBe(65);
    expect(ctx.patching.overallScoreThisWeek).toBe(75);
    vi.useRealTimers();
  });

  it('counts outstanding and installed patches through a device join pinned on both sides', async () => {
    await loadNarrativeContext(ORG);
    const { sql, params } = stmt('FROM device_patches');
    expect(sql).toContain('JOIN devices d ON d.id = dp.device_id');
    expect(orgPins(sql)).toBe(2);
    expect(params.filter((v) => v === ORG)).toHaveLength(2);
    expect(sql).toContain('d.is_ephemeral = false');
    // The outstanding set is the shared constant, bound — never an inline
    // literal that could drift from OUTSTANDING_DEVICE_PATCH_STATUSES.
    expect(sql).toContain('dp.status::text IN');
    expect(params).toContain('pending');
    expect(sql).toContain('dp.installed_at >= ');
  });

  it('counts terminal backup outcomes through a device join pinned on both sides', async () => {
    await loadNarrativeContext(ORG);
    const { sql, params } = stmt('FROM backup_jobs');
    expect(sql).toContain('JOIN devices d ON d.id = bj.device_id');
    expect(orgPins(sql)).toBe(2);
    expect(params.filter((v) => v === ORG)).toHaveLength(2);
    expect(sql).toContain("bj.status = 'completed'");
    expect(sql).toContain("bj.status = 'failed'");
  });

  it('reads current fleet state plus mean 7-day uptime, pinning the reliability join too', async () => {
    rowsFor.push({ match: 'device_reliability', rows: [{
      total: 12, online: 10, offline: 2, decommissioned: 0, enrolled_7d: 1, stale: 1, avg_uptime_7d: 97.44,
    }] });
    const ctx = await loadNarrativeContext(ORG);
    const { sql, params } = stmt('device_reliability');
    expect(sql).toContain('LEFT JOIN device_reliability rel ON rel.device_id = d.id');
    expect(orgPins(sql)).toBe(2);
    expect(params.filter((v) => v === ORG)).toHaveLength(2);
    expect(sql).toContain('d.is_ephemeral = false');
    expect(ctx.fleet.avgUptime7dPct).toBe(97.4);
    expect(ctx.fleet.deltaAvailable).toBe(false);
    expect(ctx.unavailable).toContain('fleet.onlineOfflineDelta');
  });

  // Per-loader isolation is the whole reason for `Promise.allSettled`: a
  // rejected loader must cost exactly ONE block, not the entire narrative.
  //
  // This mock lets the later statements succeed, which a real shared
  // transaction would NOT (see the cascade test below) — so what this proves
  // is the `settled` wrapper itself: the rejection is converted, not
  // propagated, and the blocks that DID produce numbers keep them.
  it('a loader that rejects costs its own block', async () => {
    failOn = ['FROM backup_jobs'];
    rowsFor.push({ match: 'device_reliability', rows: [{ total: 5, online: 5, offline: 0, decommissioned: 0, enrolled_7d: 0, stale: 0, avg_uptime_7d: 99 }] });
    const ctx = await loadNarrativeContext(ORG);
    expect(ctx.backups.available).toBe(false);
    expect(ctx.unavailable).toContain('backups');
    expect(ctx.fleet.available).toBe(true);
    expect(ctx.fleet.total).toBe(5);
    expect(ctx.org.name).toBe('Acme Ltd');
  });

  // The honest version of the above. Every loader shares ONE transaction
  // (`withSystemDbAccessContext` holds it open for the whole call), so a
  // genuine Postgres ERROR aborts it and EVERY later statement fails with
  // 25P02. The contract that has to survive that is not "only one block is
  // lost" — it is "the call still returns, and every block it could not
  // measure says so".
  it('reports every block downstream of an aborted transaction, and still returns', async () => {
    failOn = ['FROM tickets t'];
    poisonAfterFailure = true;
    const ctx = await loadNarrativeContext(ORG);

    // Ran before the abort — real numbers, honestly available.
    expect(ctx.alerts.available).toBe(true);
    expect(ctx.sweeps.available).toBe(true);
    expect(ctx.fixes.available).toBe(true);
    expect(ctx.org.name).toBe('Acme Ltd');

    // The failure and everything after it.
    expect(ctx.tickets.available).toBe(false);
    expect(ctx.patching.available).toBe(false);
    expect(ctx.backups.available).toBe(false);
    expect(ctx.fleet.available).toBe(false);
    expect(ctx.unavailable).toEqual(expect.arrayContaining(['tickets', 'patching', 'backups', 'fleet']));
    expect(ctx.unavailable).not.toContain('alerts');
    expect(ctx.unavailable).not.toContain('sweeps');

    // Every one of them is reported, not swallowed — four blocks broken by
    // one root cause is exactly the signal an operator needs to see.
    expect(reportedFailures().map((entry) => entry.loader))
      .toEqual(['tickets', 'patching', 'backups', 'fleet']);
  });

  // The posture SERVICE is the only source of the two scores, and it fails
  // independently of the patch-counter statement. Collapsing the two would
  // throw away three measured numbers over a failure that has nothing to do
  // with them.
  it('isolates a failed posture service — scores null, the patch counters survive', async () => {
    postureRejects = true;
    rowsFor.push({ match: 'FROM device_patches', rows: [{ pending_patches: 31, devices_pending: 6, installed_7d: 54 }] });
    const ctx = await loadNarrativeContext(ORG);

    expect(ctx.patching.patchScoreThisWeek).toBeNull();
    expect(ctx.patching.patchScorePriorWeek).toBeNull();
    expect(ctx.patching.overallScoreThisWeek).toBeNull();
    expect(ctx.patching.available).toBe(false);

    // The three counters come from a statement that never stopped running.
    expect(ctx.patching.pendingPatches).toBe(31);
    expect(ctx.patching.devicesPending).toBe(6);
    expect(ctx.patching.installed7d).toBe(54);

    // The narrow key, NOT the whole block.
    expect(ctx.unavailable).toContain('patching.postureScores');
    expect(ctx.unavailable).not.toContain('patching');
    expect(ctx.alerts.available).toBe(true);
    expect(reportedFailures().map((entry) => entry.loader)).toEqual(['patching.postureScores']);
  });

  // A loader that fails silently is the worst outcome available: the run
  // still produces a narrative, the prompt says "(not measured)", and nobody
  // ever learns the table is broken.
  it('logs and reports a loader rejection rather than swallowing it', async () => {
    failOn = ['FROM backup_jobs'];
    await loadNarrativeContext(ORG);

    const reported = reportedFailures();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ orgId: ORG, loader: 'backups' });
    expect(reported[0]!.error).toBeInstanceOf(Error);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      expect.objectContaining({ service: 'aiAgents', operation: 'loadNarrativeContext', loader: 'backups', orgId: ORG }),
    );
  });

  // A rejected header leaves no partnerId, and a NULL partner must FAIL
  // CLOSED: `r.partner_id = NULL` admits nothing rather than everything.
  it('survives a failed header loader and binds no partner-wide admission', async () => {
    failOn = ['FROM organizations'];
    const ctx = await loadNarrativeContext(ORG);
    expect(ctx.org).toEqual({ name: '', partnerName: '', timezone: 'UTC', deviceCount: 0, siteCount: 0 });
    expect(ctx.unavailable).toContain('org');
    const { params } = stmt('alert_rules r');
    expect(params).toContain(null);
    expect(params.filter((v) => v === ORG)).toHaveLength(2);
  });

  it('never throws, even when every single statement fails', async () => {
    failOn = ['SELECT'];
    postureRejects = true;
    const ctx = await loadNarrativeContext(ORG);
    expect(ctx.unavailable).toEqual(expect.arrayContaining([
      'alerts.suppressedInWindow', 'fleet.onlineOfflineDelta',
      'org', 'alerts', 'sweeps', 'fixes', 'tickets', 'patching', 'backups', 'fleet',
    ]));
    expect(ctx.truncated).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(ctx), 'utf8')).toBeLessThanOrEqual(NARRATIVE_CONTEXT_HARD_LIMIT_BYTES);
  });

  it('windows every block on the same 7-day period and renders it in the org timezone', async () => {
    vi.setSystemTime(new Date('2026-08-29T12:00:00.000Z'));
    rowsFor = [{ match: 'FROM organizations', rows: [{ ...HEADER_ROWS[0], timezone: 'America/New_York' }] }];
    const ctx = await loadNarrativeContext(ORG);
    expect(ctx.org.timezone).toBe('America/New_York');
    expect(ctx.period.end).toBe('2026-08-29T08:00:00-04:00');
    expect(ctx.period.start).toBe('2026-08-22T08:00:00-04:00');
    // Every windowed statement binds the SAME two instants — a block windowed
    // on its own `new Date()` would silently report a different week.
    //
    // The bounds are ISO STRINGS, not `Date` objects, and that is load-bearing
    // rather than cosmetic: postgres-js cannot serialise a `Date` bound through
    // a drizzle `sql` template on this path, and it fails OUTSIDE the awaited
    // promise, so `settled()` cannot contain it. See the `Window` docstring and
    // `aiAgentNarrative.integration.test.ts`.
    const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    expect(executed.flatMap((node) => boundParams(node).filter((v) => v instanceof Date))).toEqual([]);
    const bounds = executed.flatMap((node) => boundParams(node)
      .filter((v): v is string => typeof v === 'string' && ISO_INSTANT.test(v)));
    expect(bounds.length).toBeGreaterThan(10);
    expect([...new Set(bounds)].sort()).toEqual(['2026-08-22T12:00:00.000Z', '2026-08-29T12:00:00.000Z']);
    vi.useRealTimers();
  });

  it('falls back to a UTC-rendered period when the stored timezone is not a real zone', async () => {
    vi.setSystemTime(new Date('2026-08-29T12:00:00.000Z'));
    rowsFor = [{ match: 'FROM organizations', rows: [{ ...HEADER_ROWS[0], timezone: 'Not/AZone' }] }];
    const ctx = await loadNarrativeContext(ORG);
    expect(ctx.period.end).toBe('2026-08-29T12:00:00.000Z');
    vi.useRealTimers();
  });
});
