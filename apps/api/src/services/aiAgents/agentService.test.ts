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
  audit: vi.fn(),
  publish: vi.fn(),
}));

const schema = vi.hoisted(() => ({
  aiAgents: {
    id: 'aiAgents.id',
    disabledAt: 'aiAgents.disabledAt',
    createdAt: 'aiAgents.createdAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ and: conditions }),
  desc: (column: unknown) => ({ desc: column }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
  isNull: (column: unknown) => ({ isNull: column }),
}));

vi.mock('../../db/schema', () => ({ aiAgents: schema.aiAgents }));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => state.currentRow ? [state.currentRow] : []),
          orderBy: vi.fn(async () => state.listRows),
        })),
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

vi.mock('../auditService', () => ({ createAuditLog: state.audit }));
vi.mock('../eventBus', () => ({ getEventBus: () => ({ publish: state.publish }) }));
vi.mock('./constants', () => ({
  isSupportedAgentMode: (mode: string) => mode === 'off' || mode === 'shadow',
}));
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
    orgCondition: () => undefined,
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
  it('returns rows from the RLS-scoped query', async () => {
    state.listRows = [storedRow];
    await expect(listAgents(auth())).resolves.toEqual([storedRow]);
  });
});
