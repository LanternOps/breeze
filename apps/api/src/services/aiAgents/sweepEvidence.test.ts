/**
 * Phase 2 wave P2-2 (scheduled sweeps) task 5 — sweep evidence.
 *
 * Two suites:
 *  - the PURE assembler (`assembleSweepEvidence`), driven entirely from
 *    fixtures: the per-kind row cap, the UTF-8 byte ceiling, and the
 *    never-a-partial-row property;
 *  - the DB loaders, asserted on their COMPILED SQL (the
 *    `exchangeRateService.test.ts` precedent) rather than on an opaque
 *    Drizzle builder chain: org pin actually bound, `LIMIT MAX+1` actually
 *    requested, ephemeral devices actually excluded, and the per-kind
 *    ordering/`DISTINCT ON` shape actually present. Real-Postgres proof of
 *    the fan-out lives in the wave's integration suite (task 9).
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
      return Promise.resolve(results.length > 0 ? results.shift() : []);
    }),
  },
}));

import {
  assembleSweepEvidence,
  loadSweepEvidence,
  SWEEP_EVIDENCE_HARD_LIMIT_BYTES,
  SWEEP_EVIDENCE_MAX_ROWS_PER_KIND,
} from './sweepEvidence';

// --- compiled-SQL helpers (copied from exchangeRateService.test.ts) --------
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
/** Whitespace-collapsed SQL of the Nth db.execute() call. */
function text(index = 0): string {
  return sqlText(executed[index]).replace(/\s+/g, ' ');
}

// --- the brief's fixture --------------------------------------------------
const row = (i: number, pad = 0) => ({
  deviceId: `d-${i}`,
  hostname: `host-${i}`,
  fields: { usedPercent: 90 + (i % 10), note: 'x'.repeat(pad) },
});

describe('assembleSweepEvidence', () => {
  it('passes small evidence through untouched', () => {
    const e = assembleSweepEvidence({ disk_pressure: { rows: [row(1)], total: 1 } });
    expect(e.truncated).toBe(false);
    expect(e.kinds.disk_pressure?.rows).toHaveLength(1);
    expect(e.kinds.disk_pressure?.total).toBe(1);
  });

  it('caps rows per kind and flags truncation when the loader returned MAX+1', () => {
    const rows = Array.from({ length: SWEEP_EVIDENCE_MAX_ROWS_PER_KIND + 1 }, (_, i) => row(i));
    const e = assembleSweepEvidence({ stale_agents: { rows, total: rows.length } });
    expect(e.kinds.stale_agents?.rows).toHaveLength(SWEEP_EVIDENCE_MAX_ROWS_PER_KIND);
    expect(e.kinds.stale_agents?.truncated).toBe(true);
    expect(e.truncated).toBe(true);
  });

  it('drops rows until the byte ceiling holds and never emits a partial row', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i, 900));
    const e = assembleSweepEvidence({ disk_pressure: { rows, total: 20 } });
    expect(Buffer.byteLength(JSON.stringify(e.kinds), 'utf8')).toBeLessThanOrEqual(SWEEP_EVIDENCE_HARD_LIMIT_BYTES);
    expect(e.truncated).toBe(true);
    for (const r of e.kinds.disk_pressure!.rows) expect(r.fields.note).toHaveLength(900);
  });

  // The byte trim is a FAIRNESS mechanism, not a "trim whatever is at hand"
  // one: one noisy kind must not crowd the other kinds' evidence out of the
  // prompt entirely. Dropping from the kind with the MOST rows first is what
  // makes that true — a naive "drop from the last kind" would empty the
  // 3-row kind here while the 12-row kind kept every row.
  it('drops from the LONGEST kind first so a short kind keeps its rows', () => {
    const short = Array.from({ length: 3 }, (_, i) => row(i, 900));
    const long = Array.from({ length: 12 }, (_, i) => row(100 + i, 900));
    const e = assembleSweepEvidence({
      disk_pressure: { rows: short, total: 3 },
      stale_agents: { rows: long, total: 12 },
    });
    expect(Buffer.byteLength(JSON.stringify(e.kinds), 'utf8')).toBeLessThanOrEqual(SWEEP_EVIDENCE_HARD_LIMIT_BYTES);
    expect(e.kinds.disk_pressure?.rows).toHaveLength(3);
    expect(e.kinds.disk_pressure?.truncated).toBe(false);
    expect(e.kinds.stale_agents!.rows.length).toBeLessThan(12);
    expect(e.kinds.stale_agents?.truncated).toBe(true);
    expect(e.truncated).toBe(true);
  });

  it('keeps a kind the loader ran but found nothing for (a clean check is evidence too)', () => {
    const e = assembleSweepEvidence({ service_down: { rows: [], total: 0 } });
    expect(e.kinds.service_down).toEqual({ rows: [], total: 0, truncated: false });
    expect(e.truncated).toBe(false);
  });
});

describe('loadSweepEvidence', () => {
  beforeEach(() => {
    executed.length = 0;
    results = [];
    vi.clearAllMocks();
  });

  it('runs exactly one statement per requested kind, in the shared catalog order', async () => {
    await loadSweepEvidence('org-1', ['unpatched_critical', 'disk_pressure']);
    expect(executed).toHaveLength(2);
    expect(text(0)).toContain('device_disks');
    expect(text(1)).toContain('device_vulnerabilities');
  });

  it('ignores a duplicate kind rather than running its statement twice', async () => {
    await loadSweepEvidence('org-1', ['disk_pressure', 'disk_pressure']);
    expect(executed).toHaveLength(1);
  });

  it('runs nothing at all when no kinds are requested', async () => {
    const evidence = await loadSweepEvidence('org-1', []);
    expect(executed).toHaveLength(0);
    expect(evidence).toEqual({ kinds: {}, truncated: false });
  });

  // The tenancy invariant. loadSweepEvidence runs under a SYSTEM DB context
  // (full RLS bypass), so the org pin in the WHERE clause is the ONLY thing
  // keeping one tenant's sweep out of another's data.
  it.each([
    ['disk_pressure', 'devices'],
    ['stale_agents', 'devices'],
    ['pending_reboots', 'devices'],
    ['failed_backups', 'devices'],
    ['service_down', 'devices'],
    ['unpatched_critical', 'devices'],
  ] as const)('%s is org-pinned, excludes ephemeral devices, and fetches MAX+1', async (kind, joined) => {
    await loadSweepEvidence('org-9', [kind]);
    const sql = text(0);
    expect(sql).toContain(joined);
    expect(sql).toContain('is_ephemeral = false');
    expect(sql).toContain('LIMIT');
    const params = boundParams(executed[0]);
    // +1 so the assembler can OBSERVE that more than MAX exist; a bare
    // LIMIT MAX would have the DB silently discard the overflow first and
    // `truncated` could never be true.
    expect(params).toContain(SWEEP_EVIDENCE_MAX_ROWS_PER_KIND + 1);
    expect(params).toContain('org-9');
  });

  it('disk_pressure reads device_disks at/over 85% used, worst first', async () => {
    await loadSweepEvidence('org-1', ['disk_pressure']);
    const sql = text(0);
    expect(sql).toContain('FROM device_disks');
    expect(sql).toContain('dd.used_percent >= 85');
    expect(sql).toContain('ORDER BY dd.used_percent DESC');
  });

  it('stale_agents reads devices unseen for 7 days, oldest first, skipping decommissioned', async () => {
    await loadSweepEvidence('org-1', ['stale_agents']);
    const sql = text(0);
    expect(sql).toContain("d.status <> 'decommissioned'");
    expect(sql).toContain("interval '7 days'");
    expect(sql).toContain('ORDER BY d.last_seen_at ASC');
  });

  it('pending_reboots reads the OS pending-reboot flag, most recently seen first', async () => {
    await loadSweepEvidence('org-1', ['pending_reboots']);
    const sql = text(0);
    expect(sql).toContain('d.pending_reboot = true');
    expect(sql).toContain('ORDER BY d.last_seen_at DESC');
  });

  it('failed_backups keeps the LATEST failed job per (device, config) in the last 7 days', async () => {
    await loadSweepEvidence('org-1', ['failed_backups']);
    const sql = text(0);
    expect(sql).toContain('DISTINCT ON (bj.device_id, bj.config_id)');
    expect(sql).toContain("bj.status = 'failed'");
    expect(sql).toContain("interval '7 days'");
    expect(sql).toContain('ORDER BY bj.device_id, bj.config_id, bj.started_at DESC');
    expect(sql).toContain('backup_configs');
  });

  // The latest result per watch is taken FIRST and only then filtered on a
  // bad status — filtering first would report a service that has already
  // recovered, which is exactly the false finding this ordering prevents.
  it('service_down takes the latest 24 h result per watch, then keeps only the bad ones', async () => {
    await loadSweepEvidence('org-1', ['service_down']);
    const sql = text(0);
    expect(sql).toContain('DISTINCT ON (r.device_id, r.watch_type, r.name)');
    expect(sql).toContain("interval '24 hours'");
    expect(sql).toContain('ORDER BY r.device_id, r.watch_type, r.name, r.timestamp DESC');
    expect(sql).toContain("latest.status IN ('stopped', 'not_found', 'error')");
    // The status filter must sit OUTSIDE the DISTINCT ON subquery.
    expect(sql.indexOf('latest.status IN')).toBeGreaterThan(sql.indexOf('DISTINCT ON'));
  });

  it('unpatched_critical groups open critical findings per device, capped at 5 ids each', async () => {
    await loadSweepEvidence('org-1', ['unpatched_critical']);
    const sql = text(0);
    expect(sql).toContain("dv.status = 'open'");
    expect(sql).toContain("lower(v.severity) = 'critical'");
    expect(sql).toContain('[1:5]');
    expect(sql).toContain('bool_or');
    expect(sql).toContain('GROUP BY dv.device_id, d.hostname');
    expect(sql).toContain('ORDER BY COUNT(*) DESC');
  });

  it('maps a disk row to display scalars only (no raw columns, no jsonb)', async () => {
    results = [[{ device_id: 'dev-1', hostname: 'HOST-1', mount_point: '/', used_percent: 92.4567, free_gb: 3.21, total_gb: 250 }]];
    const evidence = await loadSweepEvidence('org-1', ['disk_pressure']);
    expect(evidence.kinds.disk_pressure?.rows).toEqual([
      { deviceId: 'dev-1', hostname: 'HOST-1', fields: { mountPoint: '/', usedPercent: 92.5, freeGb: 3.2, totalGb: 250 } },
    ]);
  });

  it('renders timestamps as ISO strings, never Date objects', async () => {
    results = [[{ device_id: 'dev-1', hostname: 'h1', last_seen_at: new Date('2026-08-01T10:00:00.000Z'), agent_version: '0.108.0', os_type: 'windows', status: 'offline' }]];
    const evidence = await loadSweepEvidence('org-1', ['stale_agents']);
    expect(evidence.kinds.stale_agents?.rows[0]!.fields).toEqual({
      lastSeenAt: '2026-08-01T10:00:00.000Z',
      agentVersion: '0.108.0',
      osType: 'windows',
      status: 'offline',
    });
  });

  it('comma-joins the opaque finding/CVE ids the model needs for a remediation proposal', async () => {
    results = [[{
      device_id: 'dev-1', hostname: 'h1', open_critical_count: 7,
      cve_ids: 'CVE-2026-1,CVE-2026-2', device_vulnerability_ids: 'dv-1,dv-2', known_exploited: true,
    }]];
    const evidence = await loadSweepEvidence('org-1', ['unpatched_critical']);
    expect(evidence.kinds.unpatched_critical?.rows[0]!.fields).toEqual({
      openCriticalCount: 7,
      cveIds: 'CVE-2026-1,CVE-2026-2',
      deviceVulnerabilityIds: 'dv-1,dv-2',
      knownExploited: true,
    });
  });

  it('flags truncation when a loader came back with MAX+1 rows', async () => {
    results = [Array.from({ length: SWEEP_EVIDENCE_MAX_ROWS_PER_KIND + 1 }, (_, i) => ({
      device_id: `dev-${i}`, hostname: `h-${i}`, last_seen_at: new Date('2026-08-01T10:00:00.000Z'), os_type: 'linux',
    }))];
    const evidence = await loadSweepEvidence('org-1', ['pending_reboots']);
    expect(evidence.kinds.pending_reboots?.rows).toHaveLength(SWEEP_EVIDENCE_MAX_ROWS_PER_KIND);
    expect(evidence.kinds.pending_reboots?.truncated).toBe(true);
    expect(evidence.truncated).toBe(true);
  });
});
