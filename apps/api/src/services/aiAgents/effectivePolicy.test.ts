import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentPolicy } from '@breeze/shared';
import { mergeAgentPolicies, normalizeAgentPolicy } from './effectivePolicy';

const PARTNER_USER_ID = '00000000-0000-4000-8000-000000000001';
const ORG_USER_ID = '00000000-0000-4000-8000-000000000002';
const PARTNER_ROLE_ID = '00000000-0000-4000-8000-000000000003';
const ORG_ROLE_ID = '00000000-0000-4000-8000-000000000004';
const ALERT_RULE_A = '00000000-0000-4000-8000-000000000005';
const SITE_A = '00000000-0000-4000-8000-000000000006';
const GROUP_A = '00000000-0000-4000-8000-000000000007';
const GROUP_B = '00000000-0000-4000-8000-000000000008';

function policy(over: Partial<AiAgentPolicy> = {}): AiAgentPolicy {
  return {
    enabled: true,
    mode: 'act',
    model: null,
    toolAllowlist: ['run_script', 'manage_services:restart', 'disk_cleanup'],
    protectedResources: {
      services: ['MSSQLSERVER'],
      paths: [],
      registryKeys: [],
      deviceTags: [],
    },
    limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxDevicesPerRun: 10, maxRunsPerHour: 50 },
    triggers: {
      alertSeverities: ['critical', 'high', 'medium'],
      respectMaintenanceWindows: false,
    },
    recipients: { userIds: [PARTNER_USER_ID], roleIds: [PARTNER_ROLE_ID] },
    instructions: 'partner says hi',
    cooldownSeconds: 300,
    ...over,
  };
}

describe('mergeAgentPolicies — tighten only', () => {
  it('uses the partner policy unchanged when there is no org override', () => {
    const partner = policy();
    const { effective, provenance } = mergeAgentPolicies(partner, null, { allowedModels: null });

    expect(effective).toEqual(partner);
    for (const field of Object.keys(partner) as Array<keyof AiAgentPolicy>) {
      expect(provenance[field]).toBe('partner');
    }
  });

  it('applies the tightening rule for every policy field', () => {
    const partner = policy({
      enabled: false,
      mode: 'shadow',
      model: 'partner-model',
      toolAllowlist: ['run_script', 'manage_services:restart'],
      protectedResources: {
        services: ['MSSQLSERVER'],
        paths: ['C:\\ProgramData\\Partner'],
        registryKeys: [],
        deviceTags: ['protected-partner'],
      },
      limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxDevicesPerRun: 10, maxRunsPerHour: 50 },
      triggers: {
        alertSeverities: ['critical', 'high'],
        alertRuleIds: [ALERT_RULE_A],
        deviceGroupIds: [GROUP_A, GROUP_B],
        deviceTags: ['server', 'database'],
        respectMaintenanceWindows: false,
      },
      recipients: { userIds: [PARTNER_USER_ID], roleIds: [PARTNER_ROLE_ID] },
      cooldownSeconds: 300,
    });
    const org = policy({
      enabled: true,
      mode: 'act',
      model: 'org-model',
      toolAllowlist: ['run_script', 'file_operations:delete'],
      protectedResources: {
        services: ['Spooler'],
        paths: ['C:\\Windows'],
        registryKeys: ['HKLM\\Software\\Protected'],
        deviceTags: ['protected-org'],
      },
      limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxDevicesPerRun: 50, maxRunsPerHour: 5 },
      triggers: {
        alertSeverities: ['critical', 'medium'],
        siteIds: [SITE_A],
        deviceGroupIds: [GROUP_B],
        deviceTags: ['database', 'workstation'],
        respectMaintenanceWindows: true,
      },
      recipients: { userIds: [ORG_USER_ID], roleIds: [ORG_ROLE_ID] },
      instructions: 'org says hi',
      cooldownSeconds: 60,
    });

    const { effective, provenance } = mergeAgentPolicies(partner, org, {
      allowedModels: ['partner-model'],
    });
    const expected: { [K in keyof AiAgentPolicy]: AiAgentPolicy[K] } = {
      enabled: false,
      mode: 'shadow',
      model: 'partner-model',
      toolAllowlist: ['run_script'],
      protectedResources: {
        services: ['MSSQLSERVER', 'Spooler'],
        paths: ['C:\\ProgramData\\Partner', 'C:\\Windows'],
        registryKeys: ['HKLM\\Software\\Protected'],
        deviceTags: ['protected-partner', 'protected-org'],
      },
      limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxDevicesPerRun: 10, maxRunsPerHour: 5 },
      triggers: {
        alertSeverities: ['critical'],
        alertRuleIds: [ALERT_RULE_A],
        siteIds: [SITE_A],
        deviceGroupIds: [GROUP_B],
        deviceTags: ['database'],
        respectMaintenanceWindows: true,
      },
      recipients: {
        userIds: [PARTNER_USER_ID, ORG_USER_ID],
        roleIds: [PARTNER_ROLE_ID, ORG_ROLE_ID],
      },
      instructions:
        '[partner guidance]\npartner says hi\n[/partner guidance]\n\n' +
        '[organization guidance]\norg says hi\n[/organization guidance]',
      cooldownSeconds: 300,
    };
    const expectedProvenance = {
      enabled: 'partner',
      mode: 'partner',
      model: 'partner',
      toolAllowlist: 'merged',
      protectedResources: 'merged',
      limits: 'merged',
      triggers: 'merged',
      recipients: 'merged',
      instructions: 'merged',
      cooldownSeconds: 'partner',
    } as const satisfies Record<keyof AiAgentPolicy, 'partner' | 'org' | 'merged'>;

    for (const field of Object.keys(expected) as Array<keyof AiAgentPolicy>) {
      expect(effective[field], field).toEqual(expected[field]);
      expect(provenance[field], `${field} provenance`).toBe(expectedProvenance[field]);
    }
  });

  it('uses the org model only when the org budget allows it', () => {
    const partner = policy({ model: 'partner-model' });
    const org = policy({ model: 'org-model' });

    expect(mergeAgentPolicies(partner, org, { allowedModels: ['partner-model'] }).effective.model)
      .toBe('partner-model');
    expect(mergeAgentPolicies(partner, org, { allowedModels: ['org-model'] }).effective.model)
      .toBe('org-model');
  });

  it('fills JSONB defaults when normalizing a sparse row', () => {
    const normalized = normalizeAgentPolicy({
      enabled: false,
      mode: 'off',
      model: null,
      toolAllowlist: [],
      protectedResources: {},
      limits: {},
      triggers: {},
      recipients: {},
      instructions: null,
      cooldownSeconds: 900,
    });

    expect(normalized.limits).toEqual(AI_AGENT_LIMIT_DEFAULTS);
    expect(normalized.triggers.alertSeverities).toEqual(['critical', 'high']);
    expect(normalized.recipients).toEqual({ userIds: [], roleIds: [] });
  });
});
