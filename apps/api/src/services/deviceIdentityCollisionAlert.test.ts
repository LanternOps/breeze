import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('./alertService', () => ({
  createAlert: vi.fn(async () => 'alert-created'),
  alertRuleOwnershipConditionForOrg: vi.fn(async () => 'ownership-condition'),
}));

vi.mock('./alertConditions', () => ({
  interpolateTemplate: vi.fn((tpl: string, ctx: Record<string, unknown>) =>
    tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(ctx[k] ?? ''))),
}));

vi.mock('../db/schema', () => ({
  alertTemplates: {
    id: 'id',
    isBuiltIn: 'isBuiltIn',
    conditions: 'conditions',
    severity: 'severity',
    titleTemplate: 'titleTemplate',
    messageTemplate: 'messageTemplate',
  },
  alertRules: {
    id: 'id',
    name: 'name',
    templateId: 'templateId',
    isActive: 'isActive',
    targetType: 'targetType',
    targetId: 'targetId',
    overrideSettings: 'overrideSettings',
  },
}));

import { db } from '../db';
import { createAlert } from './alertService';
import { raiseDeviceIdentityCollisionAlert } from './deviceIdentityCollisionAlert';

function mockSelectOnce(rows: Record<string, unknown>[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(rows),
      })),
    })),
  } as any);
}

const BUILT_IN_TEMPLATE = {
  id: 'tpl-collision',
  severity: 'high',
  titleTemplate: 'Possible device replacement: {{hostname}}',
  messageTemplate: 'New {{newDeviceId}} may replace {{existingDeviceId}}',
};

const INPUT = {
  orgId: 'org-1',
  siteId: 'site-1',
  hostname: 'host-1',
  newDeviceId: 'device-new',
  existingDeviceId: 'device-old',
  collidingDeviceIds: ['device-old'],
};

describe('raiseDeviceIdentityCollisionAlert (#2764)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an alert on the NEW device when the org has an active rule for the built-in template', async () => {
    mockSelectOnce([BUILT_IN_TEMPLATE]);
    mockSelectOnce([{ id: 'rule-1', name: 'Identity collision', overrideSettings: null }]);

    const result = await raiseDeviceIdentityCollisionAlert(INPUT);

    expect(result).toBe('alert-created');
    expect(createAlert).toHaveBeenCalledWith(expect.objectContaining({
      ruleId: 'rule-1',
      deviceId: 'device-new',
      orgId: 'org-1',
      severity: 'high',
      title: 'Possible device replacement: host-1',
      message: 'New device-new may replace device-old',
      context: expect.objectContaining({
        eventType: 'device.identity_collision',
        existingDeviceId: 'device-old',
        collidingDeviceIds: ['device-old'],
      }),
    }));
  });

  it('honours a rule severity override', async () => {
    mockSelectOnce([BUILT_IN_TEMPLATE]);
    mockSelectOnce([{ id: 'rule-1', name: 'r', overrideSettings: { severity: 'critical' } }]);

    await raiseDeviceIdentityCollisionAlert(INPUT);

    expect(createAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
  });

  it('skips silently when the org has no rule bound to the template', async () => {
    mockSelectOnce([BUILT_IN_TEMPLATE]);
    mockSelectOnce([]);

    const result = await raiseDeviceIdentityCollisionAlert(INPUT);

    expect(result).toBeNull();
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('skips silently when the built-in template has not been seeded yet', async () => {
    mockSelectOnce([]);

    const result = await raiseDeviceIdentityCollisionAlert(INPUT);

    expect(result).toBeNull();
    expect(createAlert).not.toHaveBeenCalled();
  });
});
