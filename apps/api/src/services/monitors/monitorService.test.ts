import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { monitorConversions, monitorDefinitions, networkMonitors } from '../../db/schema';

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
  getMonitorDefinition,
  listMonitorDefinitions,
  listMonitorDefinitionsPage,
  MonitorHasDependentsError,
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
    expect(compile).toHaveBeenCalledWith(tx, created, {});
    expect(result).toMatchObject({ createdBy: null, compiledAlertRuleId: 'rule-1' });
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(dbMock.transaction).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  } finally {
    compile.mockRestore();
  }
});


describe('conversion executor propagation', () => {
  it.each(['cpu', 'network_check'])('deletes an unadopted %s monitor only through the caller executor', async (kind) => {
    const row = existingRow({ kind });
    const where = vi.fn(async () => undefined);
    const tx = {
      select: vi.fn(() => ({ from: (table: unknown) => ({ where: () => {
        const query = { orderBy: () => query, for: async () => table === monitorDefinitions ? [row] : [] };
        return query;
      } }) })),
      delete: vi.fn(() => ({ where })),
    };
    const executor = {
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) })),
      transaction: vi.fn(async (work: (value: typeof tx) => Promise<void>) => work(tx)),
    };
    expect(await getMonitorDefinition('monitor-1', auth(), executor as never)).toEqual(row);
    await deleteMonitorDefinition('monitor-1', auth(), executor as never);
    expect(executor.select).toHaveBeenCalledTimes(2);
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(executor.transaction).toHaveBeenCalledOnce();
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(dbMock.delete).not.toHaveBeenCalled();
  });
});

describe('deleteMonitorDefinition: dependent-row FK violation (#6509)', () => {
  // Regression for #6509: DELETE 500ed with the raw postgres
  // "alerts_rule_id_alert_rules_id_fk" constraint text once the monitor had
  // ever produced an alert. The FK is now ON DELETE SET NULL
  // (2026-10-25-130200) so this should not fire in the ordinary case, but the
  // service still owes a clean, typed error for ANY residual FK violation the
  // cascade hits, instead of letting the raw driver error propagate to the
  // route (and from there, to the client).
  it('maps a postgres foreign-key violation to MonitorHasDependentsError', async () => {
    const row = existingRow();
    const pgForeignKeyError = Object.assign(
      new Error(
        'update or delete on table "alert_rules" violates foreign key constraint '
        + '"alerts_rule_id_alert_rules_id_fk" on table "alerts"',
      ),
      { code: '23503' },
    );
    const where = vi.fn(async () => {
      throw pgForeignKeyError;
    });
    const tx = {
      select: vi.fn(() => ({ from: (table: unknown) => ({ where: () => {
        const query = { orderBy: () => query, for: async () => table === monitorDefinitions ? [row] : [] };
        return query;
      } }) })),
      delete: vi.fn(() => ({ where })),
    };
    const executor = {
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) })),
      transaction: vi.fn(async (work: (value: typeof tx) => Promise<void>) => work(tx)),
    };

    await expect(
      deleteMonitorDefinition('monitor-1', auth(), executor as never),
    ).rejects.toBeInstanceOf(MonitorHasDependentsError);
  });

  it('lets a non-FK error propagate untouched', async () => {
    const row = existingRow();
    const otherError = new Error('connection reset');
    const where = vi.fn(async () => {
      throw otherError;
    });
    const tx = {
      select: vi.fn(() => ({ from: (table: unknown) => ({ where: () => {
        const query = { orderBy: () => query, for: async () => table === monitorDefinitions ? [row] : [] };
        return query;
      } }) })),
      delete: vi.fn(() => ({ where })),
    };
    const executor = {
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) })),
      transaction: vi.fn(async (work: (value: typeof tx) => Promise<void>) => work(tx)),
    };

    await expect(
      deleteMonitorDefinition('monitor-1', auth(), executor as never),
    ).rejects.toBe(otherError);
  });
});

describe('Fleet Design savepoint executor propagation (W05c2 Task 16)', () => {
  it('forwards the exact compile options through the extracted create helper', async () => {
    const row = existingRow();
    const values = vi.fn(() => ({ returning: async () => [row] }));
    const tx = { insert: vi.fn(() => ({ values })) };
    const executor = { transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)) };
    const options: monitorCompiler.CompileOptions = {};
    const compile = vi.spyOn(monitorCompiler, 'compileMonitorInTx').mockResolvedValue({
      alertTemplateId: 'template', alertRuleId: 'rule', automationId: 'automation', hash: 'hash',
    } as Awaited<ReturnType<typeof monitorCompiler.compileMonitorInTx>>);
    try {
      await createMonitorDefinition(input(), auth(), options,
        executor as unknown as Parameters<typeof createMonitorDefinition>[3]);
      expect(executor.transaction).toHaveBeenCalledOnce();
      expect(compile).toHaveBeenCalledWith(tx, row, options);
      expect(compile.mock.calls[0]![2]).toBe(options);
      expect(dbMock.select).not.toHaveBeenCalled();
      expect(dbMock.transaction).not.toHaveBeenCalled();
    } finally { compile.mockRestore(); }
  });

  it('uses the supplied executor for update reads, reference validation and compilation', async () => {
    const row = existingRow({ escalationPolicyId: ESCALATION_POLICY });
    const query = (result: unknown[]) => ({ from: () => ({ where: () => ({ limit: async () => result }) }) });
    const select = vi.fn().mockReturnValueOnce(query([row]))
      .mockReturnValueOnce(query([{ orgId: null, partnerId: PARTNER }]))
      .mockReturnValueOnce(query([{ partnerId: PARTNER }]));
    const updated = { ...row, description: 'Fleet provenance' };
    const set = vi.fn(() => ({ where: () => ({ returning: async () => [updated] }) }));
    const tx = { update: vi.fn(() => ({ set })) };
    const executor = { select, transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)) };
    const compile = vi.spyOn(monitorCompiler, 'compileMonitorInTx').mockResolvedValue({
      alertTemplateId: 'template', alertRuleId: 'rule', automationId: 'automation', hash: 'updated-hash',
    } as Awaited<ReturnType<typeof monitorCompiler.compileMonitorInTx>>);
    try {
      await expect(updateMonitorDefinition(row.id as string, { description: 'Fleet provenance' }, auth(),
        executor as unknown as Parameters<typeof updateMonitorDefinition>[3]))
        .resolves.toMatchObject({ description: 'Fleet provenance', compiledHash: 'updated-hash' });
      expect(select).toHaveBeenCalledTimes(3);
      expect(executor.transaction).toHaveBeenCalledOnce();
      expect(compile).toHaveBeenCalledWith(tx, updated);
      expect(dbMock.select).not.toHaveBeenCalled();
      expect(dbMock.transaction).not.toHaveBeenCalled();
    } finally { compile.mockRestore(); }
  });
});

describe('listMonitorDefinitions / listMonitorDefinitionsPage paging (#6735)', () => {
  /** A select chain that records every builder call and resolves to `rows`. */
  function recordingChain(rows: unknown[]) {
    type Method = 'from' | 'where' | 'orderBy' | 'limit' | 'offset' | 'leftJoin';
    const calls: Record<Method, unknown[][]> = { from: [], where: [], orderBy: [], limit: [], offset: [], leftJoin: [] };
    const chain: Record<string, unknown> = {};
    for (const method of Object.keys(calls) as Method[]) {
      chain[method] = vi.fn((...args: unknown[]) => { calls[method].push(args); return chain; });
    }
    // A subquery alias: exposes a `total` field for the outer projection.
    chain.as = vi.fn(() => ({ total: 'counted.total' }));
    const executed = { count: 0 };
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      executed.count++;
      return Promise.resolve(rows).then(resolve, reject);
    };
    return { chain, calls, executed };
  }

  /** The three builders listMonitorDefinitionsPage makes: count, page ids, outer statement. */
  function pageChains(outerRows: unknown[]) {
    const counted = recordingChain([]);
    const pageIds = recordingChain([]);
    const outer = recordingChain(outerRows);
    dbMock.select
      .mockReturnValueOnce(counted.chain)
      .mockReturnValueOnce(pageIds.chain)
      .mockReturnValueOnce(outer.chain);
    return { counted, pageIds, outer };
  }

  it('without a page argument issues no LIMIT/OFFSET and keeps the name-only ordering', async () => {
    const { chain, calls } = recordingChain([{ id: 'a' }]);
    dbMock.select.mockReturnValue(chain);

    const rows = await listMonitorDefinitions(auth(), { kind: 'cpu' });

    expect(rows).toEqual([{ id: 'a' }]);
    expect(calls.limit).toHaveLength(0);
    expect(calls.offset).toHaveLength(0);
    expect(calls.orderBy).toHaveLength(1);
    expect(calls.orderBy[0]).toHaveLength(1);
  });

  it('executes ONE statement: a count LEFT JOINed to the LIMIT/OFFSET page, over the same WHERE, with an id tiebreaker', async () => {
    const { counted, pageIds, outer } = pageChains([
      { total: 60, row: { id: 'a' } },
      { total: 60, row: { id: 'b' } },
    ]);

    const out = await listMonitorDefinitionsPage(auth(), { kind: 'cpu', enabled: true }, { limit: 25, offset: 50 });

    expect(out).toEqual({ rows: [{ id: 'a' }, { id: 'b' }], total: 60 });
    // Only the outer builder is executed; the other two are embedded in it,
    // so the page and its total come from one snapshot.
    expect(outer.executed.count).toBe(1);
    expect(counted.executed.count).toBe(0);
    expect(pageIds.executed.count).toBe(0);
    expect(dbMock.select).toHaveBeenCalledTimes(3);
    expect(outer.calls.leftJoin).toHaveLength(1);
    expect(pageIds.calls.limit).toEqual([[25]]);
    expect(pageIds.calls.offset).toEqual([[50]]);
    expect(pageIds.calls.orderBy[0]).toHaveLength(2);
    expect(outer.calls.orderBy[0]).toHaveLength(2);
    // The count is never paged, and it counts over exactly the page's WHERE.
    expect(counted.calls.limit).toHaveLength(0);
    expect(counted.calls.offset).toHaveLength(0);
    expect(counted.calls.where[0]).toEqual(pageIds.calls.where[0]);
    expect(counted.calls.where[0]![0]).toBeDefined();
  });

  it('an empty page past the end still carries the total from the same statement', async () => {
    const { outer } = pageChains([{ total: 42, row: null }]);
    const out = await listMonitorDefinitionsPage(auth(), { kind: 'cpu', enabled: false }, { limit: 10, offset: 500 });
    expect(out).toEqual({ rows: [], total: 42 });
    expect(outer.executed.count).toBe(1);
    expect(dbMock.select).toHaveBeenCalledTimes(3);
  });

  it('nothing visible is an empty page with total 0, not NaN', async () => {
    pageChains([{ total: 0, row: null }]);
    expect(await listMonitorDefinitionsPage(auth(), undefined, { limit: 25, offset: 0 })).toEqual({ rows: [], total: 0 });
  });
});

describe('network check asset ownership', () => {
  const assetId = '33333333-3333-4333-8333-333333333333';
  const condition = { checkType: 'icmp_ping', target: 'example.com', assetId };

  it('create rejects an asset outside the definition org before writing', async () => {
    mockSelectQueue([undefined]);
    await expect(createMonitorDefinition(input({ kind: 'network_check', condition }), auth()))
      .rejects.toThrow('asset_not_owned');
    expect(dbMock.transaction).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('create rejects partner-owned asset bindings without a lookup', async () => {
    await expect(createMonitorDefinition(input({ ownerScope: 'partner', kind: 'network_check', condition }),
      auth({ scope: 'partner', partnerOrgAccess: 'all' })))
      .rejects.toThrow('asset_requires_org_owner');
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it.each([true, false])('validates the merged update against its persisted owner (replacement=%s)', async (replacement) => {
    mockSelectQueue([existingRow({ kind: 'network_check', condition }), undefined]);
    await expect(updateMonitorDefinition('monitor-1', replacement ? { condition: { ...condition, assetId: OTHER_PARTNER } } : { name: 'Renamed' }, auth()))
      .rejects.toThrow('asset_not_owned');
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it('uses the supplied executor for asset validation and preserves validation errors', async () => {
    const executor = {
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })),
    };
    await expect(createMonitorDefinition(input({ kind: 'network_check', condition }), auth(), {}, executor as never))
      .rejects.toBeInstanceOf(MonitorValidationError);
    expect(executor.select).toHaveBeenCalledTimes(1);
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});

describe('deleteMonitorDefinition: adopted network history', () => {
  it('locks the definition, then probes, then conversion ledgers before release', async () => {
    const lockedTables: unknown[] = [];
    const tx = {
      select: vi.fn(() => ({ from: (table: unknown) => {
        const tables = [table];
        const query = {
          innerJoin: (joined: unknown) => { tables.push(joined); return query; },
          where: () => query,
          orderBy: () => query,
          for: async () => {
            lockedTables.push(...tables);
            if (table === monitorDefinitions) return [existingRow({ kind: 'network_check' })];
            if (table === networkMonitors) return [{ id: 'legacy', orgId: ORG, conversionId: 'conversion', sourceState: {} }];
            return [{ id: 'legacy', conversionId: 'conversion', sourceState: {} }];
          },
        };
        return query;
      } })),
      update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
      delete: vi.fn(() => ({ where: async () => undefined })),
    };
    const executor = {
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [existingRow({ kind: 'network_check' })] }) }) })),
      transaction: vi.fn(async (work: (value: typeof tx) => Promise<void>) => work(tx)),
    };
    await deleteMonitorDefinition('monitor-1', auth(), executor as never);
    expect(lockedTables.map((table) => table === monitorDefinitions ? 'definition' : table === networkMonitors ? 'probe' : 'ledger'))
      .toEqual(['definition', 'probe', 'ledger']);
  });

  it('releases only live adoption sources and marks their ledger before deleting in the same transaction', async () => {
    const writes: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const predicates: unknown[] = [];
    const tx = {
      select: vi.fn(() => ({ from: (table: unknown) => ({ where: (predicate: unknown) => {
        predicates.push(predicate);
        const query = {
          orderBy: () => query,
          for: async () => table === monitorDefinitions ? [existingRow({ kind: 'network_check' })]
            : table === networkMonitors ? [{ id: 'legacy', orgId: ORG }]
              : [{ id: 'legacy', conversionId: 'conversion', sourceState: { name: 'Gateway' } }],
        };
        return query;
      } }) })),
      update: vi.fn((table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: async () => { writes.push({ table, values }); } }) })),
      delete: vi.fn(() => ({ where: async () => {
        expect(writes).toEqual([
          { table: networkMonitors, values: { managedByMonitorId: null, isActive: false,
            retiredAt: expect.any(Date), retiredReason: 'monitor_deleted', updatedAt: expect.any(Date) } },
          { table: monitorConversions, values: { sourceState: { name: 'Gateway', sourceReleased: true } } },
        ]);
      } })),
    };
    const executor = {
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [existingRow({ kind: 'network_check' })] }) }) })),
      delete: vi.fn(() => ({ where: async () => undefined })),
      transaction: vi.fn(async (work: (value: typeof tx) => Promise<void>) => work(tx)),
    };
    await deleteMonitorDefinition('monitor-1', auth(), executor as never);
    expect(executor.transaction).toHaveBeenCalledOnce();
    expect(executor.delete).not.toHaveBeenCalled();
    expect(tx.delete).toHaveBeenCalledWith(monitorDefinitions);
    const probePredicate = new PgDialect().sqlToQuery(predicates[1] as never);
    expect(probePredicate.sql).toContain('"managed_by_monitor_id" =');
    expect(probePredicate.params).toContain('monitor-1');
    const predicate = new PgDialect().sqlToQuery(predicates[2] as never);
    expect(predicate.sql).toContain('"source_table" =');
    expect(predicate.sql).toContain('"reverted_at" is null');
    expect(predicate.params).toContain('legacy');
    expect(predicate.params).toContain(ORG);
    expect(predicate.params).toContain('network_monitors');
  });
});
