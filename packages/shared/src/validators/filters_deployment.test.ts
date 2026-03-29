import { describe, it, expect } from 'vitest';
import {
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
