import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import { PartnerWideWriteDeniedError } from '../partnerWideAccess';
import { AgentAccessDeniedError, assertAgentWriteAllowed } from './access';

const state = vi.hoisted(() => ({
  currentRow: null as Record<string, unknown> | null,
  listRows: [] as Array<Record<string, unknown>>,
  returnedRow: null as Record<string, unknown> | null,
  insertedValues: null as Record<string, unknown> | null,
  updatedValues: null as Record<string, unknown> | null,
  selectWhere: undefined as unknown,
  selectFor: undefined as unknown,
  audit: vi.fn(),
  publish: vi.fn(),
  validateRecipients: vi.fn(),
  hasResolvableAgentRecipient: vi.fn(),
  ensureManagedTriageAutomation: vi.fn(),
  setManagedAutomationEnabled: vi.fn(),
  syncManagedAutomation: vi.fn(),
  validateAuthorizationKeys: vi.fn(),
}));

const schema = vi.hoisted(() => ({
  aiAgents: {
    id: 'aiAgents.id',
    orgId: 'aiAgents.orgId',
    partnerId: 'aiAgents.partnerId',
    disabledAt: 'aiAgents.disabledAt',
    createdAt: 'aiAgents.createdAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ and: conditions }),
  desc: (column: unknown) => ({ desc: column }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
  isNull: (column: unknown) => ({ isNull: column }),
  or: (...conditions: unknown[]) => ({ or: conditions }),
}));

vi.mock('../../db/schema', () => ({ aiAgents: schema.aiAgents }));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          state.selectWhere = condition;
          const rows = state.currentRow ? [state.currentRow] : [];
          return ({
          // `.limit(n)` must itself be awaitable (getAgent/createAgent's
          // duplicate check both `await` it directly with no further
          // chaining) AND support a chained `.for('update')` (withAgentRowLocked)
          // — a plain Promise is a valid target for an extra method since
          // promises are ordinary objects.
          limit: vi.fn(() => {
            const result = Promise.resolve(rows) as Promise<unknown[]> & { for: (mode: string) => Promise<unknown[]> };
            result.for = vi.fn((mode: string) => {
              state.selectFor = mode;
              return Promise.resolve(rows);
            });
            return result;
          }),
          orderBy: vi.fn(async () => state.listRows),
        });
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        state.insertedValues = values;
        return { returning: vi.fn(async () => state.returnedRow ? [state.returnedRow] : []) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        state.updatedValues = values;
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => state.returnedRow ? [state.returnedRow] : []),
          })),
        };
      }),
    })),
  },
}));

// Membership validation has its own suite (recipients.test.ts) against mocked
// membership queries; here it is stubbed so this suite's fixtures count as
// valid-membership, and the CONTRACT — called with the owner and exactly the
// recipients object that will be stored, before any write — is asserted below.
vi.mock('./recipients', () => {
  class InvalidAgentRecipientsError extends Error {
    readonly code = 'invalid_recipients';
    constructor(public invalidUserIds: string[], public invalidRoleIds: string[]) {
      super('invalid_recipients');
      this.name = 'InvalidAgentRecipientsError';
    }
  }
  return {
    InvalidAgentRecipientsError,
    validateAgentRecipients: state.validateRecipients,
    hasResolvableAgentRecipient: state.hasResolvableAgentRecipient,
  };
});

// Real POLICY_DECIDABLE_TIER3 membership/registry semantics have their own
// exhaustive suite (policyDecidable.test.ts). Real aiTools.ts/aiGuardrails.ts
// also pull in the full db/schema barrel (peripheralEventTypeEnum et al.),
// which this file's minimal `../../db/schema` mock does not provide — so this
// is isolated the same way ./recipients is above: a controllable stub whose
// CONTRACT (called with exactly the keys this write is setting, before
// anything is written) is what agentService.ts owns and this suite asserts.
vi.mock('../actionIntents/policyDecidable', () => ({
  validateAuthorizationKeys: state.validateAuthorizationKeys,
}));

vi.mock('./managedAutomation', () => ({
  ensureManagedTriageAutomation: state.ensureManagedTriageAutomation,
  setManagedAutomationEnabled: state.setManagedAutomationEnabled,
  syncManagedAutomation: state.syncManagedAutomation,
}));

vi.mock('../auditService', () => ({ createAuditLog: state.audit }));
vi.mock('../eventBus', () => ({ getEventBus: () => ({ publish: state.publish }) }));
// NOT mocked on purpose. Stubbing isSupportedAgentMode made the "rejects the
// DB-legal act mode" test assert the STUB's opinion — adding 'act' (the wave-4
// autonomous-execution mode) to the real SUPPORTED_AGENT_MODES would have been
// a fully green change.
vi.mock('./effectivePolicy', () => ({
  normalizeAgentPolicy: (row: Record<string, unknown>) => ({
    enabled: row.enabled,
    mode: row.mode,
    model: row.model,
    toolAllowlist: row.toolAllowlist,
    protectedResources: row.protectedResources,
    limits: row.limits,
    triggers: row.triggers,
    recipients: row.recipients,
    actAssets: row.actAssets ?? { scriptIds: [] },
    instructions: row.instructions,
    cooldownSeconds: row.cooldownSeconds,
  }),
}));

import { db } from '../../db';
import {
  ActPrerequisitesNotMetError,
  AgentKindConflictError,
  InvalidSupervisedActionKeysError,
  UnsupportedAgentModeError,
  createAgent,
  disableAgent,
  listAgents,
  updateAgent,
  withAgentRowLocked,
} from './agentService';

function auth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'u@x', name: 'U', isPlatformAdmin: false },
    token: {
      sub: 'u1', email: 'u@x', roleId: 'r', orgId: null, partnerId: 'p1',
      scope: 'partner', type: 'access', mfa: true,
    },
    partnerId: 'p1',
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: ['o1'],
    partnerOrgAccess: 'all',
    orgCondition: (column: never) => eq(column, 'o1'),
    canAccessOrg: (id) => id === 'o1',
    ...over,
  } as AuthContext;
}

const storedRow = {
  id: 'a1',
  orgId: 'o1',
  partnerId: null,
  kind: 'alert_triage',
  name: 'Alert triage',
  enabled: true,
  mode: 'shadow',
  model: 'model-1',
  toolAllowlist: ['alerts:list'],
  protectedResources: {
    services: ['security-agent'],
    paths: ['/protected'],
    registryKeys: ['HKLM\\Software\\Protected'],
    deviceTags: ['critical'],
  },
  limits: {
    maxDevicesPerRun: 10,
    maxConcurrentRuns: 2,
    maxRunsPerHour: 20,
    maxTurnsPerRun: 30,
    maxBudgetCentsPerRun: 40,
    maxBudgetCentsPerDay: 50,
    wallClockSeconds: 60,
    maxFleetPercentPerDay: 70,
  },
  triggers: {
    alertSeverities: ['critical', 'high'],
    alertRuleIds: ['rule-1'],
    siteIds: ['site-1'],
    deviceGroupIds: ['group-1'],
    deviceTags: ['server'],
    respectMaintenanceWindows: true,
  },
  recipients: { userIds: ['u1'], roleIds: ['r1'] },
  actAssets: { scriptIds: [] },
  instructions: 'Be careful',
  cooldownSeconds: 900,
  disabledAt: null,
  disabledBy: null,
  createdBy: 'u1',
  lastUpdatedBy: 'u1',
  createdAt: new Date('2026-08-22T00:00:00Z'),
  updatedAt: new Date('2026-08-22T00:00:00Z'),
};

const createInput = {
  kind: 'alert_triage',
  name: 'Alert triage',
  enabled: false,
  mode: 'off',
  model: null,
  toolAllowlist: [],
  protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
  limits: storedRow.limits,
  triggers: storedRow.triggers,
  recipients: { userIds: [], roleIds: [] },
  actAssets: { scriptIds: [] },
  instructions: null,
  cooldownSeconds: 900,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.ensureManagedTriageAutomation.mockReset();
  state.ensureManagedTriageAutomation.mockResolvedValue(undefined);
  state.setManagedAutomationEnabled.mockReset();
  state.setManagedAutomationEnabled.mockResolvedValue(undefined);
  state.syncManagedAutomation.mockReset();
  state.syncManagedAutomation.mockResolvedValue(undefined);
  state.validateRecipients.mockResolvedValue(undefined);
  state.hasResolvableAgentRecipient.mockReset();
  state.hasResolvableAgentRecipient.mockResolvedValue(true);
  state.validateAuthorizationKeys.mockReset();
  state.validateAuthorizationKeys.mockImplementation((keys: string[]) => ({ ok: keys, rejected: [] }));
  state.currentRow = null;
  state.listRows = [];
  state.returnedRow = null;
  state.insertedValues = null;
  state.updatedValues = null;
  state.selectFor = undefined;
});

describe('assertAgentWriteAllowed', () => {
  it('partner-wide row needs canManagePartnerWidePolicies', () => {
    expect(() => assertAgentWriteAllowed(auth(), { orgId: null, partnerId: 'p1' })).not.toThrow();
    expect(() => assertAgentWriteAllowed(
      auth({ partnerOrgAccess: 'selected' }),
      { orgId: null, partnerId: 'p1' },
    )).toThrow(PartnerWideWriteDeniedError);
  });

  it('partner-wide row of another partner is denied', () => {
    expect(() => assertAgentWriteAllowed(auth(), { orgId: null, partnerId: 'p2' }))
      .toThrow(AgentAccessDeniedError);
  });

  it('org row needs org access', () => {
    expect(() => assertAgentWriteAllowed(auth(), { orgId: 'o1', partnerId: null })).not.toThrow();
    expect(() => assertAgentWriteAllowed(auth(), { orgId: 'o9', partnerId: null }))
      .toThrow(AgentAccessDeniedError);
  });

  it('ai_agent principal can never write', () => {
    expect(() => assertAgentWriteAllowed(
      auth({ principal: { kind: 'ai_agent', agentId: 'a', runId: 'r' } }),
      { orgId: 'o1', partnerId: null },
    )).toThrow(AgentAccessDeniedError);
  });
});

describe('agent mutations', () => {
  it('seeds the managed automation from the inserted triage-agent row', async () => {
    const inserted = { ...storedRow, kind: 'triage', name: 'Triage Bot' };
    state.returnedRow = inserted;

    await createAgent(
      auth(),
      { orgId: 'o1', partnerId: null },
      { ...createInput, kind: 'triage', name: 'Triage Bot' } as never,
    );

    expect(state.ensureManagedTriageAutomation).toHaveBeenCalledTimes(1);
    expect(state.ensureManagedTriageAutomation).toHaveBeenCalledWith(expect.objectContaining({
      id: 'a1',
      kind: 'triage',
      name: 'Triage Bot',
      orgId: 'o1',
      partnerId: null,
      createdBy: 'u1',
    }));
  });

  it('hands the seeder the stored row\u2019s own enabled flag, not a hardcoded true', async () => {
    // createAiAgentSchema defaults enabled to false, so the seeded wiring must
    // start off with the agent. Passing the persisted row (rather than a
    // hand-built object) is what keeps the two in step.
    const inserted = { ...storedRow, kind: 'triage', name: 'Triage Bot', enabled: false };
    state.returnedRow = inserted;

    await createAgent(
      auth(),
      { orgId: 'o1', partnerId: null },
      { ...createInput, kind: 'triage', name: 'Triage Bot', enabled: false } as never,
    );

    expect(state.ensureManagedTriageAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('does not audit or publish a create whose managed automation seed fails', async () => {
    state.returnedRow = { ...storedRow, kind: 'triage' };
    state.ensureManagedTriageAutomation.mockRejectedValue(new Error('seed failed'));

    await expect(createAgent(
      auth(),
      { orgId: 'o1', partnerId: null },
      { ...createInput, kind: 'triage' } as never,
    )).rejects.toThrow('seed failed');

    expect(state.audit).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
  });

  it('creates through the write gate and records audit and event side effects', async () => {
    state.returnedRow = storedRow;

    await createAgent(auth(), { orgId: 'o1', partnerId: null }, createInput as never);

    expect(state.insertedValues).toMatchObject({ orgId: 'o1', partnerId: null, kind: 'alert_triage' });
    expect(state.validateRecipients).toHaveBeenCalledWith(
      { orgId: 'o1', partnerId: null },
      createInput.recipients,
    );
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai.agent.created', resourceType: 'ai_agent', resourceId: 'a1', result: 'success',
    }));
    expect(state.publish).toHaveBeenCalledWith(
      'ai.agent.policy_changed',
      'o1',
      expect.objectContaining({ agentId: 'a1', change: 'created' }),
      'ai-agents',
    );
  });

  it('refuses invalid recipients before anything is written', async () => {
    const { InvalidAgentRecipientsError } = await import('./recipients');
    state.validateRecipients.mockRejectedValue(
      new InvalidAgentRecipientsError(['u-bad'], []),
    );
    state.returnedRow = storedRow;

    await expect(createAgent(auth(), { orgId: 'o1', partnerId: null }, createInput as never))
      .rejects.toBeInstanceOf(InvalidAgentRecipientsError);
    expect(state.insertedValues).toBeNull();
    expect(state.audit).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();

    // Same contract on update: a recipients patch is validated (as the merged
    // object) before the UPDATE is issued.
    state.currentRow = storedRow;
    await expect(updateAgent(auth(), 'a1', { recipients: { userIds: ['u-bad'] } } as never))
      .rejects.toBeInstanceOf(InvalidAgentRecipientsError);
    expect(state.updatedValues).toBeNull();
  });

  it('refuses a second active agent of the same kind before the insert runs', async () => {
    // The partial unique indexes are the real boundary, but the whole request
    // runs in one transaction — a raised 23505 poisons it and the COMMIT 500s,
    // so the duplicate has to be caught before the INSERT is issued.
    state.currentRow = { id: 'existing' };
    state.returnedRow = storedRow;

    await expect(createAgent(auth(), { orgId: 'o1', partnerId: null }, createInput as never))
      .rejects.toBeInstanceOf(AgentKindConflictError);
    expect(state.insertedValues).toBeNull();
    expect(state.audit).not.toHaveBeenCalled();

    // Walk the bound predicate. Asserting only the control flow left this
    // vacuous with respect to the QUERY: it passed with isNull(disabledAt)
    // dropped, eq(kind) dropped, or the owner branch swapped — the exact
    // vacuous-where-clause shape that has bitten this repo before.
    const bound = JSON.stringify(state.selectWhere);
    expect(bound).toContain('alert_triage');
    expect(bound).toContain('aiAgents.disabledAt');
    expect(bound).toContain('o1');
  });

  it('checks the PARTNER slot, not an org slot, for a partner-wide create', async () => {
    state.currentRow = null;
    state.returnedRow = storedRow;

    await createAgent(auth(), { orgId: null, partnerId: 'p1' }, createInput as never);

    const bound = JSON.stringify(state.selectWhere);
    expect(bound).toContain('p1');
    expect(bound).toContain('aiAgents.orgId');
  });

  it('denies a partner-wide create without full partner authority', async () => {
    await expect(createAgent(
      auth({ partnerOrgAccess: 'selected' }),
      { orgId: null, partnerId: 'p1' },
      createInput as never,
    )).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(state.insertedValues).toBeNull();
  });

  it('never lets an org-scoped caller create, update, or disable a partner-wide row', async () => {
    const orgAuth = auth({ scope: 'organization', orgId: 'o1', partnerOrgAccess: 'selected' });
    const partnerRow = { ...storedRow, orgId: null, partnerId: 'p1' };
    state.currentRow = partnerRow;
    state.returnedRow = partnerRow;

    await expect(createAgent(
      orgAuth,
      { orgId: null, partnerId: 'p1' },
      createInput as never,
    )).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    await expect(updateAgent(orgAuth, 'a1', { name: 'No' }))
      .rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    await expect(disableAgent(orgAuth, 'a1'))
      .rejects.toBeInstanceOf(PartnerWideWriteDeniedError);

    expect(state.insertedValues).toBeNull();
    expect(state.updatedValues).toBeNull();
    expect(state.audit).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
  });

  it('deep-merges every nested patch object so stored siblings survive', async () => {
    state.currentRow = storedRow;
    state.returnedRow = storedRow;

    await updateAgent(auth(), 'a1', {
      protectedResources: { paths: ['/new-path'] },
      limits: { maxDevicesPerRun: 7 },
      triggers: { respectMaintenanceWindows: false },
      recipients: { userIds: ['u2'] },
    } as never);

    expect(state.updatedValues).toMatchObject({
      protectedResources: {
        services: ['security-agent'],
        paths: ['/new-path'],
        registryKeys: ['HKLM\\Software\\Protected'],
        deviceTags: ['critical'],
      },
      limits: { ...storedRow.limits, maxDevicesPerRun: 7 },
      triggers: { ...storedRow.triggers, respectMaintenanceWindows: false },
      recipients: { ...storedRow.recipients, userIds: ['u2'] },
    });
    // The validated object IS the merged object that gets stored — validating
    // only the patch would let a stale-but-stored sibling id survive unchecked.
    expect(state.validateRecipients).toHaveBeenCalledWith(
      { orgId: 'o1', partnerId: null },
      { ...storedRow.recipients, userIds: ['u2'] },
    );
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai.agent.updated', resourceId: 'a1', result: 'success',
    }));
    expect(state.publish).toHaveBeenCalledWith(
      'ai.agent.policy_changed',
      'o1',
      expect.objectContaining({ agentId: 'a1', change: 'updated' }),
      'ai-agents',
    );
  });

  it('does not allow owner fields to re-own an existing row', async () => {
    state.currentRow = storedRow;
    state.returnedRow = storedRow;

    await updateAgent(auth(), 'a1', {
      name: 'Renamed', ownerScope: 'partner', orgId: null, partnerId: 'p1',
    } as never);

    expect(state.updatedValues).not.toHaveProperty('ownerScope');
    expect(state.updatedValues).not.toHaveProperty('orgId');
    expect(state.updatedValues).not.toHaveProperty('partnerId');
    // No recipients in the patch → no membership validation round-trip.
    expect(state.validateRecipients).not.toHaveBeenCalled();
  });

  it('rejects an unsupported mode value even though act now ships (Task 6, #3826)', async () => {
    state.currentRow = storedRow;

    await expect(updateAgent(auth(), 'a1', { mode: 'bogus' } as never))
      .rejects.toBeInstanceOf(UnsupportedAgentModeError);
    expect(state.updatedValues).toBeNull();
  });

  describe('act-mode activation prerequisites (Task 6, #3826)', () => {
    it('accepts an update to act mode when the merged row already has a resolvable recipient and an act-eligible surface', async () => {
      const actReady = {
        ...storedRow,
        toolAllowlist: ['run_script'],
        actAssets: { scriptIds: ['s-1'] },
      };
      state.currentRow = actReady;
      state.returnedRow = { ...actReady, mode: 'act' };

      await updateAgent(auth(), 'a1', { mode: 'act' } as never);

      expect(state.updatedValues).toMatchObject({ mode: 'act' });
      expect(state.hasResolvableAgentRecipient).toHaveBeenCalledWith(
        { orgId: 'o1', partnerId: null },
        actReady.recipients,
      );
    });

    it('refuses an update to act mode with no act-eligible allowlisted surface', async () => {
      state.currentRow = { ...storedRow, toolAllowlist: ['alerts:list'] };

      const err = await updateAgent(auth(), 'a1', { mode: 'act' } as never).catch((e) => e);
      expect(err).toBeInstanceOf(ActPrerequisitesNotMetError);
      expect((err as ActPrerequisitesNotMetError).missing).toEqual(['act_eligible_tool']);
      expect(state.updatedValues).toBeNull();
    });

    it("run_script alone does not count unless actAssets has at least one authorized script", async () => {
      state.currentRow = { ...storedRow, toolAllowlist: ['run_script'], actAssets: { scriptIds: [] } };

      const err = await updateAgent(auth(), 'a1', { mode: 'act' } as never).catch((e) => e);
      expect(err).toBeInstanceOf(ActPrerequisitesNotMetError);
      expect((err as ActPrerequisitesNotMetError).missing).toEqual(['act_eligible_tool']);
    });

    it('accepts a scoped `tool:action` allowlist entry (manage_services:restart) — the guardrail honours it too, so the tightest act config must not be refused', async () => {
      const actReady = {
        ...storedRow,
        toolAllowlist: ['manage_services:restart'],
      };
      state.currentRow = actReady;
      state.returnedRow = { ...actReady, mode: 'act' };

      await updateAgent(auth(), 'a1', { mode: 'act' } as never);

      expect(state.updatedValues).toMatchObject({ mode: 'act' });
    });

    it("a non-null supervisedActionKeys set alone satisfies act_eligible_tool — a policy-decide-only agent (no run_script/manage_services/disk_cleanup/execute_playbook manifest surface) must still be able to enter act mode (Task 5, #3827)", async () => {
      // security_scan is POLICY_DECIDABLE_TIER3-eligible but is NOT in
      // ACT_MANIFEST/ACT_ELIGIBLE_TOOL_NAMES (that set is the wave-4
      // rule-equivalent-operation manifest, a different lane) — before this
      // fix, an agent configured ONLY for policy-decide on security_scan/
      // manage_startup_items/manage_scheduled_tasks (no wave-4 act-lane
      // surface at all) could never activate act mode: hasActEligibleSurface
      // would see an empty intersection with ACT_ELIGIBLE_TOOL_NAMES and
      // reject with act_eligible_tool even though supervisedActionKeys was
      // correctly configured.
      const actReady = {
        ...storedRow,
        toolAllowlist: ['security_scan'],
        actAssets: { scriptIds: [], supervisedActionKeys: ['security_scan:quarantine'] },
      };
      state.currentRow = actReady;
      state.returnedRow = { ...actReady, mode: 'act' };

      await updateAgent(auth(), 'a1', { mode: 'act' } as never);

      expect(state.updatedValues).toMatchObject({ mode: 'act' });
    });

    it('an empty supervisedActionKeys does NOT satisfy act_eligible_tool on its own — still requires a real wave-4 manifest surface', async () => {
      state.currentRow = {
        ...storedRow,
        toolAllowlist: ['security_scan'],
        actAssets: { scriptIds: [], supervisedActionKeys: [] },
      };

      const err = await updateAgent(auth(), 'a1', { mode: 'act' } as never).catch((e) => e);
      expect(err).toBeInstanceOf(ActPrerequisitesNotMetError);
      expect((err as ActPrerequisitesNotMetError).missing).toEqual(['act_eligible_tool']);
      expect(state.updatedValues).toBeNull();
    });

    it('refuses an update to act mode with no resolvable recipient', async () => {
      state.hasResolvableAgentRecipient.mockResolvedValue(false);
      state.currentRow = { ...storedRow, toolAllowlist: ['manage_services'] };

      const err = await updateAgent(auth(), 'a1', { mode: 'act' } as never).catch((e) => e);
      expect(err).toBeInstanceOf(ActPrerequisitesNotMetError);
      expect((err as ActPrerequisitesNotMetError).missing).toEqual(['recipient']);
      expect(state.updatedValues).toBeNull();
    });

    it('reports BOTH missing prerequisites together, not just the first', async () => {
      state.hasResolvableAgentRecipient.mockResolvedValue(false);
      state.currentRow = { ...storedRow, toolAllowlist: ['alerts:list'] };

      const err = await updateAgent(auth(), 'a1', { mode: 'act' } as never).catch((e) => e);
      expect((err as ActPrerequisitesNotMetError).missing).toEqual(['recipient', 'act_eligible_tool']);
    });

    it('checks prerequisites against the MERGED row, not the raw patch — an allowlist-only patch on an already act-mode agent is refused when it narrows away the surface', async () => {
      state.currentRow = { ...storedRow, mode: 'act', toolAllowlist: ['run_script'], actAssets: { scriptIds: ['s-1'] } };

      const err = await updateAgent(auth(), 'a1', { toolAllowlist: ['alerts:list'] } as never).catch((e) => e);
      expect(err).toBeInstanceOf(ActPrerequisitesNotMetError);
      expect(state.updatedValues).toBeNull();
    });

    it('does not check prerequisites for a write that does not resolve to act mode', async () => {
      state.hasResolvableAgentRecipient.mockResolvedValue(false);
      state.currentRow = { ...storedRow, mode: 'shadow', toolAllowlist: ['alerts:list'] };
      state.returnedRow = { ...storedRow, mode: 'shadow', instructions: 'Updated' };

      await updateAgent(auth(), 'a1', { instructions: 'Updated' } as never);

      expect(state.hasResolvableAgentRecipient).not.toHaveBeenCalled();
      expect(state.updatedValues).toMatchObject({ instructions: 'Updated' });
    });

    it('gates createAgent the same way, before the insert runs', async () => {
      state.hasResolvableAgentRecipient.mockResolvedValue(true);
      state.returnedRow = storedRow;

      const err = await createAgent(
        auth(),
        { orgId: 'o1', partnerId: null },
        { ...createInput, mode: 'act', toolAllowlist: [] } as never,
      ).catch((e) => e);

      expect(err).toBeInstanceOf(ActPrerequisitesNotMetError);
      expect((err as ActPrerequisitesNotMetError).missing).toEqual(['act_eligible_tool']);
      expect(state.insertedValues).toBeNull();
    });

    it('a create with a satisfied surface and recipient succeeds', async () => {
      state.hasResolvableAgentRecipient.mockResolvedValue(true);
      state.returnedRow = { ...storedRow, mode: 'act', toolAllowlist: ['manage_services'] };

      await createAgent(
        auth(),
        { orgId: 'o1', partnerId: null },
        { ...createInput, mode: 'act', toolAllowlist: ['manage_services'], recipients: { userIds: ['u1'], roleIds: [] } } as never,
      );

      expect(state.insertedValues).toMatchObject({ mode: 'act' });
    });
  });

  describe('supervisedActionKeys write-time validation (wave 5 Part B, #3827)', () => {
    it('refuses a create whose supervisedActionKeys is rejected by validateAuthorizationKeys, before the insert runs', async () => {
      state.returnedRow = storedRow;
      state.validateAuthorizationKeys.mockReturnValue({
        ok: [],
        rejected: [{ key: 'bogus_key', reason: 'not registered in POLICY_DECIDABLE_TIER3' }],
      });

      const err = await createAgent(
        auth(),
        { orgId: 'o1', partnerId: null },
        { ...createInput, actAssets: { scriptIds: [], supervisedActionKeys: ['bogus_key'] } } as never,
      ).catch((e) => e);

      expect(err).toBeInstanceOf(InvalidSupervisedActionKeysError);
      expect((err as InvalidSupervisedActionKeysError).rejected).toEqual([
        { key: 'bogus_key', reason: 'not registered in POLICY_DECIDABLE_TIER3' },
      ]);
      expect(state.validateAuthorizationKeys).toHaveBeenCalledWith(['bogus_key']);
      expect(state.insertedValues).toBeNull();
      expect(state.audit).not.toHaveBeenCalled();
    });

    it('accepts a create whose supervisedActionKeys validateAuthorizationKeys accepts', async () => {
      state.returnedRow = { ...storedRow, actAssets: { scriptIds: [], supervisedActionKeys: ['manage_services:restart'] } };

      await createAgent(
        auth(),
        { orgId: 'o1', partnerId: null },
        { ...createInput, actAssets: { scriptIds: [], supervisedActionKeys: ['manage_services:restart'] } } as never,
      );

      expect(state.validateAuthorizationKeys).toHaveBeenCalledWith(['manage_services:restart']);
      expect(state.insertedValues).toMatchObject({
        actAssets: { scriptIds: [], supervisedActionKeys: ['manage_services:restart'] },
      });
    });

    it('an absent or empty supervisedActionKeys is a no-op — validateAuthorizationKeys is never called', async () => {
      state.returnedRow = storedRow;

      await createAgent(auth(), { orgId: 'o1', partnerId: null }, createInput as never);

      expect(state.validateAuthorizationKeys).not.toHaveBeenCalled();
      expect(state.insertedValues).not.toBeNull();
    });

    it('refuses an update whose supervisedActionKeys patch is rejected, before the update runs', async () => {
      state.currentRow = storedRow;
      state.validateAuthorizationKeys.mockReturnValue({
        ok: [],
        rejected: [{ key: 'bogus_key', reason: 'not registered in POLICY_DECIDABLE_TIER3' }],
      });

      const err = await updateAgent(auth(), 'a1', {
        actAssets: { supervisedActionKeys: ['bogus_key'] },
      } as never).catch((e) => e);

      expect(err).toBeInstanceOf(InvalidSupervisedActionKeysError);
      expect(state.updatedValues).toBeNull();
    });

    it('accepts an update whose supervisedActionKeys patch validateAuthorizationKeys accepts, merged onto stored actAssets', async () => {
      state.currentRow = { ...storedRow, actAssets: { scriptIds: ['s-1'] } };
      state.returnedRow = storedRow;

      await updateAgent(auth(), 'a1', {
        actAssets: { supervisedActionKeys: ['security_scan:quarantine'] },
      } as never);

      expect(state.validateAuthorizationKeys).toHaveBeenCalledWith(['security_scan:quarantine']);
      expect(state.updatedValues).toMatchObject({
        actAssets: { scriptIds: ['s-1'], supervisedActionKeys: ['security_scan:quarantine'] },
      });
    });

    it('does NOT re-validate a stored supervisedActionKeys value on an update that never touches actAssets — stored-but-registry-dropped keys are tolerated-but-inert, not write-blocking', async () => {
      state.currentRow = {
        ...storedRow,
        actAssets: { scriptIds: [], supervisedActionKeys: ['now_dropped_from_registry'] },
      };
      state.returnedRow = { ...storedRow, instructions: 'Updated' };

      await updateAgent(auth(), 'a1', { instructions: 'Updated' } as never);

      expect(state.validateAuthorizationKeys).not.toHaveBeenCalled();
      expect(state.updatedValues).toMatchObject({ instructions: 'Updated' });
    });

    it('an update patch that sets actAssets but omits supervisedActionKeys does not re-validate the untouched stored value', async () => {
      state.currentRow = {
        ...storedRow,
        actAssets: { scriptIds: [], supervisedActionKeys: ['now_dropped_from_registry'] },
      };
      state.returnedRow = storedRow;

      await updateAgent(auth(), 'a1', { actAssets: { scriptIds: ['s-2'] } } as never);

      expect(state.validateAuthorizationKeys).not.toHaveBeenCalled();
      expect(state.updatedValues).not.toBeNull();
    });
  });

  it('soft-disables and records audit and event side effects', async () => {
    state.currentRow = storedRow;
    state.returnedRow = { ...storedRow, enabled: false, disabledAt: new Date() };

    await disableAgent(auth(), 'a1');

    expect(state.updatedValues).toMatchObject({ enabled: false, disabledBy: 'u1' });
    expect(state.updatedValues?.disabledAt).toBeInstanceOf(Date);
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai.agent.disabled', resourceId: 'a1', result: 'success',
    }));
    expect(state.publish).toHaveBeenCalledWith(
      'ai.agent.policy_changed',
      'o1',
      expect.objectContaining({ agentId: 'a1', change: 'disabled' }),
      'ai-agents',
    );
    expect(state.setManagedAutomationEnabled).toHaveBeenCalledWith('a1', false);
  });

  it('syncs a renamed agent to its managed automation', async () => {
    state.currentRow = { ...storedRow, kind: 'triage' };
    state.returnedRow = { ...storedRow, kind: 'triage', name: 'Renamed' };

    await updateAgent(auth(), 'a1', { name: 'Renamed' });

    expect(state.syncManagedAutomation).toHaveBeenCalledWith('a1', { name: 'Renamed' });
  });

  it('re-enables the managed automation when its agent is enabled', async () => {
    state.currentRow = { ...storedRow, kind: 'triage', enabled: false };
    state.returnedRow = { ...storedRow, kind: 'triage', enabled: true };

    await updateAgent(auth(), 'a1', { enabled: true });

    expect(state.syncManagedAutomation).toHaveBeenCalledWith('a1', { enabled: true });
  });

  it('does not sync the managed automation when name and enabled are unchanged', async () => {
    state.currentRow = { ...storedRow, kind: 'triage' };
    state.returnedRow = { ...storedRow, kind: 'triage', instructions: 'Updated guidance' };

    await updateAgent(auth(), 'a1', { instructions: 'Updated guidance' });

    expect(state.syncManagedAutomation).not.toHaveBeenCalled();
  });

  it('publishes partner-wide mutations instead of silently skipping them', async () => {
    state.returnedRow = { ...storedRow, orgId: null, partnerId: 'p1' };

    await createAgent(auth(), { orgId: null, partnerId: 'p1' }, createInput as never);

    expect(state.publish).toHaveBeenCalledWith(
      'ai.agent.policy_changed',
      'p1',
      expect.objectContaining({ agentId: 'a1', change: 'created', ownerScope: 'partner' }),
      'ai-agents',
    );
  });
});

// Task 8 (#4192): a read-modify-write of `actAssets` (the jsonb A2's
// promote/demote executors will also patch) without a row lock loses a
// concurrent key append. `withAgentRowLocked` is the one place every writer
// of that column is meant to route through — updateAgent here, promote/demote
// in a later PR.
describe('withAgentRowLocked', () => {
  it('locks one row FOR UPDATE, bound by the same accessible-agent predicate as getAgent', async () => {
    state.currentRow = storedRow;

    const seen = await withAgentRowLocked(auth(), 'a1', async (row) => row);

    expect(seen).toBe(storedRow);
    expect(state.selectFor).toBe('update');
    // Walk the bound predicate the same way the create-conflict tests do
    // above — asserting only that a row came back would pass even with the
    // org/id predicate silently dropped.
    const bound = JSON.stringify(state.selectWhere);
    expect(bound).toContain('aiAgents.id');
    expect(bound).toContain('a1');
    expect(bound).toContain('aiAgents.orgId');
    expect(bound).toContain('o1');
  });

  it('throws AgentAccessDeniedError instead of running fn when the predicate excludes the row', async () => {
    state.currentRow = null;
    const fn = vi.fn(async (row: unknown) => row);

    await expect(withAgentRowLocked(auth(), 'missing', fn)).rejects.toBeInstanceOf(AgentAccessDeniedError);
    expect(fn).not.toHaveBeenCalled();
  });

  // Fix round 1/5 (Critical): the system-caller (auth: null) branch used to
  // drop the tenancy predicate to `id` alone. It must now bind `id + org_id`
  // from opts, the same way the auth branch binds `id + accessibleAgentCondition`.
  it('system caller (auth: null) binds id + org_id from opts, not id alone', async () => {
    state.currentRow = storedRow; // storedRow.orgId === 'o1'

    const seen = await withAgentRowLocked(null, 'a1', async (row) => row, { orgId: 'o1' });

    expect(seen).toBe(storedRow);
    expect(state.selectFor).toBe('update');
    const bound = JSON.stringify(state.selectWhere);
    expect(bound).toContain('aiAgents.id');
    expect(bound).toContain('a1');
    expect(bound).toContain('aiAgents.orgId');
    expect(bound).toContain('o1');
  });

  it('system caller with a mismatched orgId throws AgentAccessDeniedError rather than returning the row', async () => {
    // The mock's `where` returns state.currentRow unconditionally (there is
    // no real SQL engine here), so a predicate miss is simulated the same
    // way as the auth-bound "excludes the row" test above. The assertion on
    // state.selectWhere below is what actually proves the mismatched orgId
    // was bound into the predicate rather than silently ignored.
    state.currentRow = null;
    const fn = vi.fn(async (row: unknown) => row);

    await expect(
      withAgentRowLocked(null, 'a1', fn, { orgId: 'wrong-org' }),
    ).rejects.toBeInstanceOf(AgentAccessDeniedError);
    expect(fn).not.toHaveBeenCalled();
    const bound = JSON.stringify(state.selectWhere);
    expect(bound).toContain('aiAgents.orgId');
    expect(bound).toContain('wrong-org');
  });

  it('system caller without opts.orgId throws AgentInvariantError before issuing any SELECT', async () => {
    state.currentRow = storedRow;
    const fn = vi.fn(async (row: unknown) => row);

    // @ts-expect-error — exercising the runtime guard behind the overload that
    // makes this uncallable at compile time.
    await expect(withAgentRowLocked(null, 'a1', fn)).rejects.toThrow(/requires opts\.orgId/);
    expect(fn).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('updateAgent row lock', () => {
  it('acquires the lock before validating recipients or issuing the UPDATE', async () => {
    state.currentRow = storedRow;
    state.returnedRow = storedRow;

    await updateAgent(auth(), 'a1', { recipients: { userIds: ['u1'], roleIds: [] } } as never);

    const selectOrder = vi.mocked(db.select).mock.invocationCallOrder[0] as number;
    const validateOrder = state.validateRecipients.mock.invocationCallOrder[0] as number;
    const updateOrder = vi.mocked(db.update).mock.invocationCallOrder[0] as number;
    expect(selectOrder).toBeLessThan(validateOrder);
    expect(selectOrder).toBeLessThan(updateOrder);
    // Fix round 1/5 (Important): call-order alone is satisfied by the
    // pre-refactor select-then-validate-then-update code too (no FOR UPDATE
    // involved) — it does not prove updateAgent is actually routing through
    // withAgentRowLocked's lock. This is the one assertion that does: the
    // mock's `.for()` chain only gets invoked by withAgentRowLocked's own
    // `.limit(1).for('update')` call, never by a plain `getAgent`-style read.
    expect(state.selectFor).toBe('update');
  });

  it('a disabled row seen inside the lock still throws AgentAccessDeniedError', async () => {
    state.currentRow = { ...storedRow, disabledAt: new Date('2026-08-01T00:00:00Z') };

    await expect(updateAgent(auth(), 'a1', { name: 'Renamed' })).rejects.toBeInstanceOf(AgentAccessDeniedError);
    expect(state.updatedValues).toBeNull();
    expect(state.validateRecipients).not.toHaveBeenCalled();
  });
});

describe('listAgents', () => {
  it('binds a tenant predicate — RLS is not the only defence', async () => {
    // Previously this asserted back the rows the mock supplied, which is true
    // of any implementation including one with no WHERE at all. A contextless
    // caller runs as scope='system', so an unscoped read here returns every
    // partner's agents.
    state.listRows = [storedRow];
    state.selectWhere = undefined;
    await expect(listAgents(auth())).resolves.toEqual([storedRow]);
    expect(state.selectWhere, 'listAgents issued an unscoped read').toBeDefined();

    // A partner-scoped caller also reaches partner-wide rows (org_id IS NULL).
    const partnerSql = JSON.stringify(state.selectWhere ?? {});
    expect(partnerSql).toContain('p1');

    // An org-scoped caller must NOT: an org token carries a partnerId but never
    // passes breeze_has_partner_access.
    state.selectWhere = undefined;
    await listAgents(auth({ scope: 'organization', orgId: 'o1', partnerOrgAccess: null }));
    expect(JSON.stringify(state.selectWhere ?? {})).not.toContain('p1');
  });
});
