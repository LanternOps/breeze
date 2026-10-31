import { describe, it, expect } from 'vitest';

import { formatToolName, plural } from './utils';

describe('plural', () => {
  it('uses the singular form for exactly 1', () => {
    expect(plural(1, 'device')).toBe('1 device');
    expect(plural(1, 'finding')).toBe('1 finding');
  });

  it('adds an s for 0 and many', () => {
    expect(plural(0, 'device')).toBe('0 devices');
    expect(plural(3, 'finding')).toBe('3 findings');
  });

  it('supports an explicit plural form for irregular nouns', () => {
    expect(plural(2, 'entry', 'entries')).toBe('2 entries');
    expect(plural(1, 'entry', 'entries')).toBe('1 entry');
  });
});

describe('formatToolName (#10197)', () => {
  it.each([
    ['sync_edr_data', 'Sync EDR Data'],
    ['manage_dns_policy', 'Manage DNS Policy'],
    ['manage_ai_agents (authorize_supervised_key)', 'Manage AI Agents (Authorize Supervised Key)'],
    [
      'manage_dr_plan (create_plan/update_plan/add_group/update_group)',
      'Manage DR Plan (Create Plan/Update Plan/Add Group/Update Group)',
    ],
    ['edr_endpoint_action (scan)', 'EDR Endpoint Action (Scan)'],
    ['ioc_hunt (sweep/import_iocs)', 'IOC Hunt (Sweep/Import IOCs)'],
    ['apply_cis_remediation', 'Apply CIS Remediation'],
    ['get_sla_compliance', 'Get SLA Compliance'],
    ['manage_hyperv_vm (start/stop)', 'Manage Hyper-V VM (Start/Stop)'],
    ['query_hyperv_vms', 'Query Hyper-V VMs'],
    ['m365_revoke_sessions', 'M365 Revoke Sessions'],
    ['trigger_unifi_sync', 'Trigger UniFi Sync'],
    ['get_ip_history', 'Get IP History'],
    ['run_script', 'Run Script'],
  ])('%s -> %s', (key, label) => {
    expect(formatToolName(key)).toBe(label);
  });

  it('names AI-task tool and action keys without the retired "Operator" noun', () => {
    expect(formatToolName('operator_plan')).toBe('AI Task Plan');
    expect(formatToolName('list_operator_tasks')).toBe('List AI Tasks');
    expect(formatToolName('get_operator_task')).toBe('Get AI Task');
    expect(formatToolName('launch_specialist (operator_recipe/patch_plan)')).toBe(
      'Launch Specialist (AI Task/Patch Plan)',
    );
  });

  it('maps whole words only, never a word that merely starts with an acronym', () => {
    expect(formatToolName('drive_aid_report')).toBe('Drive Aid Report');
  });
});
