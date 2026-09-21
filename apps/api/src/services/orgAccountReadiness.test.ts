import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

import { db } from '../db';
import {
  configPolicyAssignments,
  configurationPolicies,
  contacts,
  devices,
  invoices,
  organizations,
  portalUsers,
  sites,
  tickets,
} from '../db/schema';
import { loadAccountReadiness, resolveAcceptedOrgs } from './orgAccountReadiness';

const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '11111111-1111-4111-8111-222222222222';
const ORG_C = '11111111-1111-4111-8111-333333333333';

interface CapturedQuery {
  table: unknown;
  joins: Array<{ table: unknown; on: unknown }>;
  where?: unknown;
  groupBy?: unknown[];
}

/** Every `db.select().from(table)` chain the code under test built, in order. */
const captured: CapturedQuery[] = [];

/**
 * Table-keyed row stubs behind a thenable query-builder chain. The service
 * chains `.from().innerJoin()?.where().groupBy()` and then awaits the builder,
 * so the stub records each call and resolves to the rows registered for the
 * `.from()` table. Looking rows up by table (not by call order) keeps these
 * tests readable when a section is switched off and its query disappears.
 */
function setupDb(rowsByTable: Map<unknown, unknown[]>) {
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: (table: unknown) => {
          const call: CapturedQuery = { table, joins: [] };
          captured.push(call);
          const rows = rowsByTable.get(table) ?? [];
          const chain = {
            innerJoin(joined: unknown, on: unknown) {
              call.joins.push({ table: joined, on });
              return chain;
            },
            where(condition: unknown) {
              call.where = condition;
              return chain;
            },
            groupBy(...columns: unknown[]) {
              call.groupBy = columns;
              return chain;
            },
            then(resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) {
              return Promise.resolve(rows).then(resolve, reject);
            },
          };
          return chain;
        },
      }) as any,
  );
}

function callsFor(table: unknown): CapturedQuery[] {
  return captured.filter((call) => call.table === table);
}

/**
 * Compile a captured WHERE into the SQL text and parameters Postgres would
 * receive. A JSON dump of the Drizzle tree is not a substitute: column objects
 * embed their enum values (e.g. 'decommissioned'), so a substring check on the
 * dump can pass against unfixed code.
 */
function compiledWhere(table: unknown): { sql: string; params: unknown[] } {
  const call = callsFor(table)[0];
  if (!call?.where) throw new Error('no WHERE captured for that table');
  const query = new PgDialect().sqlToQuery(call.where as SQL);
  return { sql: query.sql, params: query.params as unknown[] };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('resolveAcceptedOrgs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.length = 0;
  });

  it('returns nothing, without a query, when a partner token has no accessible orgs', async () => {
    setupDb(new Map());
    const accepted = await resolveAcceptedOrgs({ orgIds: [ORG_A], partnerId: PARTNER_ID, accessibleOrgIds: [] });
    expect(accepted).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns nothing, without a query, for an empty id list', async () => {
    setupDb(new Map());
    const accepted = await resolveAcceptedOrgs({ orgIds: [], partnerId: PARTNER_ID, accessibleOrgIds: null });
    expect(accepted).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('system scope (null list) filters on the ids, the partner, liveness and type only', async () => {
    setupDb(new Map([[organizations, []]]));
    await resolveAcceptedOrgs({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, accessibleOrgIds: null });

    const where = compiledWhere(organizations);
    expect(occurrences(where.sql, '"organizations"."id" in (')).toBe(1);
    expect(where.sql).toContain('"organizations"."partner_id" = ');
    expect(where.sql).toContain('"organizations"."deleted_at" is null');
    expect(where.sql).toContain('"organizations"."type" <> ');
    expect(where.params).toEqual([ORG_A, ORG_B, PARTNER_ID, 'quick_support']);
  });

  it("partner scope also intersects with the token's accessible orgs", async () => {
    setupDb(new Map([[organizations, []]]));
    await resolveAcceptedOrgs({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, accessibleOrgIds: [ORG_A, ORG_C] });

    const where = compiledWhere(organizations);
    expect(occurrences(where.sql, '"organizations"."id" in (')).toBe(2);
    expect(where.params).toEqual([ORG_A, ORG_B, PARTNER_ID, 'quick_support', ORG_A, ORG_C]);
  });

  it('keeps request order, omits ids the query did not return, and derives billingAddress', async () => {
    setupDb(
      new Map([
        [
          organizations,
          [
            // Returned out of request order, and B is missing its city.
            { id: ORG_B, type: 'internal', status: 'trial', billingAddressLine1: '1 Main St', billingAddressCity: null, billingAddressCountry: 'US' },
            { id: ORG_A, type: 'customer', status: 'active', billingAddressLine1: '1 Main St', billingAddressCity: 'Springfield', billingAddressCountry: 'US' },
          ],
        ],
      ]),
    );
    const accepted = await resolveAcceptedOrgs({ orgIds: [ORG_A, ORG_C, ORG_B], partnerId: PARTNER_ID, accessibleOrgIds: null });
    expect(accepted).toEqual([
      { id: ORG_A, type: 'customer', status: 'active', billingAddress: true },
      { id: ORG_B, type: 'internal', status: 'trial', billingAddress: false },
    ]);
  });
});

describe('loadAccountReadiness', () => {
  const ALL_SECTIONS = { sites: true, devices: true, portalUsers: true, invoices: true, tickets: true };
  const NO_SECTIONS = { sites: false, devices: false, portalUsers: false, invoices: false, tickets: false };

  beforeEach(() => {
    vi.clearAllMocks();
    captured.length = 0;
  });

  it('returns nothing, without a query, for an empty id list', async () => {
    setupDb(new Map());
    const result = await loadAccountReadiness({ orgIds: [], partnerId: PARTNER_ID, sections: ALL_SECTIONS });
    expect(result.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('issues one grouped query per enabled domain and none for a disabled one', async () => {
    setupDb(new Map());
    await loadAccountReadiness({ orgIds: [ORG_A], partnerId: PARTNER_ID, sections: ALL_SECTIONS });
    expect(captured.map((call) => call.table)).toEqual([
      sites,
      devices,
      configPolicyAssignments,
      contacts,
      portalUsers,
      tickets,
      invoices,
    ]);

    captured.length = 0;
    await loadAccountReadiness({ orgIds: [ORG_A], partnerId: PARTNER_ID, sections: NO_SECTIONS });
    // policies and contacts ride on organizations:read — always computed.
    expect(captured.map((call) => call.table)).toEqual([configPolicyAssignments, contacts]);
  });

  it('omits every gated field when its section is disabled', async () => {
    setupDb(new Map());
    const result = await loadAccountReadiness({ orgIds: [ORG_A], partnerId: PARTNER_ID, sections: NO_SECTIONS });
    expect(result.get(ORG_A)).toEqual({ policyAssigned: false, primaryContact: null, billingRoleContact: false });
  });

  it('sites: grouped count, zero for an org with none', async () => {
    setupDb(new Map([[sites, [{ orgId: ORG_A, count: '2' }]]]));
    const result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: { ...NO_SECTIONS, sites: true } });

    const where = compiledWhere(sites);
    expect(where.sql).toContain('"sites"."org_id" in (');
    expect(where.params).toEqual([ORG_A, ORG_B]);
    expect(callsFor(sites)[0]?.groupBy).toEqual([sites.orgId]);
    expect(result.get(ORG_A)?.sites).toBe(2);
    expect(result.get(ORG_B)?.sites).toBe(0);
  });

  it('devices: counts the non-decommissioned population and its freshest check-in', async () => {
    setupDb(new Map([[devices, [{ orgId: ORG_A, count: '3', lastSeenAt: new Date('2026-09-01T00:00:00.000Z') }]]]));
    const result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: { ...NO_SECTIONS, devices: true } });

    const where = compiledWhere(devices);
    expect(where.sql).toContain('"devices"."org_id" in (');
    expect(where.sql).toContain('"devices"."status" <> ');
    expect(where.params).toEqual([ORG_A, ORG_B, 'decommissioned']);
    expect(callsFor(devices)[0]?.groupBy).toEqual([devices.orgId]);
    expect(result.get(ORG_A)).toMatchObject({ devices: 3, lastSeenAt: '2026-09-01T00:00:00.000Z' });
    expect(result.get(ORG_B)).toMatchObject({ devices: 0, lastSeenAt: null });
  });

  it('devices: a naive timestamp string from the driver is read as UTC', async () => {
    setupDb(new Map([[devices, [{ orgId: ORG_A, count: '1', lastSeenAt: '2026-09-01 12:30:00' }]]]));
    const result = await loadAccountReadiness({ orgIds: [ORG_A], partnerId: PARTNER_ID, sections: { ...NO_SECTIONS, devices: true } });
    expect(result.get(ORG_A)?.lastSeenAt).toBe('2026-09-01T12:30:00.000Z');
  });

  it('policies: one query over org-level ids and the partner-level target, joined to active policies', async () => {
    setupDb(new Map([[configPolicyAssignments, []]]));
    await loadAccountReadiness({ orgIds: [ORG_A], partnerId: PARTNER_ID, sections: NO_SECTIONS });

    const call = callsFor(configPolicyAssignments)[0]!;
    expect(call.joins.map((join) => join.table)).toEqual([configurationPolicies]);
    const where = compiledWhere(configPolicyAssignments);
    expect(where.sql).toContain('"configuration_policies"."status" = ');
    expect(where.sql).toContain('"config_policy_assignments"."level" = ');
    expect(where.sql).toContain('"config_policy_assignments"."target_id" in (');
    expect(where.params).toEqual(['active', 'organization', ORG_A, 'partner', PARTNER_ID]);
    expect(call.groupBy).toEqual([configPolicyAssignments.level, configPolicyAssignments.targetId]);
  });

  it('policies: a partner-level assignment covers every org; an org-level one only its target', async () => {
    setupDb(new Map([[configPolicyAssignments, [{ level: 'organization', targetId: ORG_A }]]]));
    let result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: NO_SECTIONS });
    expect(result.get(ORG_A)?.policyAssigned).toBe(true);
    expect(result.get(ORG_B)?.policyAssigned).toBe(false);

    setupDb(new Map([[configPolicyAssignments, [{ level: 'partner', targetId: PARTNER_ID }]]]));
    result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: NO_SECTIONS });
    expect(result.get(ORG_A)?.policyAssigned).toBe(true);
    expect(result.get(ORG_B)?.policyAssigned).toBe(true);
  });

  it("contacts: a driver that returns bool_or as 't'/'f' text is read as a boolean", async () => {
    setupDb(
      new Map([
        [
          contacts,
          [
            { orgId: ORG_A, hasPrimary: 't', primaryName: 'Ada', primaryEmail: null, primaryPhone: null, primaryMobile: null, billingRole: 'f' },
            { orgId: ORG_B, hasPrimary: 'f', primaryName: null, primaryEmail: null, primaryPhone: null, primaryMobile: null, billingRole: 't' },
          ],
        ],
      ]),
    );
    const result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: NO_SECTIONS });
    expect(result.get(ORG_A)).toMatchObject({ primaryContact: { name: 'Ada' }, billingRoleContact: false });
    expect(result.get(ORG_B)).toMatchObject({ primaryContact: null, billingRoleContact: true });
  });

  it('devices: an offset-bearing timestamp string is kept as-is and an unparsable one becomes null', async () => {
    setupDb(new Map([[devices, [{ orgId: ORG_A, count: '1', lastSeenAt: '2026-09-01T12:30:00+02:00' }, { orgId: ORG_B, count: '1', lastSeenAt: 'not a date' }]]]));
    const result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: { ...NO_SECTIONS, devices: true } });
    expect(result.get(ORG_A)?.lastSeenAt).toBe('2026-09-01T10:30:00.000Z');
    expect(result.get(ORG_B)).toMatchObject({ devices: 1, lastSeenAt: null });
  });

  it('contacts: maps the org-level primary and the billing role from one grouped row', async () => {
    setupDb(
      new Map([
        [
          contacts,
          [
            { orgId: ORG_A, hasPrimary: true, primaryName: 'Ada', primaryEmail: 'ada@x.example', primaryPhone: null, primaryMobile: '555-0199', billingRole: true },
            { orgId: ORG_B, hasPrimary: false, primaryName: null, primaryEmail: null, primaryPhone: null, primaryMobile: null, billingRole: false },
          ],
        ],
      ]),
    );
    const result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B, ORG_C], partnerId: PARTNER_ID, sections: NO_SECTIONS });

    const where = compiledWhere(contacts);
    expect(where.sql).toContain('"contacts"."org_id" in (');
    expect(where.params).toEqual([ORG_A, ORG_B, ORG_C]);
    expect(callsFor(contacts)[0]?.groupBy).toEqual([contacts.orgId]);
    expect(result.get(ORG_A)).toMatchObject({
      primaryContact: { name: 'Ada', email: 'ada@x.example', phone: null, mobile: '555-0199' },
      billingRoleContact: true,
    });
    expect(result.get(ORG_B)).toMatchObject({ primaryContact: null, billingRoleContact: false });
    // No contacts at all: same answer as "contacts but no primary".
    expect(result.get(ORG_C)).toMatchObject({ primaryContact: null, billingRoleContact: false });
  });

  it('portal users: pending = not disabled, never signed in, invited at least 7 days ago', async () => {
    setupDb(new Map([[portalUsers, [{ orgId: ORG_A, count: '2' }]]]));
    const result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: { ...NO_SECTIONS, portalUsers: true } });

    const where = compiledWhere(portalUsers);
    expect(where.sql).toContain('"portal_users"."org_id" in (');
    expect(where.sql).toContain('"portal_users"."status" <> ');
    expect(where.sql).toContain('"portal_users"."last_login_at" is null');
    expect(where.sql).toContain(`"portal_users"."invited_at" < (now() AT TIME ZONE 'utc') - interval '7 days'`);
    expect(where.params).toEqual([ORG_A, ORG_B, 'disabled']);
    expect(result.get(ORG_A)?.pendingInvitations).toBe(2);
    expect(result.get(ORG_B)?.pendingInvitations).toBe(0);
  });

  it('tickets: open, non-deleted rows only; awaiting-customer and SLA-breached as filtered counts', async () => {
    setupDb(new Map([[tickets, [{ orgId: ORG_A, open: '4', awaitingCustomer: '1', slaBreached: '2' }]]]));
    const result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: { ...NO_SECTIONS, tickets: true } });

    const where = compiledWhere(tickets);
    expect(where.sql).toContain('"tickets"."org_id" in (');
    expect(where.sql).toContain('"tickets"."deleted_at" is null');
    expect(where.sql).toContain('"tickets"."status" in (');
    expect(where.params).toEqual([ORG_A, ORG_B, 'new', 'open', 'pending', 'on_hold']);
    expect(result.get(ORG_A)?.tickets).toEqual({ open: 4, awaitingCustomer: 1, slaBreached: 2 });
    expect(result.get(ORG_B)?.tickets).toEqual({ open: 0, awaitingCustomer: 0, slaBreached: 0 });
  });

  it('invoices: outstanding statuses due before today', async () => {
    setupDb(new Map([[invoices, [{ orgId: ORG_A, count: '2' }]]]));
    const result = await loadAccountReadiness({ orgIds: [ORG_A, ORG_B], partnerId: PARTNER_ID, sections: { ...NO_SECTIONS, invoices: true } });

    const where = compiledWhere(invoices);
    expect(where.sql).toContain('"invoices"."org_id" in (');
    expect(where.sql).toContain('"invoices"."status" in (');
    expect(where.sql).toContain('"invoices"."due_date" < CURRENT_DATE');
    expect(where.params).toEqual([ORG_A, ORG_B, 'sent', 'partially_paid', 'overdue']);
    expect(result.get(ORG_A)?.overdueInvoices).toBe(2);
    expect(result.get(ORG_B)?.overdueInvoices).toBe(0);
  });
});
