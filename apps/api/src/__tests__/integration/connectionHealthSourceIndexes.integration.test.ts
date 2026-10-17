/**
 * Connection health index contract (spec 2026-10-15 §1.3): every source's
 * broken-set query must be servable without a sequential scan of a table whose
 * rows grow with orgs (or users). Planner costs on a near-empty test DB favour
 * seq scans, so the check runs with enable_seqscan = off: a Seq Scan that
 * survives that has no usable index. Partner-axis tables (rows grow with
 * partners) are allowed to be scanned; any other scanned table fails, so a new
 * source has to classify its table here.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { HEALTH_SOURCES } from '../../services/connectionHealth/sources';

const NOW = new Date();

/** Tables whose rows grow with orgs or users: never sequentially scanned. */
const PER_ORG_TABLES = new Set(['oauth_grants', 'dns_filter_integrations', 'm365_connections', 'm365_sync_state']);
/** Tables whose rows grow with partners (one or a few per partner): a scan is acceptable. */
const PARTNER_AXIS_TABLES = new Set([
  'huntress_integrations',
  's1_integrations',
  'pax8_integrations',
  'unifi_integrations',
  'backup_provider_connections',
  'edr_connections',
  'accounting_connections',
  'ticket_mailbox_connections',
]);

async function planFor(source: (typeof HEALTH_SOURCES)[number]): Promise<string> {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    const rows = (await tx.execute(sql`EXPLAIN ${source.brokenQuery(NOW)}`)) as unknown as Array<Record<string, string>>;
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  })));
}

describe('connection health source index contract (spec §1.3)', () => {
  it('classifies every table a source covers', () => {
    for (const s of HEALTH_SOURCES) {
      for (const t of s.tables) {
        expect(PER_ORG_TABLES.has(t) || PARTNER_AXIS_TABLES.has(t), `${s.kind}: classify ${t}`).toBe(true);
      }
    }
  });

  it.each(HEALTH_SOURCES.map((s) => [s.kind, s] as const))('%s broken query scans no per-org table sequentially', async (_kind, source) => {
    const plan = await planFor(source);
    const scanned = [...plan.matchAll(/Seq Scan on (\w+)/g)].map((m) => m[1]!);
    for (const table of scanned) {
      expect(PER_ORG_TABLES.has(table), `Seq Scan on per-org table ${table}:\n${plan}`).toBe(false);
      expect(PARTNER_AXIS_TABLES.has(table), `Seq Scan on unclassified table ${table}:\n${plan}`).toBe(true);
    }
  });

  it.each([
    ['dns_filter', 'dns_filter_integrations_sync_error_idx'],
    ['m365_connection', 'm365_connections_unhealthy_idx'],
    ['m365_sync', 'm365_sync_state_unhealthy_idx'],
    ['oauth_grant', 'oauth_grants_auto_revoked_idx'],
  ])('%s uses %s', async (kind, index) => {
    const source = HEALTH_SOURCES.find((s) => s.kind === kind)!;
    expect(await planFor(source)).toContain(index);
  });
});
