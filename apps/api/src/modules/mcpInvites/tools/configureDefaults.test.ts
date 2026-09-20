vi.mock('./configureDefaults.monitors', () => ({ applyStandardAlertPolicy: vi.fn().mockResolvedValue({ created: true }) }));
vi.mock('../../../services/mfaPolicyActivation', () => ({ lockMfaPolicySettings: vi.fn().mockResolvedValue(undefined) }));
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks (module-factories run at import-time) --------------------------

vi.mock('../../../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

vi.mock('../../../db/schema', () => ({
  deviceGroups: { id: 'dg.id', orgId: 'dg.org_id', name: 'dg.name' },
  notificationChannels: {
    id: 'nc.id',
    orgId: 'nc.org_id',
    name: 'nc.name',
  },
  alertTemplates: { id: 'at.id', name: 'at.name', isBuiltIn: 'at.is_built_in' },
  alertRules: {
    id: 'ar.id',
    orgId: 'ar.org_id',
    partnerId: 'ar.partner_id',
    templateId: 'ar.template_id',
  },
  partners: {
    id: 'p.id',
    settings: 'p.settings',
    paymentMethodAttachedAt: 'p.payment_method_attached_at',
  },
  organizations: {
    id: 'org.id',
    partnerId: 'org.partner_id',
  },
}));

// paymentGate.ts was deleted in Phase 3. The requirePaymentMethod decorator
// is no longer used by this tool; payment enforcement is handled at the MCP
// dispatch layer (dispatchBootstrapAuthTool in mcpServer.ts).

vi.mock('../../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

vi.mock('drizzle-orm', async () => {
  // We only need these helpers to be callable; their return values are
  // opaque to the mock db chains.
  return {
    and: (...args: unknown[]) => ({ _op: 'and', args }),
    or: (...args: unknown[]) => ({ _op: 'or', args }),
    eq: (a: unknown, b: unknown) => ({ _op: 'eq', a, b }),
    ilike: (a: unknown, b: unknown) => ({ _op: 'ilike', a, b }),
    inArray: (a: unknown, b: unknown) => ({ _op: 'inArray', a, b }),
    isNull: (a: unknown) => ({ _op: 'isNull', a }),
    sql: Object.assign(
      (strings: TemplateStringsArray, ...vals: unknown[]) => ({
        _op: 'sql',
        strings,
        vals,
      }),
      { raw: (s: string) => ({ _op: 'raw', s }) },
    ),
  };
});

import {
  configureDefaultsTool,
  ensureDefaultDeviceGroup,
  applyStandardAlertPolicy,
  setRiskProfile,
  addNotificationChannel,
} from './configureDefaults';
import { db } from '../../../db';

// ---- Chain mock helpers ---------------------------------------------------

/**
 * Queue-based mock for `db.select().from().where().limit()` (and `.where()`
 * used as the terminal). Each call to `db.select()` pops the next result set
 * from the queue.
 */
function mockSelectQueue(results: unknown[][]): void {
  const queue = [...results];
  vi.mocked(db.select).mockImplementation(() => {
    // Each call to `db.select()` consumes exactly one queued result set. The
    // returned chain supports both terminal shapes:
    //   - `.from().where()`         (awaited directly)
    //   - `.from().where().limit(n)` (awaited on .limit)
    const result = queue.shift() ?? [];
    const terminal: any = Promise.resolve(result);
    terminal.limit = vi.fn().mockReturnValue(Promise.resolve(result));
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue(terminal),
    };
    return chain as any;
  });
}

function mockInsertOk(): ReturnType<typeof vi.fn> {
  const values = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.insert).mockImplementation(() => ({ values } as any));
  return values;
}

function mockUpdateOk(): ReturnType<typeof vi.fn> {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  vi.mocked(db.update).mockImplementation(() => ({ set } as any));
  return set;
}

// ---- Fixtures -------------------------------------------------------------

const PARTNER_ID = '22222222-2222-2222-2222-222222222222';
const ORG_ID = '33333333-3333-3333-3333-333333333333';

const ctx: any = {
  ip: '1.2.3.4',
  userAgent: 'mcp-test',
  region: 'us',
  apiKey: {
    id: '11111111-1111-1111-1111-111111111111',
    partnerId: PARTNER_ID,
    defaultOrgId: ORG_ID,
    partnerAdminEmail: 'admin@acme.com',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---- Unit tests: helpers --------------------------------------------------

describe('ensureDefaultDeviceGroup', () => {
  it('creates the group when none exists', async () => {
    mockSelectQueue([[]]); // no existing rows
    const values = mockInsertOk();
    const res = await ensureDefaultDeviceGroup(ORG_ID);
    expect(res).toEqual({ created: true });
    expect(values).toHaveBeenCalledOnce();
  });

  it('is idempotent when the group already exists', async () => {
    mockSelectQueue([[{ id: 'existing' }]]);
    const values = mockInsertOk();
    const res = await ensureDefaultDeviceGroup(ORG_ID);
    expect(res).toEqual({ created: false });
    expect(values).not.toHaveBeenCalled();
  });
});

it('passes the bootstrap partner identity to the monitor attachment step', async () => {
  mockSelectQueue([[], [{ settings: {} }], []]);
  mockInsertOk(); mockUpdateOk();
  await configureDefaultsTool.handler({}, ctx);
  expect(applyStandardAlertPolicy).toHaveBeenCalledWith(ORG_ID, 'standard', PARTNER_ID);
});

describe('setRiskProfile', () => {
  it('writes settings.riskProfile when not set', async () => {
    mockSelectQueue([[{ settings: {} }]]);
    const set = mockUpdateOk();
    const res = await setRiskProfile(PARTNER_ID, 'standard');
    expect(res).toEqual({ created: true });
    expect(set).toHaveBeenCalledWith({ settings: { riskProfile: 'standard' } });
  });

  it('preserves other settings keys', async () => {
    mockSelectQueue([[{ settings: { theme: 'dark' } }]]);
    const set = mockUpdateOk();
    await setRiskProfile(PARTNER_ID, 'strict');
    expect(set).toHaveBeenCalledWith({
      settings: { theme: 'dark', riskProfile: 'strict' },
    });
  });

  it('is idempotent when the same level is already set', async () => {
    mockSelectQueue([[{ settings: { riskProfile: 'standard' } }]]);
    const set = mockUpdateOk();
    const res = await setRiskProfile(PARTNER_ID, 'standard');
    expect(res).toEqual({ created: false });
    expect(set).not.toHaveBeenCalled();
  });
});

describe('addNotificationChannel', () => {
  it('creates an email channel when none by that name exists', async () => {
    mockSelectQueue([[]]);
    const values = mockInsertOk();
    const res = await addNotificationChannel(ORG_ID, {
      kind: 'email',
      target: 'admin@acme.com',
    });
    expect(res).toEqual({ created: true });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        type: 'email',
        config: { recipients: ['admin@acme.com'] },
      }),
    );
  });

  it('is idempotent when the channel already exists', async () => {
    mockSelectQueue([[{ id: 'existing-channel' }]]);
    const values = mockInsertOk();
    const res = await addNotificationChannel(ORG_ID, {
      kind: 'email',
      target: 'admin@acme.com',
    });
    expect(res).toEqual({ created: false });
    expect(values).not.toHaveBeenCalled();
  });
});

// ---- Tool handler ---------------------------------------------------------

describe('configure_defaults tool', () => {
  it('input schema accepts empty object (all optional)', () => {
    const parsed = configureDefaultsTool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('input schema rejects unknown risk_level', () => {
    const parsed = configureDefaultsTool.definition.inputSchema.safeParse({
      risk_level: 'bogus',
    });
    expect(parsed.success).toBe(false);
  });

  it('happy path: all four steps apply cleanly on a blank tenant', async () => {
    mockSelectQueue([[], [{ settings: {} }], []]);
    mockInsertOk();
    mockUpdateOk();

    const out = await configureDefaultsTool.handler({}, ctx);
    expect(out.applied.device_group.created).toBe(true);
    expect(out.applied.alert_policy.created).toBe(true);
    expect(out.applied.risk_profile.created).toBe(true);
    expect(out.applied.notification_channel.created).toBe(true);
    expect(out.errors).toBeUndefined();
  });

  it('second call is fully idempotent (nothing created, no errors)', async () => {
    mockSelectQueue([[{ id: 'dg-1' }], [{ settings: { riskProfile: 'standard' } }], [{ id: 'nc-1' }]]);
    vi.mocked(applyStandardAlertPolicy).mockResolvedValueOnce({ created: false });
    mockInsertOk();
    mockUpdateOk();

    const out = await configureDefaultsTool.handler({}, ctx);
    expect(out.applied.device_group.created).toBe(false);
    expect(out.applied.alert_policy.created).toBe(false);
    expect(out.applied.risk_profile.created).toBe(false);
    expect(out.applied.notification_channel.created).toBe(false);
    expect(out.errors).toBeUndefined();
  });

  it('reports monitor attachment failure and still configures the other defaults', async () => {
    mockSelectQueue([[], [{ settings: {} }], []]); mockInsertOk(); mockUpdateOk();
    vi.mocked(applyStandardAlertPolicy).mockRejectedValueOnce(new Error('attachment rejected'));
    const result = await configureDefaultsTool.handler({}, ctx);
    expect(result.errors).toContainEqual({ step: 'alert_policy', error: 'attachment rejected' });
    expect(result.applied.notification_channel.created).toBe(true);
  });

  it('partial failure: one step throwing does not prevent the others', async () => {
    // The device-group SELECT fails; the other independent steps still run.
    const queue = [[{ settings: {} }], []];
    let call = 0;
    vi.mocked(db.select).mockImplementation(() => {
      call++;
      if (call === 1) {
        throw new Error('db unavailable for device_group');
      }
      const result = queue.shift() ?? [];
      const terminal: any = Promise.resolve(result);
      terminal.limit = vi.fn().mockReturnValue(Promise.resolve(result));
      const chain: any = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnValue(terminal),
      };
      return chain;
    });
    mockInsertOk();
    mockUpdateOk();

    const out = await configureDefaultsTool.handler({}, ctx);
    expect(out.applied.device_group.created).toBe(false);
    expect(out.applied.notification_channel.created).toBe(true);
    expect(out.applied.risk_profile.created).toBe(true);
    expect(out.errors).toBeDefined();
    expect(out.errors?.some((e) => e.step === 'device_group')).toBe(true);
  });
});

// ---- Tool definition wiring -----------------------------------------------

// paymentGate.ts was deleted in Phase 3; scope enforcement is now handled
// by the execute-scope check in dispatchBootstrapAuthTool.
describe('configure_defaults tool wiring', () => {
  it('tool definition registers a handler', () => {
    expect(typeof configureDefaultsTool.handler).toBe('function');
    expect(configureDefaultsTool.definition.name).toBe('configure_defaults');
  });
});
