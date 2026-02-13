import { describe, expect, it } from 'vitest';
import { fleetToolInputSchemas } from './aiToolSchemasFleet';

const TEST_UUID = '00000000-0000-0000-0000-000000000001';
const TEST_UUID2 = '00000000-0000-0000-0000-000000000002';

function parse(tool: string, input: unknown) {
  return fleetToolInputSchemas[tool]!.safeParse(input);
}

// ─── manage_policies ────────────────────────────────────────────────────

describe('manage_policies schema', () => {
  it('accepts valid list action', () => {
    expect(parse('manage_policies', { action: 'list' }).success).toBe(true);
  });

  it('accepts valid list with filters', () => {
    expect(parse('manage_policies', { action: 'list', enforcement: 'enforce', enabled: true, limit: 50 }).success).toBe(true);
  });

  it('requires policyId for get/update/delete/evaluate/activate/deactivate/remediate', () => {
    for (const action of ['get', 'compliance_status', 'evaluate', 'update', 'activate', 'deactivate', 'delete', 'remediate']) {
      const result = parse('manage_policies', { action });
      expect(result.success).toBe(false);
    }
  });

  it('accepts get with policyId', () => {
    expect(parse('manage_policies', { action: 'get', policyId: TEST_UUID }).success).toBe(true);
  });

  it('requires name, rules, targets for create', () => {
    const result = parse('manage_policies', { action: 'create', name: 'Test' });
    expect(result.success).toBe(false);
  });

  it('accepts valid create', () => {
    expect(parse('manage_policies', {
      action: 'create',
      name: 'Require AV',
      rules: { hasAntivirus: true },
      targets: { groupId: TEST_UUID },
    }).success).toBe(true);
  });

  it('rejects invalid action', () => {
    expect(parse('manage_policies', { action: 'invalid' }).success).toBe(false);
  });

  it('rejects invalid enforcement value', () => {
    expect(parse('manage_policies', { action: 'list', enforcement: 'strict' }).success).toBe(false);
  });
});

// ─── manage_deployments ─────────────────────────────────────────────────

describe('manage_deployments schema', () => {
  it('accepts valid list', () => {
    expect(parse('manage_deployments', { action: 'list' }).success).toBe(true);
  });

  it('requires deploymentId for get/start/pause/resume/cancel', () => {
    for (const action of ['get', 'device_status', 'start', 'pause', 'resume', 'cancel']) {
      expect(parse('manage_deployments', { action }).success).toBe(false);
    }
  });

  it('accepts pause with deploymentId', () => {
    expect(parse('manage_deployments', { action: 'pause', deploymentId: TEST_UUID }).success).toBe(true);
  });

  it('requires all fields for create', () => {
    expect(parse('manage_deployments', { action: 'create', name: 'Deploy' }).success).toBe(false);
  });

  it('accepts valid create', () => {
    expect(parse('manage_deployments', {
      action: 'create',
      name: 'Feb Update',
      type: 'software',
      payload: { url: 'https://example.com/pkg' },
      targetType: 'group',
      targetConfig: { groupId: TEST_UUID },
      rolloutConfig: { batchSize: 10 },
    }).success).toBe(true);
  });
});

// ─── manage_patches ─────────────────────────────────────────────────────

describe('manage_patches schema', () => {
  it('accepts valid list', () => {
    expect(parse('manage_patches', { action: 'list' }).success).toBe(true);
  });

  it('accepts list with filters', () => {
    expect(parse('manage_patches', { action: 'list', source: 'microsoft', severity: 'critical' }).success).toBe(true);
  });

  it('requires patchId for approve/decline/defer/rollback', () => {
    for (const action of ['approve', 'decline', 'defer', 'rollback']) {
      expect(parse('manage_patches', { action }).success).toBe(false);
    }
  });

  it('accepts approve with patchId', () => {
    expect(parse('manage_patches', { action: 'approve', patchId: TEST_UUID }).success).toBe(true);
  });

  it('requires patchIds for bulk_approve', () => {
    expect(parse('manage_patches', { action: 'bulk_approve' }).success).toBe(false);
  });

  it('accepts bulk_approve with patchIds', () => {
    expect(parse('manage_patches', { action: 'bulk_approve', patchIds: [TEST_UUID, TEST_UUID2] }).success).toBe(true);
  });

  it('requires patchIds and deviceIds for install', () => {
    expect(parse('manage_patches', { action: 'install', patchIds: [TEST_UUID] }).success).toBe(false);
    expect(parse('manage_patches', { action: 'install', deviceIds: [TEST_UUID] }).success).toBe(false);
  });

  it('accepts valid install', () => {
    expect(parse('manage_patches', {
      action: 'install',
      patchIds: [TEST_UUID],
      deviceIds: [TEST_UUID2],
    }).success).toBe(true);
  });

  it('requires deviceIds for scan', () => {
    expect(parse('manage_patches', { action: 'scan' }).success).toBe(false);
  });

  it('accepts scan with deviceIds', () => {
    expect(parse('manage_patches', { action: 'scan', deviceIds: [TEST_UUID] }).success).toBe(true);
  });
});

// ─── manage_groups ──────────────────────────────────────────────────────

describe('manage_groups schema', () => {
  it('accepts valid list', () => {
    expect(parse('manage_groups', { action: 'list' }).success).toBe(true);
  });

  it('requires groupId for get/update/delete/membership_log/add_devices/remove_devices', () => {
    for (const action of ['get', 'membership_log', 'update', 'delete', 'add_devices', 'remove_devices']) {
      expect(parse('manage_groups', { action }).success).toBe(false);
    }
  });

  it('requires name for create', () => {
    expect(parse('manage_groups', { action: 'create' }).success).toBe(false);
  });

  it('accepts create with name', () => {
    expect(parse('manage_groups', { action: 'create', name: 'Accounting' }).success).toBe(true);
  });

  it('requires deviceIds for add_devices/remove_devices', () => {
    expect(parse('manage_groups', { action: 'add_devices', groupId: TEST_UUID }).success).toBe(false);
  });

  it('accepts add_devices with groupId and deviceIds', () => {
    expect(parse('manage_groups', {
      action: 'add_devices',
      groupId: TEST_UUID,
      deviceIds: [TEST_UUID2],
    }).success).toBe(true);
  });

  it('requires filterConditions for preview', () => {
    expect(parse('manage_groups', { action: 'preview' }).success).toBe(false);
  });

  it('accepts preview with filterConditions', () => {
    expect(parse('manage_groups', {
      action: 'preview',
      filterConditions: { os: 'windows' },
    }).success).toBe(true);
  });
});

// ─── manage_maintenance_windows ─────────────────────────────────────────

describe('manage_maintenance_windows schema', () => {
  it('accepts valid list', () => {
    expect(parse('manage_maintenance_windows', { action: 'list' }).success).toBe(true);
  });

  it('accepts active_now', () => {
    expect(parse('manage_maintenance_windows', { action: 'active_now' }).success).toBe(true);
  });

  it('requires windowId for get/update/delete', () => {
    for (const action of ['get', 'update', 'delete']) {
      expect(parse('manage_maintenance_windows', { action }).success).toBe(false);
    }
  });

  it('requires name, startTime, endTime, targetType for create', () => {
    expect(parse('manage_maintenance_windows', { action: 'create', name: 'Test' }).success).toBe(false);
  });

  it('accepts valid create', () => {
    expect(parse('manage_maintenance_windows', {
      action: 'create',
      name: 'Nightly window',
      startTime: '2026-03-01T02:00:00Z',
      endTime: '2026-03-01T06:00:00Z',
      targetType: 'site',
      suppressAlerts: true,
    }).success).toBe(true);
  });
});

// ─── manage_automations ─────────────────────────────────────────────────

describe('manage_automations schema', () => {
  it('accepts valid list', () => {
    expect(parse('manage_automations', { action: 'list' }).success).toBe(true);
  });

  it('accepts list with triggerType filter', () => {
    expect(parse('manage_automations', { action: 'list', triggerType: 'schedule' }).success).toBe(true);
  });

  it('requires automationId for get/history/update/delete/enable/disable/run', () => {
    for (const action of ['get', 'history', 'update', 'delete', 'enable', 'disable', 'run']) {
      expect(parse('manage_automations', { action }).success).toBe(false);
    }
  });

  it('requires name, trigger, actions for create', () => {
    expect(parse('manage_automations', { action: 'create', name: 'Auto' }).success).toBe(false);
  });

  it('accepts valid create', () => {
    expect(parse('manage_automations', {
      action: 'create',
      name: 'Disk cleanup',
      trigger: { type: 'schedule', cron: '0 2 * * *' },
      actions: [{ type: 'script', scriptId: TEST_UUID }],
    }).success).toBe(true);
  });

  it('rejects create with empty actions array', () => {
    expect(parse('manage_automations', {
      action: 'create',
      name: 'Empty',
      trigger: { type: 'event' },
      actions: [],
    }).success).toBe(false);
  });
});

// ─── manage_alert_rules ─────────────────────────────────────────────────

describe('manage_alert_rules schema', () => {
  it('accepts valid list_rules', () => {
    expect(parse('manage_alert_rules', { action: 'list_rules' }).success).toBe(true);
  });

  it('accepts list_channels and alert_summary', () => {
    expect(parse('manage_alert_rules', { action: 'list_channels' }).success).toBe(true);
    expect(parse('manage_alert_rules', { action: 'alert_summary' }).success).toBe(true);
  });

  it('requires ruleId for get_rule/update_rule/delete_rule/test_rule', () => {
    for (const action of ['get_rule', 'update_rule', 'delete_rule', 'test_rule']) {
      expect(parse('manage_alert_rules', { action }).success).toBe(false);
    }
  });

  it('requires name, templateId, targetType, targetId for create_rule', () => {
    expect(parse('manage_alert_rules', { action: 'create_rule', name: 'Test' }).success).toBe(false);
  });

  it('accepts valid create_rule', () => {
    expect(parse('manage_alert_rules', {
      action: 'create_rule',
      name: 'High CPU alert',
      templateId: TEST_UUID,
      targetType: 'group',
      targetId: TEST_UUID2,
      severity: 'high',
    }).success).toBe(true);
  });
});

// ─── generate_report ────────────────────────────────────────────────────

describe('generate_report schema', () => {
  it('accepts valid list', () => {
    expect(parse('generate_report', { action: 'list' }).success).toBe(true);
  });

  it('requires reportId for update/delete/history', () => {
    for (const action of ['update', 'delete', 'history']) {
      expect(parse('generate_report', { action }).success).toBe(false);
    }
  });

  it('requires reportId or reportType for generate', () => {
    expect(parse('generate_report', { action: 'generate' }).success).toBe(false);
  });

  it('accepts generate with reportType', () => {
    expect(parse('generate_report', { action: 'generate', reportType: 'executive_summary' }).success).toBe(true);
  });

  it('accepts generate with reportId', () => {
    expect(parse('generate_report', { action: 'generate', reportId: TEST_UUID }).success).toBe(true);
  });

  it('requires reportType for data', () => {
    expect(parse('generate_report', { action: 'data' }).success).toBe(false);
  });

  it('accepts data with reportType', () => {
    expect(parse('generate_report', { action: 'data', reportType: 'device_inventory' }).success).toBe(true);
  });

  it('requires name and reportType for create', () => {
    expect(parse('generate_report', { action: 'create', name: 'Weekly' }).success).toBe(false);
  });

  it('accepts valid create', () => {
    expect(parse('generate_report', {
      action: 'create',
      name: 'Weekly inventory',
      reportType: 'device_inventory',
      schedule: 'weekly',
      format: 'csv',
    }).success).toBe(true);
  });

  it('rejects invalid reportType', () => {
    expect(parse('generate_report', { action: 'data', reportType: 'invalid_type' }).success).toBe(false);
  });

  it('rejects invalid format', () => {
    expect(parse('generate_report', { action: 'create', name: 'Test', reportType: 'compliance', format: 'docx' }).success).toBe(false);
  });
});
