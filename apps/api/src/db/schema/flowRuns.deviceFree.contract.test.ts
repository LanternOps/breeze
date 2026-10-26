/**
 * Tool Catalog W04 (#5219) Task A3 — the flow run tables carry no device,
 * site or ticket column.
 *
 * `flow_versions`, `flow_runs` and `flow_run_steps` are registered in the org
 * cascade, export policy and org-merge lists only. They are deliberately in
 * none of the device- or ticket-keyed lists, because none of them names a
 * device, a site or a ticket: the device that triggered an event run lives in
 * `trigger_payload` (jsonb), not in a column (migration
 * 2027-01-06-130000-flow-runs.sql header).
 *
 * Those lists are completeness-checked from the Drizzle schema
 * (`cascadeDelete.test.ts`, `moveOrg.coverage.test.ts`) or not at all
 * (`ticketOrgMoveLockOrder.ts` is runtime-only). So a later column add must
 * fail HERE and send its author to the lists it now has to join.
 */
import { describe, expect, it } from 'vitest';
import { getTableConfig, pgTable, text, uuid, type PgTable } from 'drizzle-orm/pg-core';
import { flowRunSteps, flowRuns, flowVersions } from './flowRuns';
import { flowWebhookDeliveries } from './flowWebhooks';
import { flowUsageCounters } from './flowUsage';

const FORBIDDEN_COLUMNS = ['device_id', 'site_id', 'ticket_id'] as const;

/** `<table>.<column>` for every forbidden column the Drizzle table declares. */
function forbiddenColumnsOf(table: PgTable): string[] {
  const config = getTableConfig(table);
  return config.columns
    .map((column) => column.name)
    .filter((name) => (FORBIDDEN_COLUMNS as readonly string[]).includes(name))
    .map((name) => `${config.name}.${name}`);
}

const MESSAGE =
  'a flow run table gained a device_id / site_id / ticket_id column. It must now also join the device and ticket lists: '
  + 'CORE_DEVICE_CASCADE_DELETE_TABLES (and, with a denormalized org_id, CORE_DEVICE_ORG_DENORMALIZED_TABLES plus an org-move '
  + 'disposition) in routes/devices/core.ts; TICKET_ORG_DENORMALIZED_TABLES in services/ticketOrgMoveLockOrder.ts together with '
  + 'CUSTOM_ORG_REWRITE_TABLES in routes/devices/core.ts, in the same relative order. See docs/agents/tenancy-rls.md, then update '
  + 'this test.';

describe('flow run tables are device-, site- and ticket-free (#5219 A3)', () => {
  it('none of flow_versions, flow_runs, flow_run_steps declares device_id, site_id or ticket_id', () => {
    const tables = [flowVersions, flowRuns, flowRunSteps];
    // Vacuity guard: the three tables are the ones the migration creates.
    expect(tables.map((t) => getTableConfig(t).name)).toEqual(['flow_versions', 'flow_runs', 'flow_run_steps']);
    for (const table of tables) expect(getTableConfig(table).columns.length).toBeGreaterThan(5);

    expect(tables.flatMap(forbiddenColumnsOf), MESSAGE).toEqual([]);
  });

  it('the W5 tables flow_webhook_deliveries and flow_usage_counters are device-, site- and ticket-free (#5220 A3)', () => {
    const tables = [flowWebhookDeliveries, flowUsageCounters];
    expect(tables.map((t) => getTableConfig(t).name)).toEqual(['flow_webhook_deliveries', 'flow_usage_counters']);
    for (const table of tables) expect(getTableConfig(table).columns.length).toBeGreaterThan(5);

    expect(tables.flatMap(forbiddenColumnsOf), MESSAGE).toEqual([]);
  });

  it('the check discriminates: a table that does declare them is flagged', () => {
    const control = pgTable('flow_runs_control', {
      id: uuid('id').primaryKey(),
      deviceId: uuid('device_id'),
      siteId: uuid('site_id'),
      ticketId: uuid('ticket_id'),
      note: text('note'),
    });
    expect(forbiddenColumnsOf(control)).toEqual([
      'flow_runs_control.device_id',
      'flow_runs_control.site_id',
      'flow_runs_control.ticket_id',
    ]);
  });

  it('the failure message names the lists a later column must join', () => {
    expect(MESSAGE).toContain('routes/devices/core.ts');
    expect(MESSAGE).toContain('services/ticketOrgMoveLockOrder.ts');
  });
});
