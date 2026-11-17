/**
 * #11426 — rollupDeviceConcerns, the same-org rollup of device concerns that
 * share a pattern. `db.execute` answers by the `/* wisp:… *\/` marker each
 * query carries; the concern writes are mocked. The grouping, the ≥ 3 rule,
 * the parent's severity/summary and the auto-close are decided in TS on the
 * returned rows, so the fixtures below exercise them directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const h = vi.hoisted(() => ({
  enabled: true,
  state: { inSystem: false },
  executes: [] as Array<{ query: unknown; inSystem: boolean }>,
  handler: (_q: unknown): unknown[] => [],
  upsertConcern: vi.fn(),
  updateConcern: vi.fn(async () => undefined),
  resolveConcern: vi.fn(async () => ({ resolved: true, remembered: false })),
  captureException: vi.fn(),
  writesInsideSystem: [] as boolean[],
}));

vi.mock('../../db', () => ({
  db: {
    execute: vi.fn(async (query: unknown) => {
      h.executes.push({ query, inSystem: h.state.inSystem });
      return h.handler(query);
    }),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    h.state.inSystem = true;
    try { return await fn(); } finally { h.state.inSystem = false; }
  }),
}));
vi.mock('../../config/env', () => ({ wispEnabled: () => h.enabled }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));
const track = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => {
  h.writesInsideSystem.push(h.state.inSystem);
  return fn(...a);
};
vi.mock('./concerns', () => ({
  upsertConcern: (...a: unknown[]) => track(h.upsertConcern)(...a),
  updateConcern: (...a: unknown[]) => track(h.updateConcern as (...x: unknown[]) => unknown)(...a),
  resolveConcern: (...a: unknown[]) => track(h.resolveConcern as (...x: unknown[]) => unknown)(...a),
}));

import {
  CONCERN_ROLLUP_KIND,
  CONCERN_ROLLUP_OUTCOME,
  fallbackConcernPattern,
  isConcernRollup,
  rollupDeviceConcerns,
  rollupSignature,
} from './concernRollup';

const dialect = new PgDialect();
const NOW = new Date('2026-11-08T12:00:00.000Z');
const HOUR = 3_600_000;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = uid(1);
const OA = uid(11);
const OB = uid(12);
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

type ChildRow = {
  id: string; partner_id: string; org_id: string; severity: string; summary: string;
  pattern: string | null; hostname: string | null; display_name: string | null;
};
type ParentRow = {
  id: string; partner_id: string; org_id: string; signature: string; status: string; outcome: string | null;
  summary: string; severity: string; updated_at: string; evidence: Record<string, unknown>; child_concern_ids: string[]; live_children: number;
};

let children: ChildRow[];
let parents: ParentRow[];

const render = (q: unknown) => dialect.sqlToQuery(q as Parameters<PgDialect['sqlToQuery']>[0]);
const queryWith = (marker: string) => h.executes.map((e) => render(e.query)).filter((r) => r.sql.includes(marker));

function child(n: number, orgId: string, over: Partial<ChildRow> = {}): ChildRow {
  return {
    id: uid(100 + n),
    partner_id: P,
    org_id: orgId,
    severity: 'low',
    summary: `Device ${n} logged an incident_opened event, but Breeze has no incidents`,
    pattern: 'phantom_incident_event',
    hostname: null,
    display_name: null,
    ...over,
  };
}

function parent(n: number, orgId: string, pattern: string, over: Partial<ParentRow> = {}): ParentRow {
  return {
    id: uid(900 + n),
    partner_id: P,
    org_id: orgId,
    signature: rollupSignature(orgId, pattern),
    status: 'open',
    outcome: null,
    summary: '3 devices: phantom incident event',
    severity: 'low',
    updated_at: ago(HOUR),
    evidence: { rollup: CONCERN_ROLLUP_KIND, pattern, deviceCount: 3 },
    child_concern_ids: [],
    live_children: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.enabled = true;
  h.executes = [];
  h.writesInsideSystem = [];
  h.state.inSystem = false;
  children = [];
  parents = [];
  let next = 500;
  h.upsertConcern.mockImplementation(async () => ({ id: uid(next++), created: true }));
  h.handler = (q) => {
    const { sql: text } = render(q);
    if (text.includes('wisp:rollup-children')) return children;
    if (text.includes('wisp:rollup-parents')) return parents;
    throw new Error(`unexpected query: ${text.slice(0, 80)}`);
  };
});

describe('rollupDeviceConcerns', () => {
  it('returns zeros without touching the DB when Wisp is off', async () => {
    h.enabled = false;
    await expect(rollupDeviceConcerns(NOW)).resolves.toEqual({ opened: 0, updated: 0, resolved: 0 });
    expect(h.executes).toHaveLength(0);
  });

  it('folds three device concerns with the same pattern in one org into one org-level parent with three children', async () => {
    children = [
      child(1, OA, { severity: 'low' }),
      child(2, OA, { severity: 'high' }),
      child(3, OA, { severity: 'medium' }),
    ];

    await expect(rollupDeviceConcerns(NOW)).resolves.toEqual({ opened: 1, updated: 0, resolved: 0 });
    expect(h.upsertConcern).toHaveBeenCalledTimes(1);
    const input = h.upsertConcern.mock.calls[0]![0] as Record<string, any>;
    expect(input).toMatchObject({
      partnerId: P,
      orgId: OA,
      // #10386: never the org slot — that belongs to a real org-level concern.
      subject: { kind: 'incident' },
      signature: `${OA}:phantom_incident_event`,
      severity: 'high',
      summary: '3 devices: phantom incident event',
      childConcernIds: [uid(101), uid(102), uid(103)],
      evidence: { rollup: CONCERN_ROLLUP_KIND, pattern: 'phantom_incident_event', deviceCount: 3 },
    });
    expect(input.subject.id).not.toBe(OA);
    expect(input.raisedByGrantId ?? null).toBeNull();
    // Reads in system context; every write after the read block returned.
    expect(h.executes.every((e) => e.inSystem)).toBe(true);
    expect(h.writesInsideSystem).toEqual([false]);
  });

  it('opens nothing for two concerns sharing a pattern', async () => {
    children = [child(1, OA), child(2, OA)];
    await expect(rollupDeviceConcerns(NOW)).resolves.toEqual({ opened: 0, updated: 0, resolved: 0 });
    expect(h.upsertConcern).not.toHaveBeenCalled();
  });

  it('groups unsigned rows (no pattern) by their summary with device names and numbers stripped', async () => {
    children = [
      child(1, OA, { pattern: null, hostname: 'frontdesk', summary: 'frontdesk: incident_opened event, but Breeze has no incidents (2 events).' }),
      child(2, OA, { pattern: null, hostname: 'RECEPTION', display_name: 'Reception PC', summary: 'Reception PC: incident_opened event, but Breeze has no incidents (14 events).' }),
      child(3, OA, { pattern: null, hostname: 'WS-0042', summary: 'WS-0042 incident_opened event, but Breeze has no incidents' }),
    ];
    await rollupDeviceConcerns(NOW);
    expect(h.upsertConcern).toHaveBeenCalledTimes(1);
    expect(h.upsertConcern.mock.calls[0]![0]).toMatchObject({
      signature: `${OA}:incident_opened_event`,
      summary: '3 devices: incident opened event',
      childConcernIds: [uid(101), uid(102), uid(103)],
    });
  });

  it('never rolls up across orgs, and keeps different patterns apart', async () => {
    children = [
      child(1, OA), child(2, OA),
      child(3, OB), child(4, OB), child(5, OB),
      child(6, OB, { pattern: 'browser_critical_cves' }),
      child(7, OB, { pattern: 'browser_critical_cves' }),
      child(8, OB, { pattern: 'Browser Critical CVEs' }),
    ];
    await expect(rollupDeviceConcerns(NOW)).resolves.toEqual({ opened: 2, updated: 0, resolved: 0 });
    const inputs = h.upsertConcern.mock.calls.map((c) => c[0] as Record<string, any>);
    expect(inputs.map((i) => [i.orgId, i.signature, i.childConcernIds])).toEqual([
      [OB, `${OB}:browser_critical_cves`, [uid(106), uid(107), uid(108)]],
      [OB, `${OB}:phantom_incident_event`, [uid(103), uid(104), uid(105)]],
    ]);
  });

  it('updates a live parent with a new child: children are a union, severity and count follow the live members', async () => {
    children = [child(1, OA), child(2, OA), child(3, OA), child(4, OA, { severity: 'medium' })];
    parents = [parent(1, OA, 'phantom_incident_event', { child_concern_ids: [uid(101), uid(102), uid(103)], live_children: 3 })];

    await expect(rollupDeviceConcerns(NOW)).resolves.toEqual({ opened: 0, updated: 1, resolved: 0 });
    expect(h.upsertConcern).not.toHaveBeenCalled();
    expect(h.updateConcern).toHaveBeenCalledWith(uid(901), {
      summary: '4 devices: phantom incident event',
      severity: 'medium',
      childConcernIds: [uid(101), uid(102), uid(103), uid(104)],
      evidence: { rollup: CONCERN_ROLLUP_KIND, pattern: 'phantom_incident_event', deviceCount: 4 },
    });
  });

  it('leaves an unchanged live parent alone', async () => {
    children = [child(1, OA), child(2, OA), child(3, OA)];
    parents = [parent(1, OA, 'phantom_incident_event', { child_concern_ids: [uid(101), uid(102), uid(103)], live_children: 3 })];
    await expect(rollupDeviceConcerns(NOW)).resolves.toEqual({ opened: 0, updated: 0, resolved: 0 });
    expect(h.updateConcern).not.toHaveBeenCalled();
    expect(h.upsertConcern).not.toHaveBeenCalled();
  });

  it(`resolves a live parent whose children are all resolved, with outcome ${'children_resolved'}`, async () => {
    parents = [parent(1, OA, 'phantom_incident_event', { child_concern_ids: [uid(101), uid(102), uid(103)], live_children: 0 })];
    await expect(rollupDeviceConcerns(NOW)).resolves.toEqual({ opened: 0, updated: 0, resolved: 1 });
    expect(CONCERN_ROLLUP_OUTCOME).toBe('children_resolved');
    expect(h.resolveConcern).toHaveBeenCalledWith(uid(901), {}, 'children_resolved');
    // The live-children count is SQL's, over every child id, not this tick's (capped) read.
    expect(queryWith('wisp:rollup-parents')[0]!.sql).toMatch(/ANY\(c\.child_concern_ids\)/);
  });

  it('keeps a parent open while one child is still live', async () => {
    children = [child(3, OA)];
    parents = [parent(1, OA, 'phantom_incident_event', { child_concern_ids: [uid(101), uid(102), uid(103)], live_children: 1 })];
    await rollupDeviceConcerns(NOW);
    expect(h.resolveConcern).not.toHaveBeenCalled();
    expect(h.updateConcern).toHaveBeenCalledWith(uid(901), expect.objectContaining({ summary: '1 device: phantom incident event' }));
  });

  it('does not re-open a parent a person closed in the last 24 h for the same signature', async () => {
    children = [child(1, OA), child(2, OA), child(3, OA)];
    parents = [parent(1, OA, 'phantom_incident_event', { status: 'dismissed', outcome: null, updated_at: ago(2 * HOUR) })];
    await expect(rollupDeviceConcerns(NOW)).resolves.toEqual({ opened: 0, updated: 0, resolved: 0 });
    expect(h.upsertConcern).not.toHaveBeenCalled();
  });

  it('re-opens after its own children_resolved close (a new wave of the same problem)', async () => {
    children = [child(4, OA), child(5, OA), child(6, OA)];
    parents = [parent(1, OA, 'phantom_incident_event', { status: 'resolved', outcome: 'children_resolved', updated_at: ago(2 * HOUR) })];
    await expect(rollupDeviceConcerns(NOW)).resolves.toEqual({ opened: 1, updated: 0, resolved: 0 });
  });

  it('merges into the winner when another tick won the signature race', async () => {
    children = [child(1, OA), child(2, OA), child(3, OA)];
    h.upsertConcern.mockImplementation(async () => ({ id: uid(950), created: false }));
    await expect(rollupDeviceConcerns(NOW)).resolves.toEqual({ opened: 0, updated: 1, resolved: 0 });
    expect(h.updateConcern).toHaveBeenCalledWith(uid(950), expect.objectContaining({
      childConcernIds: [uid(101), uid(102), uid(103)],
    }));
  });

  // Review (#11519): children re-raised under another pattern leave the old parent.
  it('resolves a parent whose children all moved to another pattern, and opens the new one', async () => {
    children = [1, 2, 3].map((n) => child(n, OA, { pattern: 'patch_timeout' }));
    parents = [parent(1, OA, 'patch_job_timeout', { child_concern_ids: [uid(101), uid(102), uid(103)], live_children: 3 })];
    await expect(rollupDeviceConcerns(NOW)).resolves.toEqual({ opened: 1, updated: 0, resolved: 1 });
    expect(h.resolveConcern).toHaveBeenCalledWith(uid(901), {}, 'children_resolved');
    expect(h.upsertConcern.mock.calls[0]![0]).toMatchObject({ signature: `${OA}:patch_timeout` });
  });

  it('drops a live child that moved to another pattern from the parent it left', async () => {
    children = [child(1, OA), child(2, OA), child(3, OA), child(4, OA, { pattern: 'browser_critical_cves' })];
    parents = [parent(1, OA, 'phantom_incident_event', {
      child_concern_ids: [uid(101), uid(102), uid(103), uid(104), uid(105)], live_children: 4,
      summary: '4 devices: phantom incident event', evidence: { rollup: CONCERN_ROLLUP_KIND, pattern: 'phantom_incident_event', deviceCount: 4 },
    })];
    await rollupDeviceConcerns(NOW);
    // 105 is resolved (not live anywhere): it stays as history; 104 now belongs elsewhere.
    expect(h.updateConcern).toHaveBeenCalledWith(uid(901), expect.objectContaining({
      summary: '3 devices: phantom incident event',
      childConcernIds: [uid(101), uid(102), uid(103), uid(105)],
    }));
  });

  it('a pattern with more than the child cap of live devices settles: the second tick writes nothing', async () => {
    children = Array.from({ length: 150 }, (_, i) => child(i + 1, OA));
    await rollupDeviceConcerns(NOW);
    const opened = h.upsertConcern.mock.calls[0]![0] as Record<string, any>;
    expect(opened.childConcernIds).toHaveLength(100);
    vi.clearAllMocks();
    parents = [parent(1, OA, 'phantom_incident_event', {
      child_concern_ids: opened.childConcernIds, live_children: 100,
      summary: opened.summary, severity: opened.severity, evidence: opened.evidence,
    })];
    await expect(rollupDeviceConcerns(NOW)).resolves.toEqual({ opened: 0, updated: 0, resolved: 0 });
    expect(h.updateConcern).not.toHaveBeenCalled();
  });

  it('a capped child read never closes a parent whose children SQL still counts live', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    children = Array.from({ length: 10_000 }, (_, i) => child(i + 1, OB, { pattern: `p_${i % 2 === 0 ? 'even' : 'odd'}_x` }));
    parents = [parent(1, OA, 'phantom_incident_event', { child_concern_ids: [uid(101)], live_children: 1 })];
    await rollupDeviceConcerns(NOW);
    expect(h.resolveConcern).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('10000-row cap'));
    err.mockRestore();
  });

  it('one failing group does not stop the next', async () => {
    children = [
      child(1, OA), child(2, OA), child(3, OA),
      child(4, OB), child(5, OB), child(6, OB),
    ];
    h.upsertConcern.mockImplementationOnce(async () => { throw new Error('db blip'); });
    await expect(rollupDeviceConcerns(NOW)).resolves.toEqual({ opened: 1, updated: 0, resolved: 0 });
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('fallbackConcernPattern', () => {
  it('lowercases, strips device names and number-bearing tokens, and keeps the first clause', () => {
    expect(fallbackConcernPattern('KIOSK-A: Chrome 129.0.1 has 3 critical CVEs (CVE-2026-1234). Update it.', ['KIOSK-A', null]))
      .toBe('chrome_has_critical_cves');
    expect(fallbackConcernPattern('Patch job failed: Command timed out after 600s', [])).toBe('patch_job_failed_command_timed_out_after');
  });

  it('returns null when nothing meaningful is left', () => {
    expect(fallbackConcernPattern('WS-1', ['WS-1'])).toBeNull();
    expect(fallbackConcernPattern('42', [])).toBeNull();
  });
});

describe('isConcernRollup', () => {
  it('names only the rollup parents', () => {
    expect(isConcernRollup({ orgId: OA, subject: { kind: 'incident', id: uid(1) }, evidence: { rollup: CONCERN_ROLLUP_KIND } })).toBe(true);
    expect(isConcernRollup({ orgId: OA, subject: { kind: 'incident', id: uid(1) }, evidence: { tokens: ['a'] } })).toBe(false);
    expect(isConcernRollup({ orgId: OA, subject: { kind: 'device', id: uid(1) }, evidence: { rollup: CONCERN_ROLLUP_KIND } })).toBe(false);
  });
});
