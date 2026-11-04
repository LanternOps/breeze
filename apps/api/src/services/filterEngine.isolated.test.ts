import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
vi.mock('../db', () => ({ db: {} }));
import { buildConditionSQL, getFieldDefinition, validateFilter } from './filterEngine';

const predicate = `EXISTS (SELECT 1 FROM device_network_isolations WHERE device_id = "devices"."id" AND state NOT IN ('released', 'expired', 'failed', 'uninstalled'))`;

describe('networkIsolation.active virtual boolean', () => {
  it('registers only boolean equality operators', () => {
    expect(getFieldDefinition('networkIsolation.active')).toMatchObject({ type: 'boolean', operators: ['equals', 'notEquals'] });
    expect(validateFilter({ field: 'networkIsolation.active', operator: 'contains', value: 'yes' }).valid).toBe(false);
  });
  it.each([true, false, 'yes', 'no', 'true', 'false'])('handles %j with both operators', value => {
    for (const operator of ['equals', 'notEquals'] as const) {
      const condition = { field: 'networkIsolation.active', operator, value };
      expect(validateFilter(condition).valid).toBe(true);
      const negative = value === false || value === 'no' || value === 'false';
      const negate = (operator === 'notEquals') !== negative;
      const query = new PgDialect().sqlToQuery(buildConditionSQL(condition));
      expect(query.sql).toBe(negate ? `NOT (${predicate})` : predicate);
      expect(query.params).toEqual([]);
    }
  });
});
