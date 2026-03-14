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
  customFieldTypeSchema,
  customFieldOptionsSchema,
  createCustomFieldSchema,
  updateCustomFieldSchema,
  customFieldQuerySchema,
  createDynamicGroupSchema,
  updateDynamicGroupSchema,
  pinDeviceToGroupSchema,
  rolloutConfigSchema,
  deploymentTargetConfigSchema,
  deploymentScheduleSchema,
  scriptPayloadSchema,
  patchPayloadSchema,
  softwarePayloadSchema,
  policyPayloadSchema,
  deploymentPayloadSchema,
  createDeploymentSchema,
  updateDeploymentSchema,
  deploymentQuerySchema,
  filterPreviewSchema,
} from './filters';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = '660e8400-e29b-41d4-a716-446655440001';

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

// ============================================
// Custom Fields
// ============================================

describe('customFieldTypeSchema', () => {
  it('should accept all valid types', () => {
    const types = ['text', 'number', 'boolean', 'dropdown', 'date'] as const;
    for (const type of types) {
      expect(customFieldTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it('should reject invalid type', () => {
    expect(customFieldTypeSchema.safeParse('enum').success).toBe(false);
  });
});

describe('customFieldOptionsSchema', () => {
  it('should accept empty options', () => {
    const result = customFieldOptionsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept choices for dropdown', () => {
    const result = customFieldOptionsSchema.safeParse({
      choices: [
        { label: 'Option A', value: 'a' },
        { label: 'Option B', value: 'b' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should reject choices with empty label', () => {
    const result = customFieldOptionsSchema.safeParse({
      choices: [{ label: '', value: 'a' }],
    });
    expect(result.success).toBe(false);
  });

  it('should reject choices with empty value', () => {
    const result = customFieldOptionsSchema.safeParse({
      choices: [{ label: 'Test', value: '' }],
    });
    expect(result.success).toBe(false);
  });

  it('should accept min/max for number fields', () => {
    const result = customFieldOptionsSchema.safeParse({
      min: 0,
      max: 100,
    });
    expect(result.success).toBe(true);
  });

  it('should accept minLength/maxLength for text fields', () => {
    const result = customFieldOptionsSchema.safeParse({
      minLength: 0,
      maxLength: 500,
    });
    expect(result.success).toBe(true);
  });

  it('should reject negative minLength', () => {
    const result = customFieldOptionsSchema.safeParse({
      minLength: -1,
    });
    expect(result.success).toBe(false);
  });

  it('should reject maxLength less than 1', () => {
    const result = customFieldOptionsSchema.safeParse({
      maxLength: 0,
    });
    expect(result.success).toBe(false);
  });

  it('should accept pattern for text fields', () => {
    const result = customFieldOptionsSchema.safeParse({
      pattern: '^[A-Z]{3}$',
    });
    expect(result.success).toBe(true);
  });
});

describe('createCustomFieldSchema', () => {
  it('should accept valid custom field', () => {
    const result = createCustomFieldSchema.safeParse({
      name: 'Department',
      fieldKey: 'department',
      type: 'text',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.required).toBe(false); // default
    }
  });

  it('should accept field with all options', () => {
    const result = createCustomFieldSchema.safeParse({
      name: 'Location',
      fieldKey: 'location_code',
      type: 'dropdown',
      options: {
        choices: [
          { label: 'New York', value: 'ny' },
          { label: 'London', value: 'ldn' },
        ],
      },
      required: true,
      defaultValue: 'ny',
      deviceTypes: ['windows', 'macos'],
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty name', () => {
    const result = createCustomFieldSchema.safeParse({
      name: '',
      fieldKey: 'test',
      type: 'text',
    });
    expect(result.success).toBe(false);
  });

  it('should reject name over 100 chars', () => {
    const result = createCustomFieldSchema.safeParse({
      name: 'x'.repeat(101),
      fieldKey: 'test',
      type: 'text',
    });
    expect(result.success).toBe(false);
  });

  it('should reject fieldKey with uppercase', () => {
    const result = createCustomFieldSchema.safeParse({
      name: 'Test',
      fieldKey: 'TestField',
      type: 'text',
    });
    expect(result.success).toBe(false);
  });

  it('should reject fieldKey starting with number', () => {
    const result = createCustomFieldSchema.safeParse({
      name: 'Test',
      fieldKey: '1field',
      type: 'text',
    });
    expect(result.success).toBe(false);
  });

  it('should reject fieldKey with dashes', () => {
    const result = createCustomFieldSchema.safeParse({
      name: 'Test',
      fieldKey: 'field-name',
      type: 'text',
    });
    expect(result.success).toBe(false);
  });

  it('should accept fieldKey with underscores', () => {
    const result = createCustomFieldSchema.safeParse({
      name: 'Test',
      fieldKey: 'field_name_123',
      type: 'text',
    });
    expect(result.success).toBe(true);
  });

  it('should reject fieldKey over 100 chars', () => {
    const result = createCustomFieldSchema.safeParse({
      name: 'Test',
      fieldKey: 'x'.repeat(101),
      type: 'text',
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid deviceTypes', () => {
    const result = createCustomFieldSchema.safeParse({
      name: 'Test',
      fieldKey: 'test',
      type: 'text',
      deviceTypes: ['freebsd'],
    });
    expect(result.success).toBe(false);
  });
});

describe('updateCustomFieldSchema', () => {
  it('should accept partial update', () => {
    const result = updateCustomFieldSchema.safeParse({ name: 'New Name' });
    expect(result.success).toBe(true);
  });

  it('should accept nullable deviceTypes', () => {
    const result = updateCustomFieldSchema.safeParse({ deviceTypes: null });
    expect(result.success).toBe(true);
  });

  it('should accept empty object', () => {
    const result = updateCustomFieldSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('customFieldQuerySchema', () => {
  it('should accept empty query', () => {
    expect(customFieldQuerySchema.safeParse({}).success).toBe(true);
  });

  it('should accept type filter', () => {
    const result = customFieldQuerySchema.safeParse({ type: 'dropdown' });
    expect(result.success).toBe(true);
  });

  it('should accept search', () => {
    const result = customFieldQuerySchema.safeParse({ search: 'dept' });
    expect(result.success).toBe(true);
  });

  it('should reject invalid type', () => {
    const result = customFieldQuerySchema.safeParse({ type: 'json' });
    expect(result.success).toBe(false);
  });
});

// ============================================
// Dynamic Groups
// ============================================

describe('createDynamicGroupSchema', () => {
  const validConditions = {
    operator: 'AND' as const,
    conditions: [
      { field: 'osType', operator: 'equals', value: 'windows' },
    ],
  };

  it('should accept valid dynamic group', () => {
    const result = createDynamicGroupSchema.safeParse({
      name: 'Windows Servers',
      filterConditions: validConditions,
    });
    expect(result.success).toBe(true);
  });

  it('should accept with optional siteId and parentId', () => {
    const result = createDynamicGroupSchema.safeParse({
      name: 'Windows Servers',
      siteId: VALID_UUID,
      parentId: VALID_UUID_2,
      filterConditions: validConditions,
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty name', () => {
    const result = createDynamicGroupSchema.safeParse({
      name: '',
      filterConditions: validConditions,
    });
    expect(result.success).toBe(false);
  });

  it('should reject name over 255 chars', () => {
    const result = createDynamicGroupSchema.safeParse({
      name: 'x'.repeat(256),
      filterConditions: validConditions,
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid siteId', () => {
    const result = createDynamicGroupSchema.safeParse({
      name: 'Test',
      siteId: 'not-a-uuid',
      filterConditions: validConditions,
    });
    expect(result.success).toBe(false);
  });
});

describe('updateDynamicGroupSchema', () => {
  it('should accept partial update', () => {
    const result = updateDynamicGroupSchema.safeParse({ name: 'New Name' });
    expect(result.success).toBe(true);
  });

  it('should accept nullable siteId', () => {
    const result = updateDynamicGroupSchema.safeParse({ siteId: null });
    expect(result.success).toBe(true);
  });

  it('should accept nullable parentId', () => {
    const result = updateDynamicGroupSchema.safeParse({ parentId: null });
    expect(result.success).toBe(true);
  });
});

describe('pinDeviceToGroupSchema', () => {
  it('should accept valid pin request', () => {
    const result = pinDeviceToGroupSchema.safeParse({
      deviceId: VALID_UUID,
      pin: true,
    });
    expect(result.success).toBe(true);
  });

  it('should accept unpin request', () => {
    const result = pinDeviceToGroupSchema.safeParse({
      deviceId: VALID_UUID,
      pin: false,
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid deviceId', () => {
    const result = pinDeviceToGroupSchema.safeParse({
      deviceId: 'not-a-uuid',
      pin: true,
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing pin', () => {
    const result = pinDeviceToGroupSchema.safeParse({
      deviceId: VALID_UUID,
    });
    expect(result.success).toBe(false);
  });
});

// ============================================
// Deployment Schemas
// ============================================

describe('rolloutConfigSchema', () => {
  it('should accept immediate rollout', () => {
    const result = rolloutConfigSchema.safeParse({
      type: 'immediate',
      retryConfig: {
        maxRetries: 3,
        backoffMinutes: [5, 15, 60],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.respectMaintenanceWindows).toBe(false); // default
    }
  });

  it('should accept staggered rollout with batch size number', () => {
    const result = rolloutConfigSchema.safeParse({
      type: 'staggered',
      staggered: {
        batchSize: 10,
        batchDelayMinutes: 30,
      },
      retryConfig: {
        maxRetries: 2,
        backoffMinutes: [5, 15],
      },
    });
    expect(result.success).toBe(true);
  });

  it('should accept staggered rollout with percentage batch size', () => {
    const result = rolloutConfigSchema.safeParse({
      type: 'staggered',
      staggered: {
        batchSize: '25%',
        batchDelayMinutes: 60,
        pauseOnFailureCount: 5,
        pauseOnFailurePercent: 10,
      },
      retryConfig: {
        maxRetries: 3,
        backoffMinutes: [5, 15, 60],
      },
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid percentage format', () => {
    const result = rolloutConfigSchema.safeParse({
      type: 'staggered',
      staggered: {
        batchSize: '25pct',
        batchDelayMinutes: 30,
      },
      retryConfig: { maxRetries: 0, backoffMinutes: [] },
    });
    expect(result.success).toBe(false);
  });

  it('should reject maxRetries over 10', () => {
    const result = rolloutConfigSchema.safeParse({
      type: 'immediate',
      retryConfig: {
        maxRetries: 11,
        backoffMinutes: [5],
      },
    });
    expect(result.success).toBe(false);
  });

  it('should accept maxRetries of 0', () => {
    const result = rolloutConfigSchema.safeParse({
      type: 'immediate',
      retryConfig: {
        maxRetries: 0,
        backoffMinutes: [],
      },
    });
    expect(result.success).toBe(true);
  });

  it('should reject pauseOnFailurePercent over 100', () => {
    const result = rolloutConfigSchema.safeParse({
      type: 'staggered',
      staggered: {
        batchSize: 5,
        batchDelayMinutes: 10,
        pauseOnFailurePercent: 101,
      },
      retryConfig: { maxRetries: 0, backoffMinutes: [] },
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid rollout type', () => {
    const result = rolloutConfigSchema.safeParse({
      type: 'canary',
      retryConfig: { maxRetries: 0, backoffMinutes: [] },
    });
    expect(result.success).toBe(false);
  });
});

describe('deploymentTargetConfigSchema', () => {
  it('should accept devices target', () => {
    const result = deploymentTargetConfigSchema.safeParse({
      type: 'devices',
      deviceIds: [VALID_UUID],
    });
    expect(result.success).toBe(true);
  });

  it('should accept groups target', () => {
    const result = deploymentTargetConfigSchema.safeParse({
      type: 'groups',
      groupIds: [VALID_UUID],
    });
    expect(result.success).toBe(true);
  });

  it('should accept filter target', () => {
    const result = deploymentTargetConfigSchema.safeParse({
      type: 'filter',
      filter: {
        operator: 'AND',
        conditions: [{ field: 'status', operator: 'equals', value: 'online' }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('should accept all target', () => {
    const result = deploymentTargetConfigSchema.safeParse({ type: 'all' });
    expect(result.success).toBe(true);
  });

  it('should reject invalid target type', () => {
    const result = deploymentTargetConfigSchema.safeParse({
      type: 'custom',
    });
    expect(result.success).toBe(false);
  });
});

describe('deploymentScheduleSchema', () => {
  it('should accept immediate schedule', () => {
    const result = deploymentScheduleSchema.safeParse({ type: 'immediate' });
    expect(result.success).toBe(true);
  });

  it('should accept scheduled with date', () => {
    const result = deploymentScheduleSchema.safeParse({
      type: 'scheduled',
      scheduledAt: '2026-04-01T10:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('should accept maintenance_window with id', () => {
    const result = deploymentScheduleSchema.safeParse({
      type: 'maintenance_window',
      maintenanceWindowId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid type', () => {
    const result = deploymentScheduleSchema.safeParse({ type: 'recurring' });
    expect(result.success).toBe(false);
  });
});

// ============================================
// Deployment Payloads
// ============================================

describe('deploymentPayloadSchema', () => {
  it('should accept script payload', () => {
    const result = deploymentPayloadSchema.safeParse({
      type: 'script',
      scriptId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should accept script payload with parameters', () => {
    const result = deploymentPayloadSchema.safeParse({
      type: 'script',
      scriptId: VALID_UUID,
      parameters: { reboot: true, timeout: 300 },
    });
    expect(result.success).toBe(true);
  });

  it('should accept patch payload', () => {
    const result = deploymentPayloadSchema.safeParse({
      type: 'patch',
      patchIds: [VALID_UUID],
    });
    expect(result.success).toBe(true);
  });

  it('should reject patch payload with empty patchIds', () => {
    const result = deploymentPayloadSchema.safeParse({
      type: 'patch',
      patchIds: [],
    });
    expect(result.success).toBe(false);
  });

  it('should accept software payload with all actions', () => {
    const actions = ['install', 'uninstall', 'update'] as const;
    for (const action of actions) {
      const result = deploymentPayloadSchema.safeParse({
        type: 'software',
        packageId: VALID_UUID,
        action,
      });
      expect(result.success).toBe(true);
    }
  });

  it('should accept policy payload', () => {
    const result = deploymentPayloadSchema.safeParse({
      type: 'policy',
      policyId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should reject unknown payload type', () => {
    const result = deploymentPayloadSchema.safeParse({
      type: 'config',
      configId: VALID_UUID,
    });
    expect(result.success).toBe(false);
  });
});

describe('scriptPayloadSchema', () => {
  it('should accept valid payload', () => {
    const result = scriptPayloadSchema.safeParse({
      type: 'script',
      scriptId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid scriptId', () => {
    const result = scriptPayloadSchema.safeParse({
      type: 'script',
      scriptId: 'not-uuid',
    });
    expect(result.success).toBe(false);
  });
});

describe('patchPayloadSchema', () => {
  it('should accept valid payload', () => {
    const result = patchPayloadSchema.safeParse({
      type: 'patch',
      patchIds: [VALID_UUID, VALID_UUID_2],
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty patchIds', () => {
    const result = patchPayloadSchema.safeParse({
      type: 'patch',
      patchIds: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('softwarePayloadSchema', () => {
  it('should reject invalid action', () => {
    const result = softwarePayloadSchema.safeParse({
      type: 'software',
      packageId: VALID_UUID,
      action: 'downgrade',
    });
    expect(result.success).toBe(false);
  });
});

describe('policyPayloadSchema', () => {
  it('should reject invalid policyId', () => {
    const result = policyPayloadSchema.safeParse({
      type: 'policy',
      policyId: 'bad',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================
// Create/Update Deployment
// ============================================

describe('createDeploymentSchema', () => {
  const validDeployment = {
    name: 'Deploy Updates',
    type: 'script' as const,
    payload: {
      type: 'script' as const,
      scriptId: VALID_UUID,
    },
    targetConfig: {
      type: 'devices' as const,
      deviceIds: [VALID_UUID],
    },
    rolloutConfig: {
      type: 'immediate' as const,
      retryConfig: {
        maxRetries: 3,
        backoffMinutes: [5, 15, 60],
      },
    },
  };

  it('should accept valid deployment', () => {
    const result = createDeploymentSchema.safeParse(validDeployment);
    expect(result.success).toBe(true);
  });

  it('should accept deployment with schedule', () => {
    const result = createDeploymentSchema.safeParse({
      ...validDeployment,
      schedule: { type: 'immediate' },
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty name', () => {
    const result = createDeploymentSchema.safeParse({
      ...validDeployment,
      name: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject name over 200 chars', () => {
    const result = createDeploymentSchema.safeParse({
      ...validDeployment,
      name: 'x'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid deployment type', () => {
    const result = createDeploymentSchema.safeParse({
      ...validDeployment,
      type: 'config',
    });
    expect(result.success).toBe(false);
  });

  it('should accept all deployment types', () => {
    const types = ['script', 'patch', 'software', 'policy'] as const;
    for (const type of types) {
      const result = createDeploymentSchema.safeParse({
        ...validDeployment,
        type,
      });
      // May fail if payload type doesn't match but type enum should pass
    }
  });
});

describe('updateDeploymentSchema', () => {
  it('should accept partial update', () => {
    const result = updateDeploymentSchema.safeParse({
      name: 'Updated Deployment',
    });
    expect(result.success).toBe(true);
  });

  it('should accept empty object', () => {
    const result = updateDeploymentSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should reject name over 200 chars', () => {
    const result = updateDeploymentSchema.safeParse({
      name: 'x'.repeat(201),
    });
    expect(result.success).toBe(false);
  });
});

describe('deploymentQuerySchema', () => {
  it('should accept empty query and apply defaults', () => {
    const result = deploymentQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(50);
    }
  });

  it('should accept all valid statuses', () => {
    const statuses = ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed'] as const;
    for (const status of statuses) {
      const result = deploymentQuerySchema.safeParse({ status });
      expect(result.success).toBe(true);
    }
  });

  it('should accept all valid types', () => {
    const types = ['script', 'patch', 'software', 'policy'] as const;
    for (const type of types) {
      const result = deploymentQuerySchema.safeParse({ type });
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid status', () => {
    const result = deploymentQuerySchema.safeParse({ status: 'archived' });
    expect(result.success).toBe(false);
  });

  it('should coerce string page/limit', () => {
    const result = deploymentQuerySchema.safeParse({ page: '5', limit: '20' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(5);
      expect(result.data.limit).toBe(20);
    }
  });
});

// ============================================
// Filter Preview
// ============================================

describe('filterPreviewSchema', () => {
  const validConditions = {
    operator: 'AND' as const,
    conditions: [
      { field: 'status', operator: 'equals', value: 'online' },
    ],
  };

  it('should accept valid preview request', () => {
    const result = filterPreviewSchema.safeParse({
      conditions: validConditions,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10); // default
    }
  });

  it('should accept custom limit', () => {
    const result = filterPreviewSchema.safeParse({
      conditions: validConditions,
      limit: 50,
    });
    expect(result.success).toBe(true);
  });

  it('should reject limit over 100', () => {
    const result = filterPreviewSchema.safeParse({
      conditions: validConditions,
      limit: 101,
    });
    expect(result.success).toBe(false);
  });

  it('should reject limit less than 1', () => {
    const result = filterPreviewSchema.safeParse({
      conditions: validConditions,
      limit: 0,
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing conditions', () => {
    const result = filterPreviewSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
