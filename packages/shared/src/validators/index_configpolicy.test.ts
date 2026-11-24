import { CONFIG_FEATURE_TYPES, RETIRED_CONFIG_FEATURE_TYPES } from '../constants/configFeatureTypes';
import { describe, it, expect } from 'vitest';
import {
  // Config Policy
  createConfigPolicySchema,
  updateConfigPolicySchema,
  addFeatureLinkSchema,
  updateFeatureLinkSchema,
  assignPolicySchema,
  applyAssignmentsSchema,
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
      featureType: 'monitors',
      inlineSettings: { checkIntervalSeconds: 60 },
    });
    expect(result.success).toBe(true);
  });

  it('should accept all feature types', () => {
    for (const featureType of CONFIG_FEATURE_TYPES) {
      const result = addFeatureLinkSchema.safeParse({
        featureType,
        inlineSettings: {},
      });
      expect(result.success).toBe(true);
    }
  });

  // Create is deliberately stricter than update: "no linked feature policy"
  // is expressed by omitting the key. Clients must not send null here
  // (useFeatureLink strips it; RecommendedMonitors did not, #7627).
  it('rejects a null featurePolicyId on create even with inlineSettings (#7627)', () => {
    const result = addFeatureLinkSchema.safeParse({
      featureType: 'monitors',
      featurePolicyId: null,
      inlineSettings: { items: [], inheritance: 'cumulative' },
    });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues.map((i) => i.path.join('.'))).toContain('featurePolicyId');
  });

  it('accepts the same create body with featurePolicyId omitted (#7627)', () => {
    const result = addFeatureLinkSchema.safeParse({
      featureType: 'monitors',
      inlineSettings: { items: [], inheritance: 'cumulative' },
    });
    expect(result.success).toBe(true);
  });

  it('should reject without featurePolicyId and inlineSettings', () => {
    const result = addFeatureLinkSchema.safeParse({
      featureType: 'patch',
    });
    expect(result.success).toBe(false);
  });

  it.each(RETIRED_CONFIG_FEATURE_TYPES)('rejects retired feature type %s', (featureType) => {
    expect(addFeatureLinkSchema.safeParse({ featureType, inlineSettings: {} }).success).toBe(false);
  });

  it('should reject invalid feature type', () => {
    const result = addFeatureLinkSchema.safeParse({
      featureType: 'custom',
      inlineSettings: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects the reserved patch export marker recursively for every feature type', () => {
    const featureTypes = [
      'patch', 'alert_rule', 'backup', 'security', 'monitoring', 'maintenance',
      'compliance', 'automation', 'event_log', 'software_policy', 'sensitive_data',
      'peripheral_control', 'warranty', 'helper', 'remote_access', 'pam',
      'onedrive_helper', 'vulnerability',
    ] as const;
    for (const featureType of featureTypes) {
      const result = addFeatureLinkSchema.safeParse({
        featureType,
        inlineSettings: { nested: { __breezePatchInlineMirror: 'attacker-value' } },
      });
      expect(result.success, featureType).toBe(false);
    }
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

  it('rejects the reserved patch export marker recursively on update', () => {
    expect(updateFeatureLinkSchema.safeParse({
      inlineSettings: { nested: [{ __breezePatchInlineMirror: 'attacker-value' }] },
    }).success).toBe(false);
  });

  it('fails closed for non-JSON cyclic or excessively large service inputs', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(updateFeatureLinkSchema.safeParse({ inlineSettings: cyclic }).success).toBe(false);

    const tooManyObjects = {
      nested: Array.from({ length: 10_001 }, () => ({})),
    };
    expect(updateFeatureLinkSchema.safeParse({ inlineSettings: tooManyObjects }).success).toBe(false);
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

  it('accepts the applies-to filters (#12462 W03a)', () => {
    const result = listConfigPoliciesSchema.safeParse({ appliesToOrgId: VALID_UUID, notApplied: 'true' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ appliesToOrgId: VALID_UUID, notApplied: 'true' });
  });

  it('rejects a malformed appliesToOrgId and any notApplied other than "true"', () => {
    expect(listConfigPoliciesSchema.safeParse({ appliesToOrgId: 'not-a-uuid' }).success).toBe(false);
    expect(listConfigPoliciesSchema.safeParse({ notApplied: 'false' }).success).toBe(false);
    expect(listConfigPoliciesSchema.safeParse({ notApplied: '1' }).success).toBe(false);
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

// ============================================
// Config Policy Inheritance (#5080 W01)
// ============================================

describe('config policy inheritance validators', () => {
  it('accepts an optional uuid parentPolicyId on create', () => {
    const ok = createConfigPolicySchema.safeParse({ name: 'child', parentPolicyId: VALID_UUID });
    expect(ok.success).toBe(true);
    expect(
      createConfigPolicySchema.safeParse({ name: 'child', parentPolicyId: 'nope' }).success
    ).toBe(false);
  });

  it('accepts create without parentPolicyId (optional)', () => {
    expect(createConfigPolicySchema.safeParse({ name: 'root' }).success).toBe(true);
  });

  // parent_policy_id is immutable after create (enforced by the DB constraint
  // trigger configuration_policies_parent_immutable). The update schema must
  // never carry it through to the service.
  it('update schema strips parentPolicyId (immutable)', () => {
    const parsed = updateConfigPolicySchema.parse({ name: 'x', parentPolicyId: VALID_UUID } as never);
    expect('parentPolicyId' in parsed).toBe(false);
  });
});

describe('applyAssignmentsSchema', () => {
  const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-e29b-41d4-a716-446655440000`;

  it('apply schema defaults the three lists to empty', () => {
    const result = applyAssignmentsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ add: [], update: [], remove: [] });
      expect(result.data.dryRun).toBeUndefined();
    }
  });

  it('accepts a full Apply with a dry run', () => {
    const result = applyAssignmentsSchema.safeParse({
      add: [{ level: 'site', targetId: VALID_UUID, priority: 5, roleFilter: ['server'], osFilter: ['windows'] }, { level: 'partner' }],
      update: [{ id: VALID_UUID, priority: 3, roleFilter: null, osFilter: ['linux'] }],
      remove: [VALID_UUID_2],
      dryRun: true,
    });
    expect(result.success).toBe(true);
  });

  it('apply schema caps each list at 200', () => {
    const ids = Array.from({ length: 201 }, (_, i) => uuid(i));
    expect(applyAssignmentsSchema.safeParse({ remove: ids }).success).toBe(false);
    expect(applyAssignmentsSchema.safeParse({ remove: ids.slice(0, 200) }).success).toBe(true);
    expect(applyAssignmentsSchema.safeParse({ update: ids.map((id) => ({ id })) }).success).toBe(false);
    expect(applyAssignmentsSchema.safeParse({ add: ids.map((id) => ({ level: 'device', targetId: id })) }).success).toBe(false);
  });

  it('apply schema refuses an id in both update and remove', () => {
    const result = applyAssignmentsSchema.safeParse({ update: [{ id: VALID_UUID, priority: 1 }], remove: [VALID_UUID] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['remove', 0]);
  });

  it('refuses the same id twice within update or within remove', () => {
    expect(applyAssignmentsSchema.safeParse({ remove: [VALID_UUID, VALID_UUID] }).success).toBe(false);
    expect(applyAssignmentsSchema.safeParse({ update: [{ id: VALID_UUID }, { id: VALID_UUID, priority: 2 }] }).success).toBe(false);
  });

  it('keeps the per-field checks on the fields', () => {
    expect(applyAssignmentsSchema.safeParse({ update: [{ id: 'not-a-uuid' }] }).success).toBe(false);
    expect(applyAssignmentsSchema.safeParse({ update: [{ id: VALID_UUID, priority: 1001 }] }).success).toBe(false);
    expect(applyAssignmentsSchema.safeParse({ update: [{ id: VALID_UUID, osFilter: ['plan9'] }] }).success).toBe(false);
    expect(applyAssignmentsSchema.safeParse({ add: [{ level: 'galaxy', targetId: VALID_UUID }] }).success).toBe(false);
    expect(applyAssignmentsSchema.safeParse({ remove: ['nope'] }).success).toBe(false);
  });
});
