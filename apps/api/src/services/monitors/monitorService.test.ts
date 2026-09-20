import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every assertion below fails BEFORE any DB work (ownership and shape checks
// run first, deliberately), so the db module only needs to exist.
// importOriginal spread: the module also exports the DB-context helpers
// (runOutsideDbContext, withDbAccessContext) that commandQueue captures at
// import time through automationRuntime -> scriptDispatch.
//
// Hoisted so update/delete tests below can point `select` at a specific
// "existing row" per test (getMonitorDefinition reads through it) while
// `transaction` stays a trap: every guard-clause path exercised here throws
// before a real write would happen.
const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(async () => {
      throw new Error('transaction should not be reached in these cases');
    }),
  },
}));

vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  db: dbMock,
}));

import {
  createMonitorDefinition,
  updateMonitorDefinition,
  deleteMonitorDefinition,
  MonitorOwnershipError,
  MonitorValidationError,
} from './monitorService';
import * as monitorCompiler from './monitorCompiler';
import type { AuthContext } from '../../middleware/auth';
import type { CreateMonitorDefinitionInput, UpdateMonitorDefinitionInput } from '@breeze/shared';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const OTHER_PARTNER = '44444444-4444-4444-8444-444444444444';

/**
 * Hard reset, not just `vi.clearAllMocks()` (which only clears call history —
 * it does NOT remove a `mockReturnValue`/`mockImplementation` set by a
 * previous test). Without this, a test that forgets to set up `select` (or a
 * future test that reorders/interleaves with `mockExisting` calls below)
 * would silently observe the PREVIOUS test's stale existing-row / transaction
 * stub instead of failing loudly — exactly the "shared mock state leaking
 * between cases" shape. `mockReset()` drops the implementation back to
 * "returns undefined", so a test that depends on `select` without calling
 * `mockExisting` fails fast (a TypeError on destructuring) rather than
 * quietly reusing someone else's row.
 */
beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.update.mockReset();
  dbMock.delete.mockReset();
  dbMock.transaction.mockReset();
  dbMock.transaction.mockImplementation(async () => {
    throw new Error('transaction should not be reached in these cases');
  });
});

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: 'user',
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: null,
    partnerId: PARTNER,
    orgId: ORG,
    scope: 'organization',
    accessibleOrgIds: [ORG],
    partnerOrgAccess: null,
    orgCondition: () => undefined,
    canAccessOrg: (orgId: string) => orgId === ORG,
    ...overrides,
  } as unknown as AuthContext;
}

function input(overrides: Partial<CreateMonitorDefinitionInput> = {}): CreateMonitorDefinitionInput {
  return {
    ownerScope: 'organization',
    name: 'CPU high',
    kind: 'cpu',
    enabled: true,
    condition: { operator: 'gt', value: 90 },
    severity: 'high',
    cooldownMinutes: 5,
    autoResolve: false,
    responses: [],
    deliveryMode: 'inherit',
    deliveryChannelIds: [],
    recurrenceActions: [],
    pauseResponsesOnEscalation: true,
    ...overrides,
  } as CreateMonitorDefinitionInput;
}

describe('monitorService ownership + validation (#5289)', () => {
  it('an org-scoped caller cannot create a partner-wide monitor', async () => {
    await expect(
      createMonitorDefinition(input({ ownerScope: 'partner' }), auth()),
    ).rejects.toBeInstanceOf(MonitorOwnershipError);
  });

  it('a partner-scoped caller without full org access cannot create a partner-wide monitor', async () => {
    await expect(
      createMonitorDefinition(
        input({ ownerScope: 'partner' }),
        auth({ scope: 'partner', partnerOrgAccess: 'selected' }),
      ),
    ).rejects.toBeInstanceOf(MonitorOwnershipError);
  });

  it('a caller cannot create a monitor in an org it cannot access', async () => {
    await expect(
      createMonitorDefinition(
        input({ orgId: '33333333-3333-4333-8333-333333333333' }),
        auth(),
      ),
    ).rejects.toBeInstanceOf(MonitorOwnershipError);
  });

  it('rejects a condition that does not match the kind', async () => {
    await expect(
      createMonitorDefinition(input({ condition: { withinDays: 14 } }), auth()),
    ).rejects.toBeInstanceOf(MonitorValidationError);
  });

  it('rejects an out-of-range condition value', async () => {
    await expect(
      createMonitorDefinition(input({ condition: { operator: 'gt', value: 900 } }), auth()),
    ).rejects.toBeInstanceOf(MonitorValidationError);
  });

  it('rejects an ai_triage response with no ai agent', async () => {
    await expect(
      createMonitorDefinition(
        input({ responses: [{ type: 'ai_triage' }] as CreateMonitorDefinitionInput['responses'] }),
        auth(),
      ),
    ).rejects.toBeInstanceOf(MonitorValidationError);
  });
});

const ESCALATION_POLICY = '55555555-5555-4555-8555-555555555555';

function mockSelectQueue(rows: Array<Record<string, unknown> | undefined>) {
  const fn = dbMock.select as unknown as { mockReturnValueOnce: (v: unknown) => void };
  for (const row of rows) {
    fn.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(row ? [row] : []),
        }),
      }),
    });
  }
}

describe('createMonitorDefinition escalation-policy owner compatibility (#5676)', () => {
  it('skips the compat lookup and reaches compile when there is no escalation policy', async () => {
    // beforeEach leaves `transaction` throwing, so a reject here proves the
    // guard clauses above it (ownership, shape) all passed through cleanly
    // and execution reached the write path without a DB read for the policy.
    await expect(
      createMonitorDefinition(input({ escalationPolicyId: null }), auth()),
    ).rejects.toThrow('transaction should not be reached in these cases');
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('rejects an org-scoped monitor referencing another org\'s escalation policy', async () => {
    mockSelectQueue([{ orgId: '33333333-3333-4333-8333-333333333333', partnerId: null }]);

    await expect(
      createMonitorDefinition(input({ escalationPolicyId: ESCALATION_POLICY }), auth()),
    ).rejects.toBeInstanceOf(MonitorValidationError);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it('allows an org-scoped monitor referencing its own org\'s escalation policy', async () => {
    mockSelectQueue([{ orgId: ORG, partnerId: null }]);
    (dbMock.transaction as unknown as { mockImplementation: (fn: () => Promise<string>) => void }).mockImplementation(async () => 'ok');

    await expect(
      createMonitorDefinition(input({ escalationPolicyId: ESCALATION_POLICY }), auth()),
    ).resolves.toBe('ok');
  });

  it("allows an org-scoped monitor referencing its own partner's partner-wide escalation policy", async () => {
    mockSelectQueue([
      { orgId: null, partnerId: PARTNER },
      { partnerId: PARTNER },
    ]);
    (dbMock.transaction as unknown as { mockImplementation: (fn: () => Promise<string>) => void }).mockImplementation(async () => 'ok');

    await expect(
      createMonitorDefinition(input({ escalationPolicyId: ESCALATION_POLICY }), auth()),
    ).resolves.toBe('ok');
  });

  it("rejects an org-scoped monitor referencing another partner's partner-wide escalation policy", async () => {
    mockSelectQueue([
      { orgId: null, partnerId: OTHER_PARTNER },
      { partnerId: PARTNER },
    ]);

    await expect(
      createMonitorDefinition(input({ escalationPolicyId: ESCALATION_POLICY }), auth()),
    ).rejects.toBeInstanceOf(MonitorValidationError);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it('rejects a partner-wide monitor referencing an org-owned escalation policy', async () => {
    mockSelectQueue([{ orgId: ORG, partnerId: null }]);

    await expect(
      createMonitorDefinition(
        input({ ownerScope: 'partner', escalationPolicyId: ESCALATION_POLICY }),
        auth({ scope: 'partner', partnerOrgAccess: 'all' }),
      ),
    ).rejects.toBeInstanceOf(MonitorValidationError);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("rejects a partner-wide monitor referencing another partner's partner-wide escalation policy", async () => {
    mockSelectQueue([{ orgId: null, partnerId: OTHER_PARTNER }]);

    await expect(
      createMonitorDefinition(
        input({ ownerScope: 'partner', escalationPolicyId: ESCALATION_POLICY }),
        auth({ scope: 'partner', partnerOrgAccess: 'all' }),
      ),
    ).rejects.toBeInstanceOf(MonitorValidationError);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it('allows a partner-wide monitor referencing its own partner-wide escalation policy', async () => {
    mockSelectQueue([{ orgId: null, partnerId: PARTNER }]);
    (dbMock.transaction as unknown as { mockImplementation: (fn: () => Promise<string>) => void }).mockImplementation(async () => 'ok');

    await expect(
      createMonitorDefinition(
        input({ ownerScope: 'partner', escalationPolicyId: ESCALATION_POLICY }),
        auth({ scope: 'partner', partnerOrgAccess: 'all' }),
      ),
    ).resolves.toBe('ok');
  });

  it('rejects a monitor referencing a nonexistent escalation policy', async () => {
    mockSelectQueue([undefined]);

    await expect(
      createMonitorDefinition(input({ escalationPolicyId: ESCALATION_POLICY }), auth()),
    ).rejects.toBeInstanceOf(MonitorValidationError);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });
});

/**
 * `existingRow` is a full row `getMonitorDefinition` (called first by both
 * update and delete) can return. `mockExisting` points the mocked
 * `db.select().from().where().limit()` chain at it — the mock ignores the
 * actual WHERE condition, so it stands in for any caller's read regardless of
 * the dual-axis visibility branch actually taken.
 */
function existingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'monitor-1',
    orgId: ORG,
    partnerId: null,
    name: 'CPU high',
    description: null,
    kind: 'cpu',
    enabled: true,
    condition: { operator: 'gt', value: 90 },
    severity: 'high',
    cooldownMinutes: 5,
    autoResolve: false,
    autoResolveConditions: null,
    responses: [],
    deliveryMode: 'inherit',
    deliveryChannelIds: [],
    escalationPolicyId: null,
    recurrenceThreshold: null,
    recurrenceWindowHours: null,
    recurrenceActions: [],
    pauseResponsesOnEscalation: true,
    aiAgentId: null,
    compiledAlertTemplateId: null,
    compiledAlertRuleId: null,
    compiledAutomationId: null,
    compiledHash: null,
    compiledAt: null,
    createdBy: 'u1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function mockExisting(row: Record<string, unknown>) {
  dbMock.select.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([row]),
      }),
    }),
  });
}

describe('updateMonitorDefinition / deleteMonitorDefinition run for real (#5289 coverage gap)', () => {
  // Mock hygiene (mockReset for select/transaction) is handled by the
  // file-level `beforeEach` above — no local one needed here.

  it('updateMonitorDefinition: assertCanWrite denies a partner-wide definition to a caller without canManagePartnerWidePolicies', async () => {
    mockExisting(existingRow({ orgId: null, partnerId: PARTNER }));

    await expect(
      updateMonitorDefinition('monitor-1', { enabled: false } as UpdateMonitorDefinitionInput, auth()),
    ).rejects.toBeInstanceOf(MonitorOwnershipError);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it('deleteMonitorDefinition: assertCanWrite denies a cross-partner caller even with full partner-wide access', async () => {
    mockExisting(existingRow({ orgId: null, partnerId: OTHER_PARTNER }));

    await expect(
      deleteMonitorDefinition(
        'monitor-1',
        auth({ scope: 'partner', partnerId: PARTNER, partnerOrgAccess: 'all' }),
      ),
    ).rejects.toBeInstanceOf(MonitorOwnershipError);
    expect(dbMock.delete).not.toHaveBeenCalled();
  });

  it('updateMonitorDefinition: rejects recurrenceThreshold set without recurrenceWindowHours', async () => {
    mockExisting(existingRow());

    await expect(
      updateMonitorDefinition(
        'monitor-1',
        { recurrenceThreshold: 5 } as UpdateMonitorDefinitionInput,
        auth(),
      ),
    ).rejects.toBeInstanceOf(MonitorValidationError);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it('updateMonitorDefinition: rejects deliveryMode "channels" with an empty channel list', async () => {
    mockExisting(existingRow());

    await expect(
      updateMonitorDefinition(
        'monitor-1',
        { deliveryMode: 'channels' } as UpdateMonitorDefinitionInput,
        auth(),
      ),
    ).rejects.toBeInstanceOf(MonitorValidationError);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("updateMonitorDefinition: rejects setting escalationPolicyId to another org's escalation policy (#5676)", async () => {
    // Sequenced, not `mockExisting`'s persistent mockReturnValue: the first
    // select is getMonitorDefinition's existing-row read, the second is the
    // new guard's policy-ownership lookup — they must return different rows.
    mockSelectQueue([
      existingRow(),
      { orgId: '33333333-3333-4333-8333-333333333333', partnerId: null },
    ]);

    await expect(
      updateMonitorDefinition(
        'monitor-1',
        { escalationPolicyId: ESCALATION_POLICY } as UpdateMonitorDefinitionInput,
        auth(),
      ),
    ).rejects.toBeInstanceOf(MonitorValidationError);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("updateMonitorDefinition: allows setting escalationPolicyId to the org's own partner-wide escalation policy (#5676)", async () => {
    mockSelectQueue([
      existingRow(), // getMonitorDefinition: org-owned, orgId=ORG
      { orgId: null, partnerId: PARTNER }, // escalation policy: partner-wide
      { partnerId: PARTNER }, // organizations lookup for ORG's partner
    ]);
    (dbMock.transaction as unknown as { mockImplementation: (fn: () => Promise<string>) => void }).mockImplementation(async () => 'ok');

    await expect(
      updateMonitorDefinition(
        'monitor-1',
        { escalationPolicyId: ESCALATION_POLICY } as UpdateMonitorDefinitionInput,
        auth(),
      ),
    ).resolves.toBe('ok');
  });
});


it('creates a system monitor with a null actor using the supplied executor throughout', async () => {
  const created = existingRow({ createdBy: null });
  const values = vi.fn().mockReturnValue({ returning: async () => [created] });
  const tx = { insert: vi.fn().mockReturnValue({ values }) };
  const from = vi.fn()
    .mockReturnValueOnce({ where: () => ({ limit: async () => [{ orgId: null, partnerId: PARTNER }] }) })
    .mockReturnValueOnce({ where: () => ({ limit: async () => [{ partnerId: PARTNER }] }) });
  const executor = {
    select: vi.fn().mockReturnValue({ from }),
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
  };
  const compile = vi.spyOn(monitorCompiler, 'compileMonitorInTx').mockResolvedValue({
    alertTemplateId: 'template-1', alertRuleId: 'rule-1', automationId: 'automation-1', hash: 'hash',
  });
  try {
    const result = await createMonitorDefinition(
      input({ escalationPolicyId: ESCALATION_POLICY }), auth({ scope: 'system' }), {},
      executor as unknown as monitorCompiler.DbExecutor,
    );
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ createdBy: null, orgId: ORG, partnerId: null }));
    expect(executor.select).toHaveBeenCalledTimes(2);
    expect(executor.transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledWith(tx, created);
    expect(result).toMatchObject({ createdBy: null, compiledAlertRuleId: 'rule-1' });
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(dbMock.transaction).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  } finally {
    compile.mockRestore();
  }
});
