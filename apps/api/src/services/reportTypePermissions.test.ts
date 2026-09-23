import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { BUSINESS_REPORT_TYPES, REPORT_TYPES } from '@breeze/shared';
import { reports } from '../db/schema';
import {
  reportAudienceCondition,
  reportTypeHiddenFromCaller,
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
