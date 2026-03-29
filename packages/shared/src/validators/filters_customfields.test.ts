import { describe, it, expect } from 'vitest';
import {
  customFieldTypeSchema,
  customFieldOptionsSchema,
  createCustomFieldSchema,
  updateCustomFieldSchema,
  customFieldQuerySchema,
  createDynamicGroupSchema,
  updateDynamicGroupSchema,
  pinDeviceToGroupSchema,
} from './filters';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = '660e8400-e29b-41d4-a716-446655440001';

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
