import { describe, it, expect } from 'vitest';
import {
  // Config Policy
  createConfigPolicySchema,
  updateConfigPolicySchema,
  addFeatureLinkSchema,
  updateFeatureLinkSchema,
  assignPolicySchema,
  diffSchema,
  listConfigPoliciesSchema,
  targetQuerySchema,
  configPolicyIdParamSchema,
  configPolicyLinkIdParamSchema,
  configPolicyAssignmentIdParamSchema,
  configPolicyDeviceIdParamSchema,
} from './index';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = '660e8400-e29b-41d4-a716-446655440001';

// ============================================
// Config Policy
// ============================================

describe('createConfigPolicySchema', () => {
  it('should accept minimal config policy', () => {
    const result = createConfigPolicySchema.safeParse({ name: 'Default Policy' });
    expect(result.success).toBe(true);
  });

  it('should accept config policy with all fields', () => {
    const result = createConfigPolicySchema.safeParse({
      name: 'Default Policy',
      description: 'Applies to all devices',
      status: 'active',
      orgId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty name', () => {
    expect(createConfigPolicySchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('should reject name over 255 chars', () => {
    expect(
      createConfigPolicySchema.safeParse({ name: 'x'.repeat(256) }).success
    ).toBe(false);
  });

  it('should accept all status values', () => {
    const statuses = ['active', 'inactive', 'archived'] as const;
    for (const status of statuses) {
      expect(
        createConfigPolicySchema.safeParse({ name: 'Test', status }).success
      ).toBe(true);
    }
  });

  it('should reject invalid status', () => {
    expect(
      createConfigPolicySchema.safeParse({ name: 'Test', status: 'deleted' }).success
    ).toBe(false);
  });
});

describe('updateConfigPolicySchema', () => {
  it('should accept empty object', () => {
    expect(updateConfigPolicySchema.safeParse({}).success).toBe(true);
  });

  it('should accept partial update', () => {
    expect(
      updateConfigPolicySchema.safeParse({ name: 'Updated', status: 'archived' }).success
    ).toBe(true);
  });
});

describe('addFeatureLinkSchema', () => {
  it('should accept with featurePolicyId', () => {
    const result = addFeatureLinkSchema.safeParse({
      featureType: 'patch',
      featurePolicyId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should accept with inlineSettings', () => {
    const result = addFeatureLinkSchema.safeParse({
      featureType: 'monitoring',
      inlineSettings: { interval: 60 },
    });
    expect(result.success).toBe(true);
  });

  it('should accept all feature types', () => {
    const featureTypes = [
      'patch', 'alert_rule', 'backup', 'security', 'monitoring',
      'maintenance', 'compliance', 'automation', 'event_log',
      'software_policy', 'sensitive_data', 'peripheral_control',
      'warranty', 'helper',
    ] as const;
    for (const featureType of featureTypes) {
      const result = addFeatureLinkSchema.safeParse({
        featureType,
        inlineSettings: {},
      });
      expect(result.success).toBe(true);
    }
  });

  it('should reject without featurePolicyId and inlineSettings', () => {
    const result = addFeatureLinkSchema.safeParse({
      featureType: 'patch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid feature type', () => {
    const result = addFeatureLinkSchema.safeParse({
      featureType: 'custom',
      inlineSettings: {},
    });
    expect(result.success).toBe(false);
  });
});

describe('updateFeatureLinkSchema', () => {
  it('should accept empty object', () => {
    expect(updateFeatureLinkSchema.safeParse({}).success).toBe(true);
  });

  it('should accept nullable featurePolicyId', () => {
    expect(
      updateFeatureLinkSchema.safeParse({ featurePolicyId: null }).success
    ).toBe(true);
  });

  it('should accept nullable inlineSettings', () => {
    expect(
      updateFeatureLinkSchema.safeParse({ inlineSettings: null }).success
    ).toBe(true);
  });

  it('should accept valid UUID for featurePolicyId', () => {
    expect(
      updateFeatureLinkSchema.safeParse({ featurePolicyId: VALID_UUID }).success
    ).toBe(true);
  });
});

describe('assignPolicySchema', () => {
  it('should accept valid assignment', () => {
    const result = assignPolicySchema.safeParse({
      level: 'organization',
      targetId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should accept all levels', () => {
    const levels = ['partner', 'organization', 'site', 'device_group', 'device'] as const;
    for (const level of levels) {
      expect(
        assignPolicySchema.safeParse({ level, targetId: VALID_UUID }).success
      ).toBe(true);
    }
  });

  it('should accept optional priority', () => {
    const result = assignPolicySchema.safeParse({
      level: 'device',
      targetId: VALID_UUID,
      priority: 100,
    });
    expect(result.success).toBe(true);
  });

  it('should reject priority over 1000', () => {
    const result = assignPolicySchema.safeParse({
      level: 'device',
      targetId: VALID_UUID,
      priority: 1001,
    });
    expect(result.success).toBe(false);
  });

  it('should reject negative priority', () => {
    const result = assignPolicySchema.safeParse({
      level: 'device',
      targetId: VALID_UUID,
      priority: -1,
    });
    expect(result.success).toBe(false);
  });

  it('should accept roleFilter with device roles', () => {
    const result = assignPolicySchema.safeParse({
      level: 'organization',
      targetId: VALID_UUID,
      roleFilter: ['server', 'workstation'],
    });
    expect(result.success).toBe(true);
  });

  it('should accept osFilter', () => {
    const result = assignPolicySchema.safeParse({
      level: 'site',
      targetId: VALID_UUID,
      osFilter: ['windows', 'linux'],
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid level', () => {
    expect(
      assignPolicySchema.safeParse({ level: 'global', targetId: VALID_UUID }).success
    ).toBe(false);
  });
});

describe('diffSchema', () => {
  it('should accept add entries', () => {
    const result = diffSchema.safeParse({
      add: [
        {
          configPolicyId: VALID_UUID,
          level: 'organization',
          targetId: VALID_UUID_2,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should accept remove entries', () => {
    const result = diffSchema.safeParse({
      remove: [VALID_UUID],
    });
    expect(result.success).toBe(true);
  });

  it('should accept both add and remove', () => {
    const result = diffSchema.safeParse({
      add: [
        {
          configPolicyId: VALID_UUID,
          level: 'site',
          targetId: VALID_UUID_2,
          priority: 10,
        },
      ],
      remove: [VALID_UUID],
    });
    expect(result.success).toBe(true);
  });

  it('should accept empty object', () => {
    expect(diffSchema.safeParse({}).success).toBe(true);
  });
});

describe('listConfigPoliciesSchema', () => {
  it('should accept empty query', () => {
    expect(listConfigPoliciesSchema.safeParse({}).success).toBe(true);
  });

  it('should accept all parameters', () => {
    const result = listConfigPoliciesSchema.safeParse({
      page: '1',
      limit: '25',
      status: 'active',
      search: 'default',
      orgId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid status', () => {
    expect(
      listConfigPoliciesSchema.safeParse({ status: 'deleted' }).success
    ).toBe(false);
  });
});

describe('targetQuerySchema', () => {
  it('should accept valid query', () => {
    const result = targetQuerySchema.safeParse({
      level: 'device',
      targetId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should reject missing level', () => {
    expect(targetQuerySchema.safeParse({ targetId: VALID_UUID }).success).toBe(false);
  });

  it('should reject missing targetId', () => {
    expect(targetQuerySchema.safeParse({ level: 'device' }).success).toBe(false);
  });
});

// ============================================
// Config Policy Param Schemas
// ============================================

describe('configPolicyIdParamSchema', () => {
  it('should accept valid UUID', () => {
    expect(configPolicyIdParamSchema.safeParse({ id: VALID_UUID }).success).toBe(true);
  });

  it('should reject invalid UUID', () => {
    expect(configPolicyIdParamSchema.safeParse({ id: 'bad' }).success).toBe(false);
  });
});

describe('configPolicyLinkIdParamSchema', () => {
  it('should accept valid UUIDs', () => {
    expect(
      configPolicyLinkIdParamSchema.safeParse({ id: VALID_UUID, linkId: VALID_UUID_2 }).success
    ).toBe(true);
  });

  it('should reject missing linkId', () => {
    expect(
      configPolicyLinkIdParamSchema.safeParse({ id: VALID_UUID }).success
    ).toBe(false);
  });
});

describe('configPolicyAssignmentIdParamSchema', () => {
  it('should accept valid UUIDs', () => {
    expect(
      configPolicyAssignmentIdParamSchema.safeParse({ id: VALID_UUID, aid: VALID_UUID_2 }).success
    ).toBe(true);
  });
});

describe('configPolicyDeviceIdParamSchema', () => {
  it('should accept valid UUID', () => {
    expect(
      configPolicyDeviceIdParamSchema.safeParse({ deviceId: VALID_UUID }).success
    ).toBe(true);
  });

  it('should reject invalid UUID', () => {
    expect(
      configPolicyDeviceIdParamSchema.safeParse({ deviceId: 'bad' }).success
    ).toBe(false);
  });
});
