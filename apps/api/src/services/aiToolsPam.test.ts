import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('./eventBus', () => ({
  publishEvent: vi.fn(),
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { validateToolInput } from './aiToolSchemas';
import { publishEvent } from './eventBus';
import { registerPamTools } from './aiToolsPam';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SITE_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const PARTNER_ID = '44444444-4444-4444-8444-444444444444';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const RULE_ID = '66666666-6666-4666-8666-666666666666';

const EXPECTED_TOOLS = [
  'request_elevation',
  'revoke_elevation',
  'get_elevation_history',
] as const;

const EXPECTED_TIERS: Record<(typeof EXPECTED_TOOLS)[number], number> = {
  request_elevation: 3,
  revoke_elevation: 2,
  get_elevation_history: 1,
};

function createQueryChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.groupBy = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.offset = vi.fn(() => chain);
  chain.then = (resolve: (value: any[]) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function createInsertChain(rows: any[] = []) {
  const chain: any = {};
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  chain.then = (resolve: (value: any) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function createUpdateChain(rows: any[] = []) {
  const chain: any = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  chain.then = (resolve: (value: any[]) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function setDefaultDbMocks() {
  vi.mocked(db.select).mockImplementation(() => createQueryChain([]) as any);
  vi.mocked(db.insert).mockImplementation(() => createInsertChain([]) as any);
  vi.mocked(db.update).mockImplementation(() => createUpdateChain([]) as any);
  vi.mocked(db.delete).mockImplementation(() => createQueryChain([]) as any);
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(db));
  vi.mocked(publishEvent).mockResolvedValue('event-1');
}

function mockSelectSequence(rowsList: any[][]) {
  let index = 0;
  vi.mocked(db.select).mockImplementation(() => createQueryChain(rowsList[index++] ?? []) as any);
}

function mockInsertSequence(rowsList: any[][]) {
  let index = 0;
  vi.mocked(db.insert).mockImplementation(() => createInsertChain(rowsList[index++] ?? []) as any);
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User', isPlatformAdmin: false },
    token: {} as any,
    partnerId: PARTNER_ID,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    canAccessSite: (siteId: string | null | undefined) => siteId === SITE_ID,
    orgCondition: vi.fn(() => undefined),
  } as any;
}

function buildToolMap(): Map<string, AiTool> {
  const toolMap = new Map<string, AiTool>();
  registerPamTools(toolMap);
  return toolMap;
}

function deviceRow() {
  return {
    id: DEVICE_ID,
    orgId: ORG_ID,
    siteId: SITE_ID,
    partnerId: PARTNER_ID,
  };
}

function pamRule(verdict: 'auto_approve' | 'auto_deny' | 'require_approval' | 'ignore') {
  return {
    id: RULE_ID,
    orgId: ORG_ID,
    siteId: null,
    name: `${verdict} rule`,
    enabled: true,
    priority: 10,
    matchSigner: null,
    matchHash: null,
    matchPathGlob: null,
    matchParentImage: null,
    matchUser: 'localadmin',
    matchAdGroup: null,
    matchToolName: null,
    matchRiskTier: null,
    timeWindow: null,
    verdict,
    approvalDurationMinutes: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
  };
}

describe('registerPamTools', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it('registers all expected PAM Brain tools', () => {
    expect(toolMap.size).toBe(EXPECTED_TOOLS.length);
    expect(Array.from(toolMap.keys()).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it.each(Object.entries(EXPECTED_TIERS))('assigns tier %s -> %s', (toolName, tier) => {
    expect(toolMap.get(toolName)!.tier).toBe(tier);
  });

  it('declares deviceArgs for tools that take a deviceId', () => {
    expect(toolMap.get('request_elevation')!.deviceArgs).toEqual(['deviceId']);
    expect(toolMap.get('get_elevation_history')!.deviceArgs).toEqual(['deviceId']);
    expect(toolMap.get('revoke_elevation')!.deviceArgs ?? []).toEqual([]);
  });

  it.each([
    ['request_elevation', { deviceId: DEVICE_ID, subjectUsername: 'localadmin', reason: 'Patch', durationMinutes: 999 }],
    ['revoke_elevation', { elevationRequestId: REQUEST_ID, reason: 'No longer needed' }],
    ['get_elevation_history', { deviceId: DEVICE_ID, status: 'pending', flowType: 'tech_jit_admin', limit: 500 }],
  ])('accepts valid input for %s', (toolName, input) => {
    expect(validateToolInput(toolName, input as Record<string, unknown>)).toEqual({ success: true });
  });

  it.each([
    ['request_elevation', { deviceId: 'not-a-uuid', subjectUsername: 'localadmin', reason: 'Patch' }],
    ['request_elevation', { deviceId: DEVICE_ID, reason: 'Patch' }],
    ['revoke_elevation', { elevationRequestId: REQUEST_ID }],
    ['get_elevation_history', { deviceId: 'not-a-uuid' }],
  ])('rejects invalid input for %s', (toolName, input) => {
    const result = validateToolInput(toolName, input as Record<string, unknown>);
    expect(result.success).toBe(false);
  });
});

describe('aiToolsPam handlers', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultDbMocks();
    toolMap = buildToolMap();
  });

  it.each([
    ['request_elevation', { deviceId: DEVICE_ID, subjectUsername: 'localadmin', reason: 'Install driver' }],
    ['revoke_elevation', { elevationRequestId: REQUEST_ID, reason: 'No longer needed' }],
    ['get_elevation_history', { deviceId: DEVICE_ID }],
  ])('%s handler returns a JSON string', async (toolName, input) => {
    if (toolName === 'request_elevation') {
      mockSelectSequence([[deviceRow()], []]);
      mockInsertSequence([[{ id: REQUEST_ID, status: 'pending', expiresAt: null }], []]);
    } else if (toolName === 'revoke_elevation') {
      mockSelectSequence([[{ id: REQUEST_ID, orgId: ORG_ID, deviceId: DEVICE_ID, flowType: 'tech_jit_admin', status: 'approved' }]]);
      vi.mocked(db.update).mockImplementation(() => createUpdateChain([{ id: REQUEST_ID }]) as any);
    } else {
      mockSelectSequence([[{ id: REQUEST_ID, deviceId: DEVICE_ID, status: 'pending', flowType: 'tech_jit_admin', subjectUsername: 'localadmin', reason: 'Install driver', requestedAt: new Date(), expiresAt: null }]]);
    }

    const result = await toolMap.get(toolName)!.handler(input as Record<string, unknown>, makeAuth());
    expect(typeof result).toBe('string');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('creates a pending Brain elevation request when no PAM rule matches', async () => {
    mockSelectSequence([[deviceRow()], []]);
    mockInsertSequence([[{ id: REQUEST_ID, status: 'pending', expiresAt: null }], []]);

    const result = await toolMap.get('request_elevation')!.handler(
      { deviceId: DEVICE_ID, subjectUsername: 'localadmin', reason: 'Install driver' },
      makeAuth(),
    );
    const parsed = JSON.parse(result);
    const requestInsert = vi.mocked(db.insert).mock.results[0]!.value;
    const requestValues = requestInsert.values.mock.calls[0]![0];

    expect(parsed).toMatchObject({ elevationRequestId: REQUEST_ID, status: 'pending' });
    expect(requestValues).toMatchObject({
      orgId: ORG_ID,
      siteId: SITE_ID,
      partnerId: PARTNER_ID,
      deviceId: DEVICE_ID,
      flowType: 'tech_jit_admin',
      subjectUsername: 'localadmin',
      reason: 'Install driver',
      status: 'pending',
      metadata: expect.objectContaining({
        triggerSource: 'brain',
        requestedByUserId: 'user-1',
      }),
    });
    expect(requestValues.metadata).not.toHaveProperty('trigger_source');
    expect(publishEvent).toHaveBeenCalledWith(
      'elevation.requested',
      ORG_ID,
      expect.objectContaining({
        elevationRequestId: REQUEST_ID,
        deviceId: DEVICE_ID,
        flowType: 'tech_jit_admin',
        status: 'pending',
        subjectUsername: 'localadmin',
        triggerSource: 'brain',
      }),
      'brain',
    );
  });

  it('auto-approves a request when an auto_approve PAM rule matches', async () => {
    mockSelectSequence([[deviceRow()], [pamRule('auto_approve')]]);
    mockInsertSequence([[{ id: REQUEST_ID, status: 'auto_approved', expiresAt: new Date('2026-06-11T00:30:00.000Z') }], []]);

    const result = await toolMap.get('request_elevation')!.handler(
      { deviceId: DEVICE_ID, subjectUsername: 'localadmin', reason: 'Patch', durationMinutes: 30 },
      makeAuth(),
    );
    const parsed = JSON.parse(result);
    const requestInsert = vi.mocked(db.insert).mock.results[0]!.value;
    const requestValues = requestInsert.values.mock.calls[0]![0];
    const auditInsert = vi.mocked(db.insert).mock.results[1]!.value;
    const auditValues = auditInsert.values.mock.calls[0]![0];

    expect(parsed.status).toBe('auto_approved');
    expect(parsed.expiresAt).toBeTruthy();
    expect(requestValues.status).toBe('auto_approved');
    expect(requestValues.approvedAt).toBeInstanceOf(Date);
    expect(requestValues.expiresAt).toBeInstanceOf(Date);
    expect(requestValues.metadata).toMatchObject({ triggerSource: 'brain', pamRuleId: RULE_ID });
    expect(auditValues.map((r: any) => r.eventType)).toEqual(['requested', 'auto_approved']);
    expect(auditValues[0].actor).toBe('system');
    expect(auditValues[1].actor).toBe('policy');
    expect(publishEvent).toHaveBeenCalledWith(
      'elevation.auto_approved',
      ORG_ID,
      expect.objectContaining({ elevationRequestId: REQUEST_ID, pamRuleId: RULE_ID, triggerSource: 'brain' }),
      'brain',
    );
  });

  it('denies a request when an auto_deny PAM rule matches', async () => {
    mockSelectSequence([[deviceRow()], [pamRule('auto_deny')]]);
    mockInsertSequence([[{ id: REQUEST_ID, status: 'denied', expiresAt: null }], []]);

    const result = await toolMap.get('request_elevation')!.handler(
      { deviceId: DEVICE_ID, subjectUsername: 'localadmin', reason: 'Patch' },
      makeAuth(),
    );
    const parsed = JSON.parse(result);
    const requestInsert = vi.mocked(db.insert).mock.results[0]!.value;
    const requestValues = requestInsert.values.mock.calls[0]![0];
    const auditInsert = vi.mocked(db.insert).mock.results[1]!.value;
    const auditValues = auditInsert.values.mock.calls[0]![0];

    expect(parsed.status).toBe('denied');
    expect(requestValues).toMatchObject({
      status: 'denied',
      denialReason: 'Blocked by PAM rule "auto_deny rule"',
    });
    expect(auditValues.map((r: any) => r.eventType)).toEqual(['requested', 'denied']);
    expect(auditValues[1].actor).toBe('policy');
    expect(publishEvent).toHaveBeenCalledWith(
      'elevation.denied',
      ORG_ID,
      expect.objectContaining({ elevationRequestId: REQUEST_ID, pamRuleId: RULE_ID, triggerSource: 'brain' }),
      'brain',
    );
  });

  it('honors orgCondition while creating Brain elevation requests', async () => {
    mockSelectSequence([[deviceRow()], []]);
    mockInsertSequence([[{ id: REQUEST_ID, status: 'pending', expiresAt: null }], []]);
    const auth = makeAuth();

    await toolMap.get('request_elevation')!.handler(
      { deviceId: DEVICE_ID, subjectUsername: 'localadmin', reason: 'Install driver' },
      auth,
    );

    expect(auth.orgCondition).toHaveBeenCalled();
  });

  it('revokes an active elevation request with CAS, audit, and event', async () => {
    mockSelectSequence([[{ id: REQUEST_ID, orgId: ORG_ID, deviceId: DEVICE_ID, flowType: 'tech_jit_admin', status: 'approved' }]]);
    vi.mocked(db.update).mockImplementation(() => createUpdateChain([{ id: REQUEST_ID }]) as any);
    mockInsertSequence([[]]);

    const result = await toolMap.get('revoke_elevation')!.handler(
      { elevationRequestId: REQUEST_ID, reason: 'No longer needed' },
      makeAuth(),
    );
    const parsed = JSON.parse(result);
    const updateChain = vi.mocked(db.update).mock.results[0]!.value;
    const updateValues = updateChain.set.mock.calls[0]![0];
    const auditChain = vi.mocked(db.insert).mock.results[0]!.value;
    const auditValues = auditChain.values.mock.calls[0]![0];

    expect(parsed).toEqual({ elevationRequestId: REQUEST_ID, status: 'revoked' });
    expect(updateValues).toMatchObject({
      status: 'revoked',
      revokedByUserId: 'user-1',
      revokedReason: 'No longer needed',
    });
    expect(auditValues).toMatchObject({
      orgId: ORG_ID,
      elevationRequestId: REQUEST_ID,
      eventType: 'revoked',
      actor: 'system',
      actorUserId: 'user-1',
      details: { reason: 'No longer needed', triggerSource: 'brain' },
    });
    expect(publishEvent).toHaveBeenCalledWith(
      'elevation.revoked',
      ORG_ID,
      expect.objectContaining({
        elevationRequestId: REQUEST_ID,
        deviceId: DEVICE_ID,
        flowType: 'tech_jit_admin',
        status: 'revoked',
        triggerSource: 'brain',
      }),
      'brain',
    );
  });

  it.each(['pending', 'denied', 'expired'])('refuses to revoke a %s elevation request', async (status) => {
    mockSelectSequence([[{ id: REQUEST_ID, orgId: ORG_ID, deviceId: DEVICE_ID, flowType: 'tech_jit_admin', status }]]);
    vi.mocked(db.update).mockImplementation(() => createUpdateChain([]) as any);

    const result = await toolMap.get('revoke_elevation')!.handler(
      { elevationRequestId: REQUEST_ID, reason: 'No longer needed' },
      makeAuth(),
    );
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain(`current status: ${status}`);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('refuses to revoke a request whose site is outside the caller allowlist', async () => {
    mockSelectSequence([[{ id: REQUEST_ID, orgId: ORG_ID, siteId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', deviceId: DEVICE_ID, flowType: 'tech_jit_admin', status: 'approved' }]]);
    vi.mocked(db.update).mockImplementation(() => createUpdateChain([{ id: REQUEST_ID }]) as any);

    const result = await toolMap.get('revoke_elevation')!.handler(
      { elevationRequestId: REQUEST_ID, reason: 'No longer needed' },
      makeAuth(),
    );
    const parsed = JSON.parse(result);

    expect(parsed.error).toContain('not found or access denied');
    expect(db.update).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('honors orgCondition while revoking elevation requests', async () => {
    mockSelectSequence([[{ id: REQUEST_ID, orgId: ORG_ID, deviceId: DEVICE_ID, flowType: 'tech_jit_admin', status: 'approved' }]]);
    vi.mocked(db.update).mockImplementation(() => createUpdateChain([{ id: REQUEST_ID }]) as any);
    const auth = makeAuth();

    await toolMap.get('revoke_elevation')!.handler(
      { elevationRequestId: REQUEST_ID, reason: 'No longer needed' },
      auth,
    );

    expect(auth.orgCondition).toHaveBeenCalled();
  });

  it('returns compact history rows with filters and limit clamp', async () => {
    const requestedAt = new Date('2026-06-11T00:00:00.000Z');
    mockSelectSequence([[
      {
        id: REQUEST_ID,
        deviceId: DEVICE_ID,
        status: 'pending',
        flowType: 'tech_jit_admin',
        subjectUsername: 'localadmin',
        reason: 'Install driver',
        requestedAt,
        approvedAt: null,
        expiresAt: null,
        revokedAt: null,
        denialReason: null,
        revokedReason: null,
        metadata: { triggerSource: 'brain' },
      },
    ]]);
    const auth = makeAuth();

    const result = await toolMap.get('get_elevation_history')!.handler(
      { deviceId: DEVICE_ID, status: 'pending', flowType: 'tech_jit_admin', limit: 500 },
      auth,
    );
    const parsed = JSON.parse(result);
    const selectChain = vi.mocked(db.select).mock.results[0]!.value;

    expect(parsed).toEqual([
      expect.objectContaining({
        elevationRequestId: REQUEST_ID,
        deviceId: DEVICE_ID,
        status: 'pending',
        flowType: 'tech_jit_admin',
        subjectUsername: 'localadmin',
        requestedAt: requestedAt.toISOString(),
      }),
    ]);
    expect(selectChain.limit).toHaveBeenCalledWith(100);
    expect(auth.orgCondition).toHaveBeenCalled();
  });

  it('safeHandler returns error JSON when the handler throws', async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await toolMap.get('get_elevation_history')!.handler({}, makeAuth());
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({ error: 'Operation failed. Check server logs for details.' });
  });
});
