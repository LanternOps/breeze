import { describe, expect, it, vi, beforeEach } from 'vitest';

// Same rationale as monitorService.test.ts: every assertion that matters here
// either never reaches the DB (validation/ownership fail first) or reaches it
// through a hand-shaped chain, so the module only needs to exist. The spread
// of importOriginal preserves the DB-context helpers (withDbAccessContext,
// runOutsideDbContext) that the import graph captures at load time.
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(async () => {
      throw new Error('transaction should not be reached in these cases');
    }),
  },
}));

// getConfigPolicy/addFeatureLink/updateFeatureLink/removeFeatureLink are
// mocked directly rather than driven through the real configurationPolicy
// service (which issues several more db.select calls per policy fetch) —
// these attach/detach tests only care about the ownership gate in
// aiToolsMonitors.ts itself, not configurationPolicy's own read logic.
const { getConfigPolicyMock, addFeatureLinkMock, updateFeatureLinkMock, removeFeatureLinkMock } = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  addFeatureLinkMock: vi.fn(),
  updateFeatureLinkMock: vi.fn(),
  removeFeatureLinkMock: vi.fn(),
}));
vi.mock('./configurationPolicy', () => ({
  getConfigPolicy: getConfigPolicyMock,
  addFeatureLink: addFeatureLinkMock,
  updateFeatureLink: updateFeatureLinkMock,
  removeFeatureLink: removeFeatureLinkMock,
}));

// Real pre-check replaced with a controllable mock — its own ownership-axis
// logic is unit tested in monitors/monitorAttachability.test.ts. Defaults to
// attachable; tests that need a refusal override with mockResolvedValueOnce(false).
const { isMonitorAttachableToPolicyMock } = vi.hoisted(() => ({
  isMonitorAttachableToPolicyMock: vi.fn(async () => true),
}));
vi.mock('./monitors/monitorAttachability', () => ({
  isMonitorAttachableToPolicy: isMonitorAttachableToPolicyMock,
}));

import { db } from '../db';
import { registerMonitorTools } from './aiToolsMonitors';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function registry(): Map<string, AiTool> {
  const reg = new Map<string, AiTool>();
  registerMonitorTools(reg);
  return reg;
}

function handlerFor(name: string): AiTool['handler'] {
  const tool = registry().get(name);
  if (!tool) throw new Error(`${name} not registered`);
  return tool.handler;
}

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';

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

async function call(name: string, input: Record<string, unknown>, as: AuthContext = auth()) {
  return JSON.parse(await handlerFor(name)(input, as));
}

/** Chainable `db.select(...)` stand-in resolving to `rows` regardless of which chain methods are called. */
function chain<T>(rows: T[]) {
  const c: Record<string, unknown> = {
    then: (resolve: (v: T[]) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  };
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'groupBy', 'limit', 'offset']) {
    c[method] = () => c;
  }
  return c;
}

function monitorRow(overrides: Record<string, unknown> = {}) {
  return { id: 'm1', orgId: ORG, partnerId: null, name: 'CPU high', ...overrides };
}

function validDefinition(overrides: Record<string, unknown> = {}) {
  return {
    name: 'CPU high',
    kind: 'cpu',
    condition: { operator: 'gt', value: 90 },
    severity: 'high',
    ...overrides,
  };
}

describe('aiToolsMonitors registration (#5289)', () => {
  it('registers list_monitors and get_monitor at tier 1, manage_monitor_definitions at tier 3', () => {
    const reg = registry();
    expect(reg.get('list_monitors')?.tier).toBe(1);
    expect(reg.get('get_monitor')?.tier).toBe(1);
    expect(reg.get('manage_monitor_definitions')?.tier).toBe(3);
  });
});

describe('list_monitors', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the monitor definitions the caller can see, with attachment counts', async () => {
    let selectCall = 0;
    mockDb.select.mockImplementation(() => {
      selectCall++;
      if (selectCall === 1) {
        return {
          from: () => ({
            where: () => ({
              orderBy: () =>
                Promise.resolve([
                  { id: 'm1', name: 'CPU high', kind: 'cpu', severity: 'high', enabled: true, orgId: ORG, partnerId: null },
                  { id: 'm2', name: 'Disk full', kind: 'disk', severity: 'critical', enabled: true, orgId: null, partnerId: PARTNER },
                ]),
            }),
          }),
        };
      }
      return { from: () => ({ where: () => ({ groupBy: () => Promise.resolve([{ monitorId: 'm1', count: 2 }]) }) }) };
    });

    const result = await call('list_monitors', {});

    expect(result.monitors).toEqual([
      { id: 'm1', name: 'CPU high', kind: 'cpu', severity: 'high', enabled: true, ownerScope: 'organization', attachmentCount: 2 },
      { id: 'm2', name: 'Disk full', kind: 'disk', severity: 'critical', enabled: true, ownerScope: 'partner', attachmentCount: 0 },
    ]);
    expect(result.total).toBe(2);
    expect(result.showing).toBe(2);
  });

  it('returns an empty list without querying attachment counts', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }) });
    const result = await call('list_monitors', { kind: 'cpu' });
    expect(result).toEqual({ monitors: [], total: 0, showing: 0 });
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });
});

describe('get_monitor', () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a not-found shape for an id the caller cannot see", async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) });
    const result = await call('get_monitor', { monitorId: 'ghost' });
    expect(result.error).toMatch(/not found/i);
  });

  it('requires monitorId', async () => {
    const result = await call('get_monitor', {});
    expect(result.error).toMatch(/monitorId/);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('returns the definition, attachments, and compiled ids when visible', async () => {
    let selectCall = 0;
    mockDb.select.mockImplementation(() => {
      selectCall++;
      if (selectCall === 1) {
        return {
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([
                  {
                    id: 'm1',
                    name: 'CPU high',
                    orgId: ORG,
                    partnerId: null,
                    compiledAlertTemplateId: 't1',
                    compiledAlertRuleId: 'r1',
                    compiledAutomationId: 'a1',
                  },
                ]),
            }),
          }),
        };
      }
      return {
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () =>
                Promise.resolve([
                  { id: 'att1', configPolicyId: 'p1', policyName: 'Policy A', enabled: true, overrides: null },
                ]),
            }),
          }),
        }),
      };
    });

    const result = await call('get_monitor', { monitorId: 'm1' });

    expect(result.monitor).toMatchObject({ id: 'm1', ownerScope: 'organization' });
    expect(result.attachments).toEqual([
      { id: 'att1', configPolicyId: 'p1', policyName: 'Policy A', enabled: true, overrides: null },
    ]);
    expect(result.compiled).toEqual({ alertTemplateId: 't1', alertRuleId: 'r1', automationId: 'a1' });
  });
});

describe('manage_monitor_definitions create', () => {
  beforeEach(() => vi.clearAllMocks());

  it('surfaces a validation error as the tool layer error shape, without calling the DB', async () => {
    const result = await call('manage_monitor_definitions', {
      action: 'create',
      // Missing `severity` (required, no default) — fails createMonitorDefinitionSchema
      // before the service (and therefore the DB) is ever reached.
      definition: { name: 'Bad', kind: 'cpu', condition: { operator: 'gt', value: 90 } },
    });
    expect(result.error).toBeTruthy();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('an org-scoped caller creating with ownerScope "partner" surfaces the ownership refusal', async () => {
    const result = await call(
      'manage_monitor_definitions',
      { action: 'create', definition: validDefinition({ ownerScope: 'partner' }) },
      auth({ scope: 'organization', partnerId: PARTNER, partnerOrgAccess: null }),
    );
    expect(result.error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
    // resolveOwnerForCreate throws before the transaction — the mocked
    // db.transaction (which throws if invoked) proves this never got that far.
  });

  it('requires a definition', async () => {
    const result = await call('manage_monitor_definitions', { action: 'create' });
    expect(result.error).toBeTruthy();
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe('manage_monitor_definitions — other actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delete requires monitorId', async () => {
    const result = await call('manage_monitor_definitions', { action: 'delete' });
    expect(result.error).toMatch(/monitorId/);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('rejects an unknown action', async () => {
    const result = await call('manage_monitor_definitions', { action: 'teleport' });
    expect(result.error).toMatch(/Unknown action/);
  });
});

/**
 * Queue up the sequence of `db.select` calls a test drives through
 * (getMonitorDefinition, then the attachment/link lookups), regardless of
 * which chain methods each call happens to invoke — `chain()` accepts any.
 */
function queueSelects(...results: Array<Array<Record<string, unknown>>>) {
  let call = 0;
  mockDb.select.mockImplementation(() => chain(results[call++] ?? []));
}

describe('manage_monitor_definitions attach — partner-wide gate & attachability (#5289 review fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMonitorAttachableToPolicyMock.mockImplementation(async () => true);
  });

  it('refuses to attach to a PARTNER-WIDE policy when the caller cannot manage partner-wide policies', async () => {
    queueSelects([monitorRow()]);
    getConfigPolicyMock.mockResolvedValue({ id: 'p1', orgId: null, partnerId: PARTNER });

    const result = await call(
      'manage_monitor_definitions',
      { action: 'attach', monitorId: 'm1', configPolicyId: 'p1' },
      auth({ scope: 'organization', partnerId: PARTNER, partnerOrgAccess: null }),
    );

    expect(result.error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
    expect(addFeatureLinkMock).not.toHaveBeenCalled();
    expect(updateFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('allows attaching to a PARTNER-WIDE policy when the caller CAN manage partner-wide policies', async () => {
    queueSelects([monitorRow()], []);
    getConfigPolicyMock.mockResolvedValue({ id: 'p1', orgId: null, partnerId: PARTNER });

    const result = await call(
      'manage_monitor_definitions',
      { action: 'attach', monitorId: 'm1', configPolicyId: 'p1' },
      auth({ scope: 'partner', partnerId: PARTNER, orgId: null, partnerOrgAccess: 'all' }),
    );

    expect(result.success).toBe(true);
    expect(addFeatureLinkMock).toHaveBeenCalledTimes(1);
  });

  it('refuses the attach when the ownership pre-check refuses, and never writes the feature link', async () => {
    queueSelects([monitorRow()]);
    getConfigPolicyMock.mockResolvedValue({ id: 'p1', orgId: ORG, partnerId: null });
    isMonitorAttachableToPolicyMock.mockResolvedValueOnce(false);

    const result = await call('manage_monitor_definitions', { action: 'attach', monitorId: 'm1', configPolicyId: 'p1' });

    expect(result.error).toMatch(/ownership axis mismatch/);
    expect(addFeatureLinkMock).not.toHaveBeenCalled();
    expect(updateFeatureLinkMock).not.toHaveBeenCalled();
  });
});

describe('manage_monitor_definitions detach — partner-wide gate (#5289 review fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMonitorAttachableToPolicyMock.mockImplementation(async () => true);
  });

  const attachmentRow = { id: 'att1', featureLinkId: 'fl1', configPolicyId: 'p1' };

  it('refuses to detach from a PARTNER-WIDE policy when the caller cannot manage partner-wide policies', async () => {
    queueSelects([monitorRow()], [attachmentRow]);
    getConfigPolicyMock.mockResolvedValue({ id: 'p1', orgId: null, partnerId: PARTNER });

    const result = await call(
      'manage_monitor_definitions',
      { action: 'detach', monitorId: 'm1', attachmentId: 'att1' },
      auth({ scope: 'organization', partnerId: PARTNER, partnerOrgAccess: null }),
    );

    expect(result.error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
    expect(removeFeatureLinkMock).not.toHaveBeenCalled();
    expect(updateFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('allows detaching from a PARTNER-WIDE policy when the caller CAN manage partner-wide policies', async () => {
    queueSelects([monitorRow()], [attachmentRow], []);
    getConfigPolicyMock.mockResolvedValue({ id: 'p1', orgId: null, partnerId: PARTNER });

    const result = await call(
      'manage_monitor_definitions',
      { action: 'detach', monitorId: 'm1', attachmentId: 'att1' },
      auth({ scope: 'partner', partnerId: PARTNER, orgId: null, partnerOrgAccess: 'all' }),
    );

    expect(result.success).toBe(true);
    expect(removeFeatureLinkMock).toHaveBeenCalledTimes(1);
  });
});
