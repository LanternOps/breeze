/**
 * #5751 W02 (#5753) — the three-outcome, subject-pinned condition probe.
 *
 * Driven through a mocked `db.execute` the way `sweepEvidence.test.ts` is, and
 * asserted on the COMPILED SQL as well as the verdict: the org pin, the device
 * pin, the subject pin and the ephemeral-device exclusion are the whole
 * tenancy story of this module, and a verdict test alone would pass with any
 * of them missing.
 *
 * The asymmetry the module exists to hold: `unknown` costs a human review;
 * `cleared` costs a wrong `verified` in the graduation ledger. So every case
 * below that cannot answer must land on `unknown`, never on `cleared`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Raw drizzle SQL objects handed to db.execute(), in call order. */
const executed: unknown[] = [];
/** Terminal results, consumed in order by each db.execute() call. */
let results: unknown[] = [];

vi.mock('../../db', () => ({
  db: {
    execute: vi.fn((statement: unknown) => {
      executed.push(statement);
      const next = results.length > 0 ? results.shift() : [];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }),
  },
}));

const captureException = vi.fn();
vi.mock('../sentry', () => ({ captureException: (...args: unknown[]) => captureException(...args) }));

import { AI_SWEEP_KINDS } from '@breeze/shared';
import {
  isActEligibleSweepKind,
  probeSweepSubject,
  SERVICE_DOWN_STATUSES,
  SWEEP_PROBE_FRESHNESS_MS,
} from './sweepSubjectProbe';
import { loadSweepEvidence } from './sweepEvidence';

// --- compiled-SQL helpers (same shape as sweepEvidence.test.ts) ------------
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
  if (!node || typeof node !== 'object') return out;
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) {
    for (const chunk of n.queryChunks) boundParams(chunk, out);
    return out;
  }
  if ('encoder' in n && 'value' in n) out.push(n.value);
  return out;
}
/** Whitespace-collapsed, lowercased SQL of the Nth db.execute() call — the
 *  assertions below are about structure, not about keyword casing. */
function text(index = 0): string {
  return sqlText(executed[index]).replace(/\s+/g, ' ').toLowerCase();
}

const ORG = '11111111-1111-4111-8111-111111111111';
const DEV = '22222222-2222-4222-8222-222222222222';
const SERVICE = 'MSSQLSERVER';

/** A result row `fresh` ms in the past. */
function row(status: string, ageMs = 0) {
  return [{ status, timestamp: new Date(Date.now() - ageMs) }];
}

beforeEach(() => {
  executed.length = 0;
  results = [];
  captureException.mockClear();
});

describe('probeSweepSubject — service_down', () => {
  it('the latest result for (device, service) is stopped -> present', async () => {
    results = [row('stopped')];
    await expect(probeSweepSubject('service_down', ORG, DEV, SERVICE)).resolves.toBe('present');
  });

  it.each(['not_found', 'error'])('a latest status of %s is also -> present', async (status) => {
    results = [row(status)];
    await expect(probeSweepSubject('service_down', ORG, DEV, SERVICE)).resolves.toBe('present');
  });

  it('the latest result for (device, service) is running -> cleared', async () => {
    results = [row('running')];
    await expect(probeSweepSubject('service_down', ORG, DEV, SERVICE)).resolves.toBe('cleared');
  });

  it('no result row at all -> unknown, never cleared', async () => {
    results = [[]];
    await expect(probeSweepSubject('service_down', ORG, DEV, SERVICE)).resolves.toBe('unknown');
  });

  it('a result row older than the freshness window -> unknown, never cleared', async () => {
    // A stale `running` row is the dangerous one: reading it as `cleared`
    // would credit `verified` for a device that has said nothing since.
    results = [row('running', SWEEP_PROBE_FRESHNESS_MS + 60_000)];
    await expect(probeSweepSubject('service_down', ORG, DEV, SERVICE)).resolves.toBe('unknown');
  });

  it('an offline device — its newest check result has aged out — is unknown, not cleared', async () => {
    // A device that stopped reporting produces no fresh row. That is the
    // whole offline signal this probe needs; a second `devices.last_seen_at`
    // read would add a column without adding discriminating power.
    results = [row('stopped', SWEEP_PROBE_FRESHNESS_MS * 10)];
    await expect(probeSweepSubject('service_down', ORG, DEV, SERVICE)).resolves.toBe('unknown');
  });

  it('a row with no timestamp at all -> unknown', async () => {
    results = [[{ status: 'running', timestamp: null }]];
    await expect(probeSweepSubject('service_down', ORG, DEV, SERVICE)).resolves.toBe('unknown');
  });

  it('a thrown query is captured and returns unknown — never cleared', async () => {
    results = [new Error('connection reset')];
    await expect(probeSweepSubject('service_down', ORG, DEV, SERVICE)).resolves.toBe('unknown');
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('pins org on both sides of the join, pins the device and the subject, and excludes ephemeral devices', async () => {
    results = [row('running')];
    await probeSweepSubject('service_down', ORG, DEV, SERVICE);

    const sql = text(0);
    expect(sql).toContain('from service_process_check_results');
    expect(sql).toContain('join devices d on d.id = r.device_id');
    expect(sql).toContain('r.org_id =');
    expect(sql).toContain('d.org_id =');
    expect(sql).toContain('r.device_id =');
    expect(sql).toContain('r.name =');
    expect(sql).toContain('d.is_ephemeral = false');
    // Latest row for this exact subject, not a scan of the org.
    expect(sql).toContain('order by r.timestamp desc');
    expect(sql).toContain('limit 1');

    const params = boundParams(executed[0]);
    expect(params).toContain(ORG);
    expect(params).toContain(DEV);
    expect(params).toContain(SERVICE);
    // The org is bound TWICE — once per side of the join.
    expect(params.filter((p) => p === ORG)).toHaveLength(2);
  });
});

describe('probeSweepSubject — kinds with no probe', () => {
  it('a kind with no registered probe -> unknown, and issues no query', async () => {
    await expect(probeSweepSubject('failed_backups', ORG, DEV, 'nightly')).resolves.toBe('unknown');
    expect(executed).toHaveLength(0);
  });

  it('every non-service_down kind returns unknown today', async () => {
    for (const kind of AI_SWEEP_KINDS.filter((k) => k !== 'service_down')) {
      await expect(probeSweepSubject(kind, ORG, DEV, 'x')).resolves.toBe('unknown');
    }
  });
});

// ---------------------------------------------------------------------------
// The finding and its verification must agree on what "down" means. Review
// finding, PR #5889: these are two independently-maintained literals in two
// files, and a drift between them reproduces EXACTLY the defect this wave
// exists to close — a still-broken condition read as `cleared`, crediting a
// wrong `verified` into an immutable ledger.
// ---------------------------------------------------------------------------
describe('SERVICE_DOWN_STATUSES agrees with loadServiceDown', () => {
  it('names exactly the statuses the sweep raises a service_down finding on', async () => {
    // Drive the REAL loader through the same mocked db and read its compiled
    // SQL, rather than restating the list a third time here — a hardcoded copy
    // in the test would drift right alongside the ones it is meant to guard.
    results = [[]];
    await loadSweepEvidence(ORG, ['service_down']);
    expect(executed, 'loadSweepEvidence issued no query — the arrange is wrong, not the contract').toHaveLength(1);

    const sql = text(0);
    const inList = sql.match(/latest\.status in \(([^)]*)\)/);
    expect(inList, 'loadServiceDown no longer filters on a literal status IN list — update this contract test').not.toBeNull();
    const loaderStatuses = [...inList![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);

    expect(new Set(loaderStatuses)).toEqual(new Set(SERVICE_DOWN_STATUSES));
  });
});

describe('isActEligibleSweepKind', () => {
  it('is true only for kinds that have a probe', () => {
    expect(isActEligibleSweepKind('service_down')).toBe(true);
    for (const kind of AI_SWEEP_KINDS.filter((k) => k !== 'service_down')) {
      expect(isActEligibleSweepKind(kind)).toBe(false);
    }
  });

  it('is false for a value that is not a sweep kind at all', () => {
    // A trigger key is parsed from a stored string, so the kind reaching here
    // is not compile-time guaranteed to be in the catalog.
    expect(isActEligibleSweepKind('not_a_sweep_kind')).toBe(false);
    expect(isActEligibleSweepKind('__proto__')).toBe(false);
    expect(isActEligibleSweepKind('')).toBe(false);
  });

  it('is false for expiring_certs, which is finding-only by construction', () => {
    // #5751 W03 (#5754): the kind IS in the catalog now, but there is no safe
    // automated certificate renewal and `SweepProposedAction` is a closed
    // union, so it deliberately registers no probe. Asserted explicitly rather
    // than relying on the loop above, because a future probe added by
    // accident would silently make a finding-only kind act-eligible.
    expect(AI_SWEEP_KINDS as readonly string[]).toContain('expiring_certs');
    expect(isActEligibleSweepKind('expiring_certs')).toBe(false);
  });
});
