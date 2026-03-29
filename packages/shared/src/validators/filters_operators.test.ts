import { describe, it, expect } from 'vitest';
import {
  filterOperatorSchema,
  filterValueSchema,
  filterConditionSchema,
  filterConditionGroupSchema,
  filterRootSchema,
  createSavedFilterSchema,
  updateSavedFilterSchema,
  savedFilterQuerySchema,
} from './filters';

// ============================================
// Filter Operators
// ============================================

describe('filterOperatorSchema', () => {
  const allOperators = [
    'equals', 'notEquals', 'greaterThan', 'greaterThanOrEquals',
    'lessThan', 'lessThanOrEquals', 'contains', 'notContains',
    'startsWith', 'endsWith', 'matches', 'in', 'notIn',
    'hasAny', 'hasAll', 'isEmpty', 'isNotEmpty',
    'isNull', 'isNotNull', 'before', 'after',
    'between', 'withinLast', 'notWithinLast',
  ];

  it('should accept all valid operators', () => {
    for (const op of allOperators) {
      const result = filterOperatorSchema.safeParse(op);
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid operator', () => {
    expect(filterOperatorSchema.safeParse('like').success).toBe(false);
    expect(filterOperatorSchema.safeParse('').success).toBe(false);
    expect(filterOperatorSchema.safeParse(42).success).toBe(false);
  });
});

// ============================================
// Filter Values
// ============================================

describe('filterValueSchema', () => {
  it('should accept string values', () => {
    expect(filterValueSchema.safeParse('hello').success).toBe(true);
  });

  it('should accept number values', () => {
    expect(filterValueSchema.safeParse(42).success).toBe(true);
    expect(filterValueSchema.safeParse(3.14).success).toBe(true);
    expect(filterValueSchema.safeParse(0).success).toBe(true);
  });

  it('should accept boolean values', () => {
    expect(filterValueSchema.safeParse(true).success).toBe(true);
    expect(filterValueSchema.safeParse(false).success).toBe(true);
  });

  it('should accept date strings (coerced)', () => {
    const result = filterValueSchema.safeParse('2026-01-15');
    expect(result.success).toBe(true);
  });

  it('should accept string arrays', () => {
    expect(filterValueSchema.safeParse(['a', 'b', 'c']).success).toBe(true);
  });

  it('should accept number arrays', () => {
    expect(filterValueSchema.safeParse([1, 2, 3]).success).toBe(true);
  });

  it('should accept date range values', () => {
    const result = filterValueSchema.safeParse({
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(result.success).toBe(true);
  });

  it('should accept relative time values', () => {
    const units = ['minutes', 'hours', 'days', 'weeks', 'months'] as const;
    for (const unit of units) {
      const result = filterValueSchema.safeParse({ amount: 7, unit });
      expect(result.success).toBe(true);
    }
  });

  it('should reject negative relative time amount', () => {
    const result = filterValueSchema.safeParse({ amount: -1, unit: 'days' });
    expect(result.success).toBe(false);
  });

  it('should reject zero relative time amount', () => {
    const result = filterValueSchema.safeParse({ amount: 0, unit: 'hours' });
    expect(result.success).toBe(false);
  });
});

// ============================================
// Filter Conditions
// ============================================

describe('filterConditionSchema', () => {
  it('should accept valid condition', () => {
    const result = filterConditionSchema.safeParse({
      field: 'hostname',
      operator: 'contains',
      value: 'web',
    });
    expect(result.success).toBe(true);
  });

  it('should accept condition without value (for isNull/isNotNull)', () => {
    const result = filterConditionSchema.safeParse({
      field: 'displayName',
      operator: 'isNull',
    });
    expect(result.success).toBe(true);
  });

  it('should accept dotted field names', () => {
    const result = filterConditionSchema.safeParse({
      field: 'hardware.cpuModel',
      operator: 'equals',
      value: 'Intel',
    });
    expect(result.success).toBe(true);
  });

  it('should accept custom fields with custom. prefix', () => {
    const result = filterConditionSchema.safeParse({
      field: 'custom.department_code',
      operator: 'equals',
      value: 'IT',
    });
    expect(result.success).toBe(true);
  });

  it('should reject custom fields with uppercase after custom.', () => {
    const result = filterConditionSchema.safeParse({
      field: 'custom.Department',
      operator: 'equals',
      value: 'IT',
    });
    expect(result.success).toBe(false);
  });

  it('should reject custom fields starting with number after custom.', () => {
    const result = filterConditionSchema.safeParse({
      field: 'custom.1field',
      operator: 'equals',
      value: 'IT',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty field', () => {
    const result = filterConditionSchema.safeParse({
      field: '',
      operator: 'equals',
      value: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('should reject field starting with number', () => {
    const result = filterConditionSchema.safeParse({
      field: '1hostname',
      operator: 'equals',
      value: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('should reject field with special characters', () => {
    const result = filterConditionSchema.safeParse({
      field: 'host-name',
      operator: 'equals',
      value: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('should accept field with nested dots', () => {
    const result = filterConditionSchema.safeParse({
      field: 'metrics.disk.percent',
      operator: 'greaterThan',
      value: 90,
    });
    expect(result.success).toBe(true);
  });
});

// ============================================
// Filter Condition Groups
// ============================================

describe('filterConditionGroupSchema', () => {
  it('should accept AND group with conditions', () => {
    const result = filterConditionGroupSchema.safeParse({
      operator: 'AND',
      conditions: [
        { field: 'hostname', operator: 'contains', value: 'web' },
        { field: 'status', operator: 'equals', value: 'online' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should accept OR group', () => {
    const result = filterConditionGroupSchema.safeParse({
      operator: 'OR',
      conditions: [
        { field: 'osType', operator: 'equals', value: 'windows' },
        { field: 'osType', operator: 'equals', value: 'macos' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should accept nested groups', () => {
    const result = filterConditionGroupSchema.safeParse({
      operator: 'AND',
      conditions: [
        { field: 'status', operator: 'equals', value: 'online' },
        {
          operator: 'OR',
          conditions: [
            { field: 'osType', operator: 'equals', value: 'windows' },
            { field: 'osType', operator: 'equals', value: 'linux' },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty conditions array', () => {
    const result = filterConditionGroupSchema.safeParse({
      operator: 'AND',
      conditions: [],
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid group operator', () => {
    const result = filterConditionGroupSchema.safeParse({
      operator: 'NOT',
      conditions: [{ field: 'hostname', operator: 'equals', value: 'test' }],
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing conditions', () => {
    const result = filterConditionGroupSchema.safeParse({
      operator: 'AND',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================
// Filter Root
// ============================================

describe('filterRootSchema', () => {
  it('should accept a single condition', () => {
    const result = filterRootSchema.safeParse({
      field: 'status',
      operator: 'equals',
      value: 'online',
    });
    expect(result.success).toBe(true);
  });

  it('should accept a condition group', () => {
    const result = filterRootSchema.safeParse({
      operator: 'AND',
      conditions: [
        { field: 'hostname', operator: 'contains', value: 'srv' },
      ],
    });
    expect(result.success).toBe(true);
  });
});

// ============================================
// Saved Filters
// ============================================

describe('createSavedFilterSchema', () => {
  const validConditions = {
    operator: 'AND' as const,
    conditions: [
      { field: 'status', operator: 'equals', value: 'online' },
    ],
  };

  it('should accept valid saved filter', () => {
    const result = createSavedFilterSchema.safeParse({
      name: 'Online Servers',
      conditions: validConditions,
    });
    expect(result.success).toBe(true);
  });

  it('should accept with optional description', () => {
    const result = createSavedFilterSchema.safeParse({
      name: 'Online Servers',
      description: 'Shows all servers currently online',
      conditions: validConditions,
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty name', () => {
    const result = createSavedFilterSchema.safeParse({
      name: '',
      conditions: validConditions,
    });
    expect(result.success).toBe(false);
  });

  it('should reject name over 200 chars', () => {
    const result = createSavedFilterSchema.safeParse({
      name: 'x'.repeat(201),
      conditions: validConditions,
    });
    expect(result.success).toBe(false);
  });

  it('should reject description over 1000 chars', () => {
    const result = createSavedFilterSchema.safeParse({
      name: 'Test',
      description: 'x'.repeat(1001),
      conditions: validConditions,
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing conditions', () => {
    const result = createSavedFilterSchema.safeParse({
      name: 'Test',
    });
    expect(result.success).toBe(false);
  });
});

describe('updateSavedFilterSchema', () => {
  it('should accept partial update', () => {
    const result = updateSavedFilterSchema.safeParse({
      name: 'Updated Name',
    });
    expect(result.success).toBe(true);
  });

  it('should accept null description', () => {
    const result = updateSavedFilterSchema.safeParse({
      description: null,
    });
    expect(result.success).toBe(true);
  });

  it('should accept empty object', () => {
    const result = updateSavedFilterSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('savedFilterQuerySchema', () => {
  it('should accept empty query and apply defaults', () => {
    const result = savedFilterQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(50);
    }
  });

  it('should coerce string page/limit', () => {
    const result = savedFilterQuerySchema.safeParse({ page: '3', limit: '10' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
      expect(result.data.limit).toBe(10);
    }
  });

  it('should accept search parameter', () => {
    const result = savedFilterQuerySchema.safeParse({ search: 'online' });
    expect(result.success).toBe(true);
  });

  it('should reject page less than 1', () => {
    const result = savedFilterQuerySchema.safeParse({ page: 0 });
    expect(result.success).toBe(false);
  });

  it('should reject limit greater than 100', () => {
    const result = savedFilterQuerySchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it('should reject limit less than 1', () => {
    const result = savedFilterQuerySchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });
});
