import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentPolicy } from '@breeze/shared';

const dbMockState = vi.hoisted(() => ({
  organizationRows: [] as unknown[],
  aiAgentRows: [] as unknown[][],
  budgetRows: [] as unknown[],
  ambientContext: undefined as { scope: string } | undefined,
  systemContextActive: false,
  order: [] as string[],
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const tableName = (table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')];
        let rows: unknown[];

        if (tableName === 'organizations') {
          dbMockState.order.push(
            dbMockState.systemContextActive
              ? 'organizations:system'
              : 'organizations:outside-system',
          );
          rows = dbMockState.organizationRows;
        } else if (tableName === 'ai_agents') {
          rows = dbMockState.aiAgentRows.shift() ?? [];
        } else if (tableName === 'ai_budgets') {
          rows = dbMockState.budgetRows;
        } else {
          throw new Error(`Unexpected table: ${String(tableName)}`);
        }

        return {
          where: vi.fn(() => ({
            limit: vi.fn(async () => rows),
          })),
        };
      }),
    })),
  },
  getCurrentDbAccessContext: vi.fn(() => dbMockState.ambientContext),
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    dbMockState.order.push('runOutsideDbContext');
    return fn();
  }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    dbMockState.order.push('withSystemDbAccessContext');
    const previousContext = dbMockState.ambientContext;
    dbMockState.ambientContext = { scope: 'system' };
    dbMockState.systemContextActive = true;
    try {
      return await fn();
    } finally {
      dbMockState.systemContextActive = false;
      dbMockState.ambientContext = previousContext;
    }
  }),
}));

import {
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
import type { AuthContext } from '../../middleware/auth';
import {
  mergeAgentPolicies,
  normalizeAgentPolicy,
  resolveEffectiveAgent,
  resolveEffectiveAgentSystem,
} from './effectivePolicy';

const PARTNER_USER_ID = '00000000-0000-4000-8000-000000000001';
const ORG_USER_ID = '00000000-0000-4000-8000-000000000002';
const PARTNER_ROLE_ID = '00000000-0000-4000-8000-000000000003';
const ORG_ROLE_ID = '00000000-0000-4000-8000-000000000004';
const ALERT_RULE_A = '00000000-0000-4000-8000-000000000005';
const SITE_A = '00000000-0000-4000-8000-000000000006';
const GROUP_A = '00000000-0000-4000-8000-000000000007';
const GROUP_B = '00000000-0000-4000-8000-000000000008';
const ORG_ID = '00000000-0000-4000-8000-000000000009';
const PARTNER_ID = '00000000-0000-4000-8000-000000000010';
const PARTNER_AGENT_ID = '00000000-0000-4000-8000-000000000011';
const ORG_AGENT_ID = '00000000-0000-4000-8000-000000000012';
const SCRIPT_A = '00000000-0000-4000-8000-000000000013';
const SCRIPT_B = '00000000-0000-4000-8000-000000000014';
const SCRIPT_C = '00000000-0000-4000-8000-000000000015';
const KEY_A = 'manage_services:restart';
const KEY_B = 'manage_services:stop';
const KEY_C = 'security_scan:quarantine';

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
    actAssets: { scriptIds: [] },
    instructions: 'partner says hi',
    cooldownSeconds: 300,
    ...over,
  };
}

function seedResolverRows(options: { partnerBaseline?: boolean } = {}): void {
  const { partnerBaseline = true } = options;
  const partner = {
    id: PARTNER_AGENT_ID,
    partnerId: PARTNER_ID,
    orgId: null,
    kind: 'triage',
    ...policy({
      model: 'partner-model',
      toolAllowlist: ['run_script', 'disk_cleanup'],
      limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxDevicesPerRun: 10 },
    }),
  };
  const org = {
    id: ORG_AGENT_ID,
    partnerId: PARTNER_ID,
    orgId: ORG_ID,
    kind: 'triage',
    ...policy({
      mode: 'shadow',
      model: 'org-model',
      toolAllowlist: ['run_script'],
      limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxDevicesPerRun: 3 },
      cooldownSeconds: 600,
    }),
  };

  dbMockState.organizationRows = [{ id: ORG_ID, partnerId: PARTNER_ID }];
  dbMockState.aiAgentRows = [[org], partnerBaseline ? [partner] : []];
  dbMockState.budgetRows = [{ allowedModels: ['org-model'] }];
}

function withoutResolvedAt<T extends { resolvedAt: string }>(snapshot: T): Omit<T, 'resolvedAt'> {
  const { resolvedAt: _resolvedAt, ...rest } = snapshot;
  return rest;
}

const canAccessOrg = vi.fn(() => true);
const authStub = { canAccessOrg } as unknown as AuthContext;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  dbMockState.organizationRows = [];
  dbMockState.aiAgentRows = [];
  dbMockState.budgetRows = [];
  dbMockState.ambientContext = undefined;
  dbMockState.systemContextActive = false;
  dbMockState.order = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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
      actAssets: { scriptIds: [SCRIPT_A, SCRIPT_B], supervisedActionKeys: [KEY_A, KEY_B] },
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
      actAssets: { scriptIds: [SCRIPT_B, SCRIPT_C], supervisedActionKeys: [KEY_B, KEY_C] },
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
      actAssets: { scriptIds: [SCRIPT_B], supervisedActionKeys: [KEY_B] },
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
      actAssets: 'merged',
      instructions: 'merged',
      cooldownSeconds: 'partner',
    } as const satisfies Record<keyof AiAgentPolicy, 'partner' | 'org' | 'merged'>;

    for (const field of Object.keys(expected) as Array<keyof AiAgentPolicy>) {
      expect(effective[field], field).toEqual(expected[field]);
      expect(provenance[field], `${field} provenance`).toBe(expectedProvenance[field]);
    }
  });

  it('narrows ticketCategories/ticketPriorities by intersection, same convention as siteIds/deviceGroupIds (wave 6 PR 3, #3828)', () => {
    const partner = policy({
      triggers: {
        alertSeverities: ['critical', 'high'],
        ticketCategories: ['hardware', 'network', 'software'],
        ticketPriorities: ['high', 'urgent'],
        respectMaintenanceWindows: false,
      },
    });
    const org = policy({
      triggers: {
        alertSeverities: ['critical', 'high'],
        ticketCategories: ['network', 'software', 'billing'],
        ticketPriorities: ['high', 'normal'],
        respectMaintenanceWindows: false,
      },
    });

    const { effective } = mergeAgentPolicies(partner, org, { allowedModels: null });

    expect(effective.triggers.ticketCategories).toEqual(['network', 'software']);
    expect(effective.triggers.ticketPriorities).toEqual(['high']);
  });

  it('ticketCategories/ticketPriorities stay undefined (unrestricted) when neither side sets them', () => {
    const partner = policy();
    const org = policy();

    const { effective } = mergeAgentPolicies(partner, org, { allowedModels: null });

    expect(effective.triggers.ticketCategories).toBeUndefined();
    expect(effective.triggers.ticketPriorities).toBeUndefined();
  });

  it('uses the org model only when the org budget allows it', () => {
    const partner = policy({ model: 'partner-model' });
    const org = policy({ model: 'org-model' });

    expect(mergeAgentPolicies(partner, org, { allowedModels: ['partner-model'] }).effective.model)
      .toBe('partner-model');
    expect(mergeAgentPolicies(partner, org, { allowedModels: ['org-model'] }).effective.model)
      .toBe('org-model');
  });

  it('mergeLimits min-wins on maxActionsPerRun: partner 5 + org 2 -> 2', () => {
    const partner = policy({ limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxActionsPerRun: 5 } });
    const org = policy({ limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxActionsPerRun: 2 } });

    expect(mergeAgentPolicies(partner, org, { allowedModels: null }).effective.limits.maxActionsPerRun)
      .toBe(2);
  });

  it('mergeLimits min-wins on maxPolicyDecisionsPerDay: partner 50 + org 10 -> 10 (#3827)', () => {
    const partner = policy({ limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxPolicyDecisionsPerDay: 50 } });
    const org = policy({ limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxPolicyDecisionsPerDay: 10 } });

    expect(mergeAgentPolicies(partner, org, { allowedModels: null }).effective.limits.maxPolicyDecisionsPerDay)
      .toBe(10);
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
      actAssets: {},
      instructions: null,
      cooldownSeconds: 900,
    });

    expect(normalized.limits).toEqual(AI_AGENT_LIMIT_DEFAULTS);
    expect(normalized.triggers.alertSeverities).toEqual(['critical', 'high']);
    expect(normalized.recipients).toEqual({ userIds: [], roleIds: [] });
    expect(normalized.actAssets).toEqual({ scriptIds: [], supervisedActionKeys: [] });
  });

  it('supervisedActionKeys narrows exactly like scriptIds: absent partner field, empty-partner-baseline stands alone', () => {
    // No org override at all: effective === partner verbatim (the existing
    // `if (!org) return { effective: partner, ... }` early return) — a
    // partner-wide baseline row's own supervisedActionKeys is never
    // intersected against anything.
    const partnerOnly = policy({ actAssets: { scriptIds: [], supervisedActionKeys: [KEY_A] } });
    expect(mergeAgentPolicies(partnerOnly, null, { allowedModels: null }).effective.actAssets)
      .toEqual({ scriptIds: [], supervisedActionKeys: [KEY_A] });

    // Org narrows: intersection, never union — org's KEY_C (not on the
    // partner baseline) is dropped.
    const partner = policy({ actAssets: { scriptIds: [], supervisedActionKeys: [KEY_A, KEY_B] } });
    const org = policy({ actAssets: { scriptIds: [], supervisedActionKeys: [KEY_B, KEY_C] } });
    expect(mergeAgentPolicies(partner, org, { allowedModels: null }).effective.actAssets)
      .toEqual({ scriptIds: [], supervisedActionKeys: [KEY_B] });

    // An empty partner baseline narrows the org to empty too — "never
    // policy-decidable" is the correct default, same as scriptIds/run_script.
    const emptyPartner = policy({ actAssets: { scriptIds: [], supervisedActionKeys: [] } });
    const wideOrg = policy({ actAssets: { scriptIds: [], supervisedActionKeys: [KEY_A] } });
    expect(mergeAgentPolicies(emptyPartner, wideOrg, { allowedModels: null }).effective.actAssets)
      .toEqual({ scriptIds: [], supervisedActionKeys: [] });

    // A row missing the key entirely (pre-this-deploy jsonb, no version bump)
    // merges as if it were an empty array, on either side.
    const legacyPartner = policy({ actAssets: { scriptIds: [] } });
    const orgWithKeys = policy({ actAssets: { scriptIds: [], supervisedActionKeys: [KEY_A] } });
    expect(mergeAgentPolicies(legacyPartner, orgWithKeys, { allowedModels: null }).effective.actAssets)
      .toEqual({ scriptIds: [], supervisedActionKeys: [] });
  });
});

// Wave 6 PR 4 follow-up (#3828) — conservative per-agent opt-in for anomaly
// admission. Deliberately NOT this file's usual tighten-only (AND/
// intersection) contract, and deliberately NOT "either layer true → true":
// only the ORG's own triggers row governs. See AiAgentTriggers.
// anomalyEnabled's docstring (packages/shared) for the full rationale.
describe('mergeAgentPolicies — anomalyEnabled conservative opt-in (wave-6-4 follow-up, #3828)', () => {
  it('a partner baseline alone can NEVER opt an org in: no org override at all, partner sets true -> effective is falsy', () => {
    const partner = policy({ triggers: { ...policy().triggers, anomalyEnabled: true } });
    const { effective } = mergeAgentPolicies(partner, null, { allowedModels: null });

    expect(effective.triggers.anomalyEnabled).not.toBe(true);
  });

  it('org override present but does not set anomalyEnabled -> effective is falsy even when partner is true', () => {
    const partner = policy({ triggers: { ...policy().triggers, anomalyEnabled: true } });
    const org = policy(); // no anomalyEnabled key at all
    const { effective } = mergeAgentPolicies(partner, org, { allowedModels: null });

    expect(effective.triggers.anomalyEnabled).not.toBe(true);
  });

  it('org override explicitly sets anomalyEnabled: false -> effective is false even when partner is true', () => {
    const partner = policy({ triggers: { ...policy().triggers, anomalyEnabled: true } });
    const org = policy({ triggers: { ...policy().triggers, anomalyEnabled: false } });
    const { effective } = mergeAgentPolicies(partner, org, { allowedModels: null });

    expect(effective.triggers.anomalyEnabled).not.toBe(true);
  });

  it("the org's OWN override governs regardless of the partner's value: org true + partner false -> effective true", () => {
    const partner = policy({ triggers: { ...policy().triggers, anomalyEnabled: false } });
    const org = policy({ triggers: { ...policy().triggers, anomalyEnabled: true } });
    const { effective } = mergeAgentPolicies(partner, org, { allowedModels: null });

    expect(effective.triggers.anomalyEnabled).toBe(true);
  });

  it("the org's OWN override governs even when the partner never set it at all: org true + partner absent -> effective true", () => {
    const partner = policy(); // no anomalyEnabled key at all
    const org = policy({ triggers: { ...policy().triggers, anomalyEnabled: true } });
    const { effective } = mergeAgentPolicies(partner, org, { allowedModels: null });

    expect(effective.triggers.anomalyEnabled).toBe(true);
  });

  it('does not disturb the general "no org override -> effective === partner" invariant for every other field', () => {
    const partner = policy({ triggers: { ...policy().triggers, anomalyEnabled: true } });
    const { effective } = mergeAgentPolicies(partner, null, { allowedModels: null });

    expect(effective).toEqual({ ...partner, triggers: { ...partner.triggers, anomalyEnabled: undefined } });
  });
});

// P2-4 Task A6 (#4191) — ticketAutonomousWrites gets the SAME conservative
// org-row-only opt-in rule as anomalyEnabled above (same docstring, same
// rationale: a partner-wide baseline row must never blanket-enable
// unattended ticket writes for every org under it). See
// AiAgentTriggers.ticketAutonomousWrites's docstring (packages/shared).
describe('mergeAgentPolicies — ticketAutonomousWrites conservative opt-in (P2-4 #4191)', () => {
  it('a partner baseline alone can NEVER opt an org in: no org override at all, partner sets true -> effective is falsy', () => {
    const partner = policy({ triggers: { ...policy().triggers, ticketAutonomousWrites: true } });
    const { effective } = mergeAgentPolicies(partner, null, { allowedModels: null });

    expect(effective.triggers.ticketAutonomousWrites).not.toBe(true);
  });

  it('org override present but does not set ticketAutonomousWrites -> effective is falsy even when partner is true', () => {
    const partner = policy({ triggers: { ...policy().triggers, ticketAutonomousWrites: true } });
    const org = policy(); // no ticketAutonomousWrites key at all
    const { effective } = mergeAgentPolicies(partner, org, { allowedModels: null });

    expect(effective.triggers.ticketAutonomousWrites).not.toBe(true);
  });

  it('org override explicitly sets ticketAutonomousWrites: false -> effective is false even when partner is true', () => {
    const partner = policy({ triggers: { ...policy().triggers, ticketAutonomousWrites: true } });
    const org = policy({ triggers: { ...policy().triggers, ticketAutonomousWrites: false } });
    const { effective } = mergeAgentPolicies(partner, org, { allowedModels: null });

    expect(effective.triggers.ticketAutonomousWrites).not.toBe(true);
  });

  it("the org's OWN override governs regardless of the partner's value: org true + partner false -> effective true", () => {
    const partner = policy({ triggers: { ...policy().triggers, ticketAutonomousWrites: false } });
    const org = policy({ triggers: { ...policy().triggers, ticketAutonomousWrites: true } });
    const { effective } = mergeAgentPolicies(partner, org, { allowedModels: null });

    expect(effective.triggers.ticketAutonomousWrites).toBe(true);
  });

  it("the org's OWN override governs even when the partner never set it at all: org true + partner absent -> effective true", () => {
    const partner = policy(); // no ticketAutonomousWrites key at all
    const org = policy({ triggers: { ...policy().triggers, ticketAutonomousWrites: true } });
    const { effective } = mergeAgentPolicies(partner, org, { allowedModels: null });

    expect(effective.triggers.ticketAutonomousWrites).toBe(true);
  });

  it('does not disturb the general "no org override -> effective === partner" invariant for every other field', () => {
    const partner = policy({ triggers: { ...policy().triggers, ticketAutonomousWrites: true } });
    const { effective } = mergeAgentPolicies(partner, null, { allowedModels: null });

    expect(effective).toEqual({
      ...partner,
      triggers: { ...partner.triggers, ticketAutonomousWrites: undefined },
    });
  });
});

describe('resolveEffectiveAgentSystem', () => {
  it('returns the same merged snapshot as the authorized resolver', async () => {
    seedResolverRows();
    const authorized = await resolveEffectiveAgent(authStub, ORG_ID, 'triage');
    expect(canAccessOrg).toHaveBeenCalledWith(ORG_ID);
    expect(authorized?.effective).toMatchObject({
      mode: 'shadow',
      model: 'org-model',
      toolAllowlist: ['run_script'],
      cooldownSeconds: 600,
    });
    expect(authorized?.effective.limits.maxDevicesPerRun).toBe(3);

    seedResolverRows();
    const system = await resolveEffectiveAgentSystem(ORG_ID, 'triage');

    expect(system).not.toBeNull();
    expect(withoutResolvedAt(system!)).toEqual(withoutResolvedAt(authorized!));
  });

  it('returns null without a partner baseline for both resolver variants', async () => {
    seedResolverRows({ partnerBaseline: false });
    await expect(resolveEffectiveAgentSystem(ORG_ID, 'triage')).resolves.toBeNull();

    seedResolverRows({ partnerBaseline: false });
    await expect(resolveEffectiveAgent(authStub, ORG_ID, 'triage')).resolves.toBeNull();
  });

  it('does not touch the authorized resolver auth gate', async () => {
    seedResolverRows();

    await expect(resolveEffectiveAgentSystem(ORG_ID, 'triage')).resolves.not.toBeNull();

    expect(canAccessOrg).not.toHaveBeenCalled();
  });

  it('escapes ambient context before entering system context for all reads', async () => {
    seedResolverRows();

    await expect(resolveEffectiveAgentSystem(ORG_ID, 'triage')).resolves.not.toBeNull();

    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    expect(dbMockState.order.slice(0, 3)).toEqual([
      'runOutsideDbContext',
      'withSystemDbAccessContext',
      'organizations:system',
    ]);
  });

  it('reuses an existing system context without holding another connection', async () => {
    seedResolverRows();
    dbMockState.ambientContext = { scope: 'system' };

    await expect(resolveEffectiveAgentSystem(ORG_ID, 'triage')).resolves.not.toBeNull();

    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });
});
