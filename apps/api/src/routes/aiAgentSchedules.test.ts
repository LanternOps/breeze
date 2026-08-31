import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  hasPermMock,
  mfaOkMock,
  listSchedulesMock,
  createScheduleMock,
  updateScheduleMock,
  deleteScheduleMock,
  writeRouteAuditMock,
} = vi.hoisted(() => ({
  hasPermMock: vi.fn<(resource: string, action: string) => boolean>(() => true),
  mfaOkMock: vi.fn(() => true),
  listSchedulesMock: vi.fn(),
  createScheduleMock: vi.fn(),
  updateScheduleMock: vi.fn(),
  deleteScheduleMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => async (c: { json: (body: unknown, status: number) => Response }, next: () => Promise<void>) => (
    mfaOkMock() ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)
  ),
  requirePermission: (resource: string, action: string) => async (
    c: { json: (body: unknown, status: number) => Response },
    next: () => Promise<void>,
  ) => (
    hasPermMock(resource, action) ? next() : c.json({ error: 'Permission denied' }, 403)
  ),
}));

// The service has its own full unit suite (scheduleService.test.ts) against a
// mocked db; mocked here so this file exercises only routing, validation, auth
// and error mapping — same isolation as runService in aiAgents.test.ts.
const { ScheduleValidationError } = vi.hoisted(() => ({
  ScheduleValidationError: class ScheduleValidationError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = 'ScheduleValidationError';
    }
  },
}));

vi.mock('../services/aiAgents/scheduleService', () => ({
  ScheduleValidationError,
  listSchedules: listSchedulesMock,
  createSchedule: createScheduleMock,
  updateSchedule: updateScheduleMock,
  deleteSchedule: deleteScheduleMock,
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: writeRouteAuditMock,
}));

import { PartnerWideWriteDeniedError } from '../services/partnerWideAccess';
import { AgentAccessDeniedError } from '../services/aiAgents/access';
import { aiAgentSchedulesRoutes } from './aiAgentSchedules';

const PARTNER_ID = '55555555-5555-4555-8555-555555555555';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const SCHEDULE_ID = '22222222-2222-4222-8222-222222222222';
const BASELINE_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '77777777-7777-4777-8777-777777777777';

function scheduleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SCHEDULE_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    agentId: AGENT_ID,
    baselineScheduleId: null,
    kind: 'sweep',
    cron: '0 6 * * *',
    timezone: 'Europe/Berlin',
    sweepKinds: ['disk_pressure'],
    enabled: true,
    lastEnqueuedAt: null,
    lastOccurrenceKey: null,
    lastRunSummary: null,
    createdBy: USER_ID,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-02T00:00:00Z'),
    ...overrides,
  };
}

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      principal: { kind: 'user_session' },
      scope: 'partner',
      orgId: null,
      partnerId: PARTNER_ID,
      partnerOrgAccess: 'all',
      accessibleOrgIds: [ORG_ID],
      user: { id: USER_ID, email: 'tech@example.com', name: 'Tech' },
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    } as never);
    await next();
  });
  app.route('/ai/agents/schedules', aiAgentSchedulesRoutes);
  return app;
}

function post(body: unknown) {
  return buildApp().request('/ai/agents/schedules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patch(body: unknown, id = SCHEDULE_ID) {
  return buildApp().request(`/ai/agents/schedules/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const PARTNER_BODY = {
  ownerScope: 'partner',
  agentId: AGENT_ID,
  cron: '0 6 * * *',
  timezone: 'Europe/Berlin',
  sweepKinds: ['disk_pressure'],
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  hasPermMock.mockReturnValue(true);
  mfaOkMock.mockReturnValue(true);
  listSchedulesMock.mockResolvedValue([]);
  createScheduleMock.mockResolvedValue(scheduleRow());
  updateScheduleMock.mockResolvedValue(scheduleRow({ enabled: false }));
  deleteScheduleMock.mockResolvedValue(undefined);
});

describe('GET /ai/agents/schedules', () => {
  it('returns the effective schedules and forwards both filters', async () => {
    listSchedulesMock.mockResolvedValue([
      { id: SCHEDULE_ID, ownerScope: 'partner', effective: { enabled: true, sweepKinds: [] }, override: null },
    ]);

    const res = await buildApp().request(`/ai/agents/schedules?agentId=${AGENT_ID}&orgId=${ORG_ID}`);

    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(1);
    expect(listSchedulesMock).toHaveBeenCalledWith(
      expect.anything(),
      { agentId: AGENT_ID, orgId: ORG_ID },
    );
  });

  it('requires the ai_agents:read permission', async () => {
    hasPermMock.mockImplementation((resource, action) => !(resource === 'ai_agents' && action === 'read'));

    const res = await buildApp().request('/ai/agents/schedules');

    expect(res.status).toBe(403);
    expect(hasPermMock).toHaveBeenCalledWith('ai_agents', 'read');
    expect(listSchedulesMock).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid filter rather than passing it to a query', async () => {
    const res = await buildApp().request('/ai/agents/schedules?agentId=not-a-uuid');

    expect(res.status).toBe(400);
    expect(listSchedulesMock).not.toHaveBeenCalled();
  });
});

describe('POST /ai/agents/schedules', () => {
  it('creates a partner baseline and returns 201 with the DTO', async () => {
    const res = await post(PARTNER_BODY);

    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({
      id: SCHEDULE_ID,
      ownerScope: 'partner',
      partnerId: PARTNER_ID,
      orgId: null,
      cron: '0 6 * * *',
      // P2-3: the DTO is what the web page branches on to decide whether a
      // sweep-kind selector applies at all. An omitted body field still
      // parses to 'sweep' (the schema default), so this is also the proof
      // that a pre-P2-3 create is unchanged end to end.
      kind: 'sweep',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    expect(createScheduleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerScope: 'partner', agentId: AGENT_ID, kind: 'sweep' }),
    );
    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
    expect(writeRouteAuditMock.mock.calls[0]![1]).toMatchObject({
      action: 'ai_agent.schedule.created',
      details: expect.objectContaining({ kind: 'sweep' }),
    });
  });

  it('creates an org override and returns 201', async () => {
    createScheduleMock.mockResolvedValue(scheduleRow({
      orgId: ORG_ID,
      partnerId: null,
      baselineScheduleId: BASELINE_ID,
    }));

    const res = await post({
      ownerScope: 'organization',
      orgId: ORG_ID,
      baselineScheduleId: BASELINE_ID,
      enabled: true,
      sweepKinds: ['disk_pressure'],
    });

    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({
      ownerScope: 'organization',
      orgId: ORG_ID,
      baselineScheduleId: BASELINE_ID,
    });
  });

  it('creates a narrative baseline and returns its kind on the DTO', async () => {
    createScheduleMock.mockResolvedValue(scheduleRow({
      kind: 'narrative',
      sweepKinds: [],
      cron: '0 7 * * 1',
    }));

    const res = await post({
      ...PARTNER_BODY,
      kind: 'narrative',
      cron: '0 7 * * 1',
      sweepKinds: [],
    });

    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ kind: 'narrative', sweepKinds: [], cron: '0 7 * * 1' });
    expect(createScheduleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'narrative', sweepKinds: [] }),
    );
    expect(writeRouteAuditMock.mock.calls[0]![1]).toMatchObject({
      details: expect.objectContaining({ kind: 'narrative' }),
    });
  });

  it('rejects a narrative baseline on a non-weekly cron with 400, before the service is called', async () => {
    // The shared schema's superRefine, not the service: a daily cron would
    // mail seven overlapping "weekly" reports.
    const res = await post({ ...PARTNER_BODY, kind: 'narrative', cron: '0 6 * * *', sweepKinds: [] });

    expect(res.status).toBe(400);
    expect(createScheduleMock).not.toHaveBeenCalled();
  });

  it('rejects a narrative baseline that carries sweep kinds with 400', async () => {
    const res = await post({
      ...PARTNER_BODY, kind: 'narrative', cron: '0 7 * * 1', sweepKinds: ['disk_pressure'],
    });

    expect(res.status).toBe(400);
    expect(createScheduleMock).not.toHaveBeenCalled();
  });

  it('refuses a client-supplied kind on an ORG override (strict schema, 400)', async () => {
    // An override INHERITS its baseline's kind; a body that could set one
    // would let a single org flip a sweep schedule into a narrative one.
    const res = await post({
      ownerScope: 'organization',
      orgId: ORG_ID,
      baselineScheduleId: BASELINE_ID,
      enabled: true,
      sweepKinds: [],
      kind: 'narrative',
    });

    expect(res.status).toBe(400);
    expect(createScheduleMock).not.toHaveBeenCalled();
  });

  it('rejects a 6-field cron with 400 before the service is called', async () => {
    const res = await post({ ...PARTNER_BODY, cron: '0 0 6 * * *' });

    expect(res.status).toBe(400);
    expect(createScheduleMock).not.toHaveBeenCalled();
  });

  it('maps a ScheduleValidationError to 422 naming the code', async () => {
    createScheduleMock.mockRejectedValue(new ScheduleValidationError('kinds_not_subset', 'nope'));

    const res = await post(PARTNER_BODY);

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'kinds_not_subset' });
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('maps a partner-wide write denial to 403', async () => {
    createScheduleMock.mockRejectedValue(new PartnerWideWriteDeniedError());

    const res = await post(PARTNER_BODY);

    expect(res.status).toBe(403);
  });

  it('maps an ai_agent principal denial to 403', async () => {
    createScheduleMock.mockRejectedValue(new AgentAccessDeniedError('AI agents cannot manage agents'));

    const res = await post(PARTNER_BODY);

    expect(res.status).toBe(403);
  });

  // Error-shape fixtures copied from utils/pgErrors.test.ts. The DRIZZLE shape
  // is the one production actually throws: drizzle wraps every driver error in
  // a DrizzleQueryError whose own `.code` is undefined, with the real
  // PostgresError on `.cause`. A hand-rolled `err.code === '23505'` check
  // matches none of them and 500s on a duplicate override — which is exactly
  // the bug this fixture exists to catch.
  const pgUniqueErr = (constraint: string) => Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    { code: '23505', constraint_name: constraint },
  );
  const drizzleWrap = (cause: unknown) => Object.assign(
    new Error('Failed query: insert into "ai_agent_schedules" ...'),
    { cause },
  );

  const overrideBody = {
    ownerScope: 'organization',
    orgId: ORG_ID,
    baselineScheduleId: BASELINE_ID,
    enabled: true,
    sweepKinds: ['disk_pressure'],
  };

  it.each([
    ['a DrizzleQueryError-wrapped 23505 (the shape production throws)',
      () => drizzleWrap(pgUniqueErr('ai_agent_schedules_org_baseline_uq'))],
    ['a bare PostgresError 23505',
      () => pgUniqueErr('ai_agent_schedules_org_baseline_uq')],
  ])('maps %s to 409 override_exists, not a 500', async (_name, makeError) => {
    createScheduleMock.mockRejectedValue(makeError());

    const res = await post(overrideBody);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'override_exists' });
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it("does NOT mislabel another table's unique violation as a duplicate override", async () => {
    // Naming the constraint is what keeps an unrelated 23505 propagating to the
    // global error handler instead of being reported as `override_exists`.
    createScheduleMock.mockRejectedValue(drizzleWrap(pgUniqueErr('ai_agents_partner_kind_uq')));

    const res = await post(overrideBody);

    // Propagated to the global error handler (plain-text 500 body here, since
    // this harness mounts no onError) rather than answered as a conflict.
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('override_exists');
  });

  it('requires ai_agents:write and MFA', async () => {
    hasPermMock.mockImplementation((resource, action) => !(resource === 'ai_agents' && action === 'write'));
    expect((await post(PARTNER_BODY)).status).toBe(403);
    expect(createScheduleMock).not.toHaveBeenCalled();

    hasPermMock.mockReturnValue(true);
    mfaOkMock.mockReturnValue(false);
    expect((await post(PARTNER_BODY)).status).toBe(403);
    expect(createScheduleMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /ai/agents/schedules/:id', () => {
  it('updates and returns 200', async () => {
    const res = await patch({ enabled: false });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ id: SCHEDULE_ID, enabled: false });
    expect(updateScheduleMock).toHaveBeenCalledWith(expect.anything(), SCHEDULE_ID, { enabled: false });
    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-uuid id before it can reach a query', async () => {
    const res = await patch({ enabled: false }, 'not-a-uuid');

    expect(res.status).toBe(404);
    expect(updateScheduleMock).not.toHaveBeenCalled();
  });

  it('maps a ScheduleValidationError to 422', async () => {
    updateScheduleMock.mockRejectedValue(new ScheduleValidationError('invalid_cron', 'nope'));

    const res = await patch({ cron: '0 7 * * *' });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'invalid_cron' });
  });

  it('maps an org token patching a partner baseline to 403', async () => {
    updateScheduleMock.mockRejectedValue(new PartnerWideWriteDeniedError());

    const res = await patch({ enabled: false });

    expect(res.status).toBe(403);
  });

  it('rejects an unknown field rather than silently dropping it', async () => {
    const res = await patch({ ownerScope: 'partner' });

    expect(res.status).toBe(400);
    expect(updateScheduleMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /ai/agents/schedules/:id', () => {
  it('deletes and returns 204', async () => {
    const res = await buildApp().request(`/ai/agents/schedules/${SCHEDULE_ID}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(deleteScheduleMock).toHaveBeenCalledWith(expect.anything(), SCHEDULE_ID);
    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
  });

  it('does not answer 204 or audit success when the delete removed nothing', async () => {
    deleteScheduleMock.mockRejectedValue(new AgentAccessDeniedError('Schedule not found'));

    const res = await buildApp().request(`/ai/agents/schedules/${SCHEDULE_ID}`, { method: 'DELETE' });

    expect(res.status).toBe(403);
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('maps a partner-wide delete denial to 403', async () => {
    deleteScheduleMock.mockRejectedValue(new PartnerWideWriteDeniedError());

    const res = await buildApp().request(`/ai/agents/schedules/${SCHEDULE_ID}`, { method: 'DELETE' });

    expect(res.status).toBe(403);
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });
});

describe('mount order', () => {
  it('mounts /ai/agents/schedules BEFORE /ai/agents so /schedules is not eaten by /:id', () => {
    const source = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
    const schedules = source.indexOf("api.route('/ai/agents/schedules'");
    const agents = source.indexOf("api.route('/ai/agents',");

    expect(schedules).toBeGreaterThan(-1);
    expect(agents).toBeGreaterThan(-1);
    expect(schedules).toBeLessThan(agents);
  });
});
