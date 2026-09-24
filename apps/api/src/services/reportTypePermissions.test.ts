import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { BUSINESS_REPORT_TYPES, REPORT_TYPES } from '@breeze/shared';
import { reports } from '../db/schema';
import {
  reportAudienceCondition,
  reportTypeHiddenByPermission,
  reportTypeHiddenFromCaller,
  reportTypePermissionCondition,
} from './reportTypePermissions';

const dialect = new PgDialect();

/**
 * Ruling F1 (#3198 W02 final review): the three business types are internal to
 * the MSP (spec §2). An organization-scope caller — a customer user, or an org
 * API/MCP key — never sees or runs one; every other scope is unaffected here
 * (their own gates decide).
 */
describe('reportTypeHiddenFromCaller', () => {
  it('hides exactly the business types from an organization-scope caller', () => {
    const hidden = REPORT_TYPES.filter((t) => reportTypeHiddenFromCaller(t, { scope: 'organization' }));
    expect([...hidden].sort()).toEqual([...BUSINESS_REPORT_TYPES].sort());
  });

  it('hides nothing from partner or system scope', () => {
    for (const scope of ['partner', 'system'] as const) {
      expect(REPORT_TYPES.filter((t) => reportTypeHiddenFromCaller(t, { scope }))).toEqual([]);
    }
  });

  it('an unknown or missing type never throws (reports.type is a pg enum; reportTypeDef refuses unknowns)', () => {
    expect(reportTypeHiddenFromCaller('not_a_type', { scope: 'organization' })).toBe(false);
    expect(reportTypeHiddenFromCaller(undefined as unknown as string, { scope: 'organization' })).toBe(false);
  });
});

describe('reportAudienceCondition', () => {
  it('excludes every msp_staff type for an organization-scope caller', () => {
    const condition = reportAudienceCondition({ scope: 'organization' }, reports.type);
    expect(condition).toBeDefined();
    const { sql, params } = dialect.sqlToQuery(condition as SQL);
    expect(sql).toMatch(/"reports"\."type" not in \(/);
    expect([...params].sort()).toEqual([...BUSINESS_REPORT_TYPES].sort());
  });

  it('adds no predicate for partner or system scope', () => {
    expect(reportAudienceCondition({ scope: 'partner' }, reports.type)).toBeUndefined();
    expect(reportAudienceCondition({ scope: 'system' }, reports.type)).toBeUndefined();
  });
});

/**
 * Ruling P8b (#3198 W02 fix round): the per-type permission gate extends to
 * READS. A caller who lacks a business type's underlying read permission
 * (e.g. invoices:read for ar_aging) never sees that type's definitions or
 * runs — list-excluded and 404 by id — on every scope. Pre-#3198 types list
 * no extra permissions and are never hidden.
 */
describe('reportTypeHiddenByPermission / reportTypePermissionCondition (ruling P8b)', () => {
  const noInvoices = {
    permissions: [
      { resource: 'reports', action: '*' },
      { resource: 'tickets', action: 'read' },
      { resource: 'time_entries', action: 'read' },
    ],
  };
  const all = { permissions: [{ resource: '*', action: '*' }] };

  it('hides exactly the types whose required permissions are missing', () => {
    expect(REPORT_TYPES.filter((t) => reportTypeHiddenByPermission(t, noInvoices))).toEqual(['ar_aging']);
    expect(REPORT_TYPES.filter((t) => reportTypeHiddenByPermission(t, all))).toEqual([]);
  });

  it('an unresolved permission set hides every business type and no legacy type', () => {
    for (const granted of [null, undefined, { permissions: [] }]) {
      const hidden = REPORT_TYPES.filter((t) => reportTypeHiddenByPermission(t, granted));
      expect([...hidden].sort()).toEqual([...BUSINESS_REPORT_TYPES].sort());
    }
  });

  it('an unknown type is not hidden and never throws', () => {
    expect(reportTypeHiddenByPermission('not_a_type', null)).toBe(false);
  });

  it('the SQL twin excludes exactly the missing types, and adds nothing when none are missing', () => {
    const condition = reportTypePermissionCondition(noInvoices, reports.type);
    expect(condition).toBeDefined();
    const { sql, params } = dialect.sqlToQuery(condition as SQL);
    expect(sql).toMatch(/"reports"\."type" not in \(/);
    expect(params).toEqual(['ar_aging']);
    expect(reportTypePermissionCondition(all, reports.type)).toBeUndefined();
  });
});
