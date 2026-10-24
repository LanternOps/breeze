import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * services/wisp/readiness.ts — "what I can and cannot watch" (W05 Task 15,
 * w00 A33). `db` is a chain fake keyed by the table passed to `.from(...)`:
 * each check kind reads its own tables, so a fixture row in one table flips
 * exactly one check. Every `.where(...)` is recorded per table so the window
 * and org filters can be compiled and asserted.
 */
const h = vi.hoisted(() => {
  const rowsByTable = new Map<unknown, unknown[]>();
  const whereByTable = new Map<unknown, unknown[]>();
  const fromCalls: unknown[] = [];
  const joinsByTable = new Map<unknown, unknown[]>();
  const chain = (): Record<string, unknown> => {
    let table: unknown;
    const p: Record<string, unknown> = {};
    for (const m of ['leftJoin', 'limit', 'orderBy', 'groupBy']) p[m] = vi.fn(() => p);
    p.from = vi.fn((t: unknown) => { table = t; fromCalls.push(t); return p; });
    p.innerJoin = vi.fn((_t: unknown, on: unknown) => {
      const list = joinsByTable.get(table) ?? [];
      list.push(on);
      joinsByTable.set(table, list);
      return p;
    });
    p.where = vi.fn((cond: unknown) => {
      const list = whereByTable.get(table) ?? [];
      list.push(cond);
      whereByTable.set(table, list);
      return p;
    });
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rowsByTable.get(table) ?? []).then(res, rej);
    return p;
  };
  return {
    rowsByTable,
    whereByTable,
    joinsByTable,
    fromCalls,
    db: { select: vi.fn(() => chain()), selectDistinct: vi.fn(() => chain()), execute: vi.fn() },
    withSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    wispEnabled: vi.fn(() => true),
  };
});

vi.mock('../../db', () => ({
  db: h.db,
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: h.withSystem,
}));
vi.mock('../../config/env', () => ({ wispEnabled: h.wispEnabled }));

import { WATCH_KINDS } from '@breeze/shared';
import { organizations } from '../../db/schema/orgs';
import { backupConfigs } from '../../db/schema/backup';
import { backupProviderCustomers } from '../../db/schema/backupProviders';
import { deviceVulnerabilities } from '../../db/schema/vulnerabilityManagement';
import { edrDetections, edrEndpoints } from '../../db/schema/edrProviders';
import { configPolicyAssignments } from '../../db/schema/configurationPolicies';
import { tickets } from '../../db/schema/portal';
import { monitorDefinitions } from '../../db/schema/monitorDefinitions';
import { alertRules } from '../../db/schema/alerts';
import { networkMonitors } from '../../db/schema/monitors';
import type { GrantCeiling } from './grantAuthority';
import type { OrgReadiness } from './assessmentTypes';
import { readinessInventory, renderReadinessSummary } from './readiness';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_OUT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const dialect = new PgDialect();
const compile = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

function ceiling(orgIds: string[], o: Partial<GrantCeiling> = {}): GrantCeiling {
  return {
    grantId: 'g1',
    revisionId: 'r1',
    partnerId: PARTNER,
    grantorUserId: 'u1',
    scopeOrgId: null,
    partnerWide: true,
    orgIds: new Set(orgIds),
    siteIds: null,
    permissionKeys: new Set(['*']),
    toolAllowlist: null,
    deniedTools: new Set(),
    orgTerms: new Map(),
    status: 'active',
    ...o,
  };
}

const orgRow = (id: string, name: string) => ({ id, name, partnerId: PARTNER });

function check(r: OrgReadiness | undefined, kind: string) {
  const c = r?.checks.find((x) => x.watchKind === kind);
  if (!c) throw new Error(`no check ${kind}`);
  return c;
}

beforeEach(() => {
  h.rowsByTable.clear();
  h.whereByTable.clear();
  h.joinsByTable.clear();
  h.fromCalls.length = 0;
  h.db.select.mockClear();
  h.db.selectDistinct.mockClear();
  h.withSystem.mockClear();
  h.wispEnabled.mockReturnValue(true);
  h.rowsByTable.set(organizations, [orgRow(ORG_A, 'Acme')]);
});

describe('readinessInventory', () => {
  it('reports every watch kind, in WATCH_KINDS order, and only custom_query serviceable when nothing is configured', async () => {
    const [r] = await readinessInventory(ceiling([ORG_A]));
    expect(r?.orgId).toBe(ORG_A);
    expect(r?.orgName).toBe('Acme');
    expect(r?.checks.map((c) => c.watchKind)).toEqual([...WATCH_KINDS]);
    expect(r?.checks).toEqual([
      { watchKind: 'ticket_waiting', serviceable: false, reason: 'no tickets in 90 days' },
      { watchKind: 'alert_pattern', serviceable: false, reason: 'no monitors or alert rules' },
      { watchKind: 'backup_health', serviceable: false, reason: 'no backup integration configured' },
      { watchKind: 'patch_compliance', serviceable: false, reason: 'no patch policy' },
      { watchKind: 'security_findings', serviceable: false, reason: 'no vulnerability or EDR data in 30 days' },
      { watchKind: 'custom_query', serviceable: true, reason: null },
      { watchKind: 'ticket_cluster', serviceable: false, reason: 'no tickets in 90 days' },
    ]);
    expect(r?.missingIntegrations).toEqual(['backup', 'edr/vulnerability']);
    expect(h.withSystem).toHaveBeenCalledTimes(1);
  });

  it('backup_health flips on a backup config', async () => {
    h.rowsByTable.set(backupConfigs, [{ orgId: ORG_A }]);
    const [r] = await readinessInventory(ceiling([ORG_A]));
    expect(check(r, 'backup_health')).toEqual({ watchKind: 'backup_health', serviceable: true, reason: null });
    expect(r?.missingIntegrations).toEqual(['edr/vulnerability']);
    expect(check(r, 'patch_compliance').serviceable).toBe(false);
  });

  it('backup_health flips on a mapped backup-vendor customer', async () => {
    h.rowsByTable.set(backupProviderCustomers, [{ orgId: ORG_A }]);
    const [r] = await readinessInventory(ceiling([ORG_A]));
    expect(check(r, 'backup_health').serviceable).toBe(true);
  });

  it('security_findings flips on vulnerability rows, EDR detections or EDR endpoints', async () => {
    for (const table of [deviceVulnerabilities, edrDetections, edrEndpoints]) {
      h.rowsByTable.clear();
      h.rowsByTable.set(organizations, [orgRow(ORG_A, 'Acme')]);
      h.rowsByTable.set(table, [{ orgId: ORG_A }]);
      const [r] = await readinessInventory(ceiling([ORG_A]));
      expect(check(r, 'security_findings')).toEqual({ watchKind: 'security_findings', serviceable: true, reason: null });
      expect(r?.missingIntegrations).toEqual(['backup']);
      expect(check(r, 'backup_health').serviceable).toBe(false);
    }
  });

  it('security_findings reads a 30-day window and ticket checks a 90-day window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'));
    try {
      await readinessInventory(ceiling([ORG_A]));
    } finally {
      vi.useRealTimers();
    }
    const vulnWhere = h.whereByTable.get(deviceVulnerabilities)?.[0];
    expect(compile(vulnWhere).params).toContain(new Date('2026-09-24T12:00:00.000Z').toISOString());
    const ticketWhere = h.whereByTable.get(tickets)?.[0];
    const ticketQuery = compile(ticketWhere);
    expect(ticketQuery.params).toContain(new Date('2026-07-26T12:00:00.000Z').toISOString());
    expect(ticketQuery.sql).toContain('"deleted_at" is null');
  });

  it('patch_compliance flips on an effective patch-policy assignment', async () => {
    h.rowsByTable.set(configPolicyAssignments, [{ orgId: ORG_A }]);
    const [r] = await readinessInventory(ceiling([ORG_A]));
    expect(check(r, 'patch_compliance')).toEqual({ watchKind: 'patch_compliance', serviceable: true, reason: null });
    expect(r?.missingIntegrations).toEqual(['backup', 'edr/vulnerability']);
  });

  it('the patch read joins active policies the org may use, an effective patch link with settings, and partner-to-device assignments', async () => {
    await readinessInventory(ceiling([ORG_A]));
    const joins = (h.joinsByTable.get(configPolicyAssignments) ?? []).map((j) => compile(j));
    const all = joins.map((q) => q.sql).join(' | ');
    for (const level of ['partner', 'organization', 'site', 'device_group', 'device']) {
      expect(all).toContain(`= '${level}' AND`);
    }
    expect(all).toContain('"configuration_policies"."partner_id" = "organizations"."partner_id"');
    expect(all).toContain('"config_policy_effective_feature_links"');
    expect(all).toContain('"config_policy_patch_settings"."feature_link_id"');
    expect(joins.flatMap((q) => q.params)).toEqual(expect.arrayContaining(['active', 'patch']));
  });

  it('ticket_waiting and ticket_cluster flip together on a recent ticket', async () => {
    h.rowsByTable.set(tickets, [{ orgId: ORG_A }]);
    const [r] = await readinessInventory(ceiling([ORG_A]));
    expect(check(r, 'ticket_waiting').serviceable).toBe(true);
    expect(check(r, 'ticket_cluster').serviceable).toBe(true);
    expect(check(r, 'alert_pattern').serviceable).toBe(false);
  });

  it('alert_pattern flips on an org-level monitor, alert rule or network monitor', async () => {
    for (const table of [monitorDefinitions, alertRules, networkMonitors]) {
      h.rowsByTable.clear();
      h.rowsByTable.set(organizations, [orgRow(ORG_A, 'Acme')]);
      h.rowsByTable.set(table, [{ orgId: ORG_A, partnerId: null }]);
      const [r] = await readinessInventory(ceiling([ORG_A]));
      expect(check(r, 'alert_pattern')).toEqual({ watchKind: 'alert_pattern', serviceable: true, reason: null });
      expect(check(r, 'ticket_waiting').serviceable).toBe(false);
    }
  });

  it('a partner-wide monitor makes alert_pattern serviceable for every org of that partner', async () => {
    h.rowsByTable.set(organizations, [orgRow(ORG_A, 'Acme'), orgRow(ORG_B, 'Bravo')]);
    h.rowsByTable.set(monitorDefinitions, [{ orgId: null, partnerId: PARTNER }]);
    const out = await readinessInventory(ceiling([ORG_A, ORG_B]));
    expect(out.map((r) => check(r, 'alert_pattern').serviceable)).toEqual([true, true]);
  });

  it('an org-level row for one org does not leak into another', async () => {
    h.rowsByTable.set(organizations, [orgRow(ORG_A, 'Acme'), orgRow(ORG_B, 'Bravo')]);
    h.rowsByTable.set(backupConfigs, [{ orgId: ORG_B }]);
    const out = await readinessInventory(ceiling([ORG_A, ORG_B]));
    expect(out.map((r) => [r.orgId, check(r, 'backup_health').serviceable])).toEqual([[ORG_A, false], [ORG_B, true]]);
  });

  it('never returns an org outside the ceiling, even when passed in opts.orgIds or returned by a read', async () => {
    h.rowsByTable.set(organizations, [orgRow(ORG_A, 'Acme'), orgRow(ORG_OUT, 'Outsider')]);
    const out = await readinessInventory(ceiling([ORG_A]), { orgIds: [ORG_A, ORG_OUT] });
    expect(out.map((r) => r.orgId)).toEqual([ORG_A]);
    // The org read itself is bounded by the ceiling, not by opts alone.
    const orgWhere = compile(h.whereByTable.get(organizations)?.[0]);
    expect(orgWhere.params).toContain(ORG_A);
    expect(orgWhere.params).not.toContain(ORG_OUT);
  });

  it('reads nothing when opts.orgIds has no org inside the ceiling', async () => {
    const out = await readinessInventory(ceiling([ORG_A]), { orgIds: [ORG_OUT] });
    expect(out).toEqual([]);
    expect(h.fromCalls).toEqual([]);
  });

  it('drops an org row from another partner', async () => {
    h.rowsByTable.set(organizations, [orgRow(ORG_A, 'Acme'), { id: ORG_B, name: 'Bravo', partnerId: 'other-partner' }]);
    const out = await readinessInventory(ceiling([ORG_A, ORG_B]));
    expect(out.map((r) => r.orgId)).toEqual([ORG_A]);
  });

  it('orders results by org name, then org id, regardless of read order', async () => {
    const ORG_A2 = '00000000-0000-4000-8000-00000000000a';
    h.rowsByTable.set(organizations, [orgRow(ORG_B, 'Bravo'), orgRow(ORG_A, 'Acme'), orgRow(ORG_A2, 'Acme')]);
    const out = await readinessInventory(ceiling([ORG_A, ORG_B, ORG_A2]));
    expect(out.map((r) => r.orgId)).toEqual([ORG_A2, ORG_A, ORG_B]);
  });

  it('is dark when Wisp is disabled, and empty for an inactive ceiling', async () => {
    h.wispEnabled.mockReturnValue(false);
    expect(await readinessInventory(ceiling([ORG_A]))).toEqual([]);
    h.wispEnabled.mockReturnValue(true);
    expect(await readinessInventory(ceiling([ORG_A], { status: 'paused' }))).toEqual([]);
    expect(h.fromCalls).toEqual([]);
  });
});

describe('renderReadinessSummary', () => {
  const ready = (gaps: Partial<Record<string, string>>): OrgReadiness => ({
    orgId: ORG_A,
    orgName: 'Acme',
    checks: WATCH_KINDS.map((k) => ({
      watchKind: k,
      serviceable: gaps[k] === undefined,
      reason: gaps[k] ?? null,
    })),
    missingIntegrations: [],
  });

  it('0 gaps', () => {
    expect(renderReadinessSummary(ready({}))).toBe(
      'I can watch everything I know how to watch here: alerts, tickets, backups, patch compliance, and security findings.',
    );
  });

  it('1 gap', () => {
    expect(renderReadinessSummary(ready({ backup_health: 'no backup integration configured' }))).toBe(
      "I can watch alerts, tickets, patch compliance, and security findings here. I can't watch backups (no backup integration configured).",
    );
  });

  it('2 gaps', () => {
    expect(renderReadinessSummary(ready({
      backup_health: 'no backup integration configured',
      patch_compliance: 'no patch policy',
      security_findings: undefined,
    }))).toBe(
      "I can watch alerts, tickets, and security findings here. I can't watch backups (no backup integration configured) or patch compliance (no patch policy).",
    );
  });

  it('3 gaps, Oxford comma with "or"', () => {
    expect(renderReadinessSummary(ready({
      backup_health: 'no backup integration configured',
      patch_compliance: 'no patch policy',
      security_findings: 'no vulnerability or EDR data in 30 days',
    }))).toBe(
      "I can watch alerts and tickets here. I can't watch backups (no backup integration configured), patch compliance (no patch policy), or security findings (no vulnerability or EDR data in 30 days).",
    );
  });

  it('ticket kinds collapse to one noun and nothing watchable reads plainly', () => {
    expect(renderReadinessSummary(ready({
      ticket_waiting: 'no tickets in 90 days',
      ticket_cluster: 'no tickets in 90 days',
      alert_pattern: 'no monitors or alert rules',
      backup_health: 'no backup integration configured',
      patch_compliance: 'no patch policy',
      security_findings: 'no vulnerability or EDR data in 30 days',
    }))).toBe(
      "There is nothing here I can watch yet. I can't watch alerts (no monitors or alert rules), tickets (no tickets in 90 days), backups (no backup integration configured), patch compliance (no patch policy), or security findings (no vulnerability or EDR data in 30 days).",
    );
  });

  it('never mentions custom_query and does not depend on check order', () => {
    const r = ready({ patch_compliance: 'no patch policy' });
    const reversed = { ...r, checks: [...r.checks].reverse() };
    const text = renderReadinessSummary(reversed);
    expect(text).toBe(renderReadinessSummary(r));
    expect(text).not.toMatch(/custom|query/i);
  });
});
