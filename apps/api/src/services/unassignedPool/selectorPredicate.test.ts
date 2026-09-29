import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { devices, organizations } from '../../db/schema';
import { notHoldingOrgCondition, notInHoldingOrgCondition, notParkedDeviceCondition } from './selectorPredicate';

const dialect = new PgDialect();
const render = (q: ReturnType<typeof sql>) => dialect.sqlToQuery(q);

describe('parked-device selector predicates', () => {
  it('excludes devices whose org is a holding org, keyed on devices.org_id by default', () => {
    const { sql: text, params } = render(notParkedDeviceCondition());
    expect(text).toMatch(/^NOT EXISTS \(SELECT 1 FROM organizations/);
    expect(text).toContain('"devices"."org_id"');
    expect(text).toContain("'unassigned_pool'");
    expect(params).toEqual([]);
  });

  it('accepts another org-id column or raw SQL fragment', () => {
    expect(render(notParkedDeviceCondition(organizations.id)).sql).toContain('"organizations"."id"');
    expect(render(notParkedDeviceCondition(sql.raw('d.org_id'))).sql).toContain('= d.org_id');
    expect(render(notInHoldingOrgCondition(sql.raw('s.org_id'))).sql)
      .toBe(render(notParkedDeviceCondition(sql.raw('s.org_id'))).sql);
  });

  it('never matches on a hidden-org-type list (Quick Support stays selectable)', () => {
    const text = render(notParkedDeviceCondition()).sql + render(notHoldingOrgCondition()).sql;
    expect(text).not.toContain('quick_support');
  });

  it('renders the org-join form against organizations.type', () => {
    const { sql: text, params } = render(notHoldingOrgCondition());
    expect(text).toContain('"organizations"."type"');
    expect(text).toContain('<>');
    expect(params).toEqual(['unassigned_pool']);
    void devices;
  });
});
