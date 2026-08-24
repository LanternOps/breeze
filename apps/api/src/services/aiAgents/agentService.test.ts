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
  audit: vi.fn(),
  publish: vi.fn(),
  validateRecipients: vi.fn(),
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
          return ({
          limit: vi.fn(async () => state.currentRow ? [state.currentRow] : []),
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
  return { InvalidAgentRecipientsError, validateAgentRecipients: state.validateRecipients };
});

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
    instructions: row.instructions,
    cooldownSeconds: row.cooldownSeconds,
  }),
}));

import {
  AgentKindConflictError,
  UnsupportedAgentModeError,
  createAgent,
  disableAgent,
  listAgents,
  updateAgent,
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
  instructions: null,
  cooldownSeconds: 900,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.validateRecipients.mockResolvedValue(undefined);
  state.currentRow = null;
  state.listRows = [];
  state.returnedRow = null;
  state.insertedValues = null;
  state.updatedValues = null;
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

  it('rejects the DB-legal act mode as unsupported', async () => {
    state.currentRow = storedRow;

    await expect(updateAgent(auth(), 'a1', { mode: 'act' } as never))
      .rejects.toBeInstanceOf(UnsupportedAgentModeError);
    expect(state.updatedValues).toBeNull();
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
