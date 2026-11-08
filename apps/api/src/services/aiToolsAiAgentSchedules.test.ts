import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const PARTNER = '00000000-0000-4000-8000-0000000000e1';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const BASELINE = '00000000-0000-4000-8000-0000000000b1';
const OVERRIDE = '00000000-0000-4000-8000-0000000000b2';

const h = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), remove: vi.fn(), audit: vi.fn() }));

vi.mock('./aiAgents/scheduleService', async () => {
  class ScheduleValidationError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return { ScheduleValidationError, createSchedule: h.create, updateSchedule: h.update, deleteSchedule: h.remove };
});
vi.mock('./aiToolsSecurityPolicyShared', async () => {
  const actual = await vi.importActual<typeof import('./aiToolsSecurityPolicyShared')>('./aiToolsSecurityPolicyShared');
  return { ...actual, auditToolWrite: h.audit };
});

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { ScheduleValidationError } from './aiAgents/scheduleService';
import { AgentAccessDeniedError, AgentSiteCeilingDeniedError } from './aiAgents/access';
import { PartnerWideWriteDeniedError } from './partnerWideAccess';
import { registerAiAgentScheduleTool } from './aiToolsAiAgentSchedules';
import { aiAgentScheduleToolSchemas } from './aiToolSchemasAiAgentSchedules';
import { validateToolInput } from './aiToolSchemas';

const tools = new Map<string, AiTool>();
registerAiAgentScheduleTool(tools);
const run = (input: Record<string, unknown>, a: AuthContext = auth()) => tools.get('manage_ai_agent_schedules')!.handler(input, a);
const parse = (s: string) => JSON.parse(s) as Record<string, any>;

function auth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    scope: 'partner',
    partnerId: PARTNER,
    partnerOrgAccess: 'all',
    orgId: null,
    accessibleOrgIds: [ORG],
    canAccessOrg: (id: string) => id === ORG,
    user: { id: 'u-1', email: 'tech@example.com', name: 'Tech' },
    token: { mfa: true },
    ...over,
  } as unknown as AuthContext;
}

const row = (over: Record<string, unknown> = {}) => ({
  id: BASELINE,
  orgId: null,
  partnerId: PARTNER,
  agentId: AGENT,
  baselineScheduleId: null,
  kind: 'sweep',
  cron: '0 2 * * *',
  timezone: 'UTC',
  sweepKinds: ['disk_pressure'],
  enabled: true,
  actMode: null,
  lastEnqueuedAt: null,
  lastOccurrenceKey: null,
  lastRunSummary: { orgsTotal: 12, runsAdmitted: 9 },
  createdBy: 'u-1',
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date('2026-11-01T00:00:00Z'),
  ...over,
});

const createBaseline = { action: 'create', ownerScope: 'partner', kind: 'sweep', agentId: AGENT, cron: '0 2 * * *', timezone: 'UTC', sweepKinds: ['disk_pressure'], enabled: true };
const createOverride = { action: 'create', ownerScope: 'organization', orgId: ORG, baselineScheduleId: BASELINE, enabled: false, sweepKinds: [] };

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.create.mockResolvedValue(row());
  h.update.mockResolvedValue(row());
  h.remove.mockResolvedValue(row());
});

describe('schema', () => {
  const schema = aiAgentScheduleToolSchemas.manage_ai_agent_schedules;

  it('never admits actMode: true, on any action', () => {
    expect(schema.safeParse({ action: 'update', scheduleId: BASELINE, actMode: true }).success).toBe(false);
    expect(schema.safeParse({ ...createBaseline, actMode: true }).success).toBe(false);
    expect(schema.safeParse({ action: 'update', scheduleId: BASELINE, actMode: false }).success).toBe(true);
  });

  it('is strict and has no action outside create, update and delete', () => {
    expect(schema.safeParse({ action: 'update', scheduleId: BASELINE, createdBy: 'x' }).success).toBe(false);
    expect(schema.safeParse({ action: 'arm', scheduleId: BASELINE }).success).toBe(false);
    expect(schema.shape.action.options).toEqual(['create', 'update', 'delete']);
  });

  // #11287: validateToolInput (the check MCP and chat run before filing an
  // approval card) refuses a create/update the handler would refuse after a
  // person approved it, using the route's own schema.
  describe('validated before an approval card is filed (#11287)', () => {
    const { enabled: _enabled, ...baselineWithoutEnabled } = createBaseline;
    const { enabled: _off, ...overrideWithoutEnabled } = createOverride;

    it.each([
      ['a partner baseline', baselineWithoutEnabled],
      ['an organization override', overrideWithoutEnabled],
    ])('refuses %s create without enabled, naming the field', (_label, input) => {
      const result = validateToolInput('manage_ai_agent_schedules', input);
      expect(result.success).toBe(false);
      expect(!result.success && result.error).toMatch(/enabled/);
    });

    it('refuses a create the route schema refuses for another reason (baseline without cron)', () => {
      const { cron: _cron, ...noCron } = createBaseline;
      const result = validateToolInput('manage_ai_agent_schedules', noCron);
      expect(result.success).toBe(false);
      expect(!result.success && result.error).toMatch(/cron/);
    });

    it('refuses a create naming actMode, as the handler does', () => {
      const result = validateToolInput('manage_ai_agent_schedules', { ...createBaseline, actMode: false });
      expect(result.success).toBe(false);
      expect(!result.success && result.error).toMatch(/actMode/);
    });

    it('refuses an update the route schema refuses', () => {
      expect(validateToolInput('manage_ai_agent_schedules', { action: 'update', scheduleId: BASELINE, sweepKinds: ['not_a_kind'] }).success).toBe(false);
    });

    it('admits the valid calls unchanged', () => {
      expect(validateToolInput('manage_ai_agent_schedules', createBaseline)).toEqual({ success: true });
      expect(validateToolInput('manage_ai_agent_schedules', createOverride)).toEqual({ success: true });
      expect(validateToolInput('manage_ai_agent_schedules', { action: 'update', scheduleId: BASELINE, enabled: false })).toEqual({ success: true });
      expect(validateToolInput('manage_ai_agent_schedules', { action: 'delete', scheduleId: BASELINE })).toEqual({ success: true });
    });
  });

  it('declares no z.undefined and renders a JSON schema with const false for actMode', () => {
    const body = tools.get('manage_ai_agent_schedules')!.definition.input_schema as { properties: Record<string, { const?: unknown }> };
    expect(body.properties.actMode?.const).toBe(false);
  });
});

describe('refusals before any write', () => {
  it.each([
    ['a site-restricted org session', { scope: 'organization', orgId: ORG, allowedSiteIds: ['s-1'] }],
    ['a site-restricted partner session', { allowedSiteIds: ['s-1'] }],
    ['a device-bound session', { allowedDeviceIds: ['d-1'] }],
  ])('%s is refused for every action', async (_label, over) => {
    for (const input of [createBaseline, { action: 'update', scheduleId: BASELINE, enabled: false }, { action: 'delete', scheduleId: BASELINE }]) {
      const out = parse(await run(input, auth(over as Partial<AuthContext>)));
      expect(out.code).toBe('ACCESS_DENIED');
    }
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('an ai_agent principal is refused', async () => {
    const out = parse(await run(createBaseline, auth({ principal: { kind: 'ai_agent', agentId: AGENT, runId: 'r' } } as never)));
    expect(out.error).toBeTruthy();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('create refuses any actMode, even false (the override path is update)', async () => {
    const out = parse(await run({ ...createOverride, actMode: false }));
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(h.create).not.toHaveBeenCalled();
  });

  it('create takes no scheduleId, update and delete need one', async () => {
    expect(parse(await run({ ...createBaseline, scheduleId: BASELINE })).code).toBe('VALIDATION_ERROR');
    expect(parse(await run({ action: 'update', enabled: false })).code).toBe('VALIDATION_ERROR');
    expect(parse(await run({ action: 'delete' })).code).toBe('VALIDATION_ERROR');
  });

  it('update takes no create fields and must name a change', async () => {
    expect(parse(await run({ action: 'update', scheduleId: BASELINE, agentId: AGENT })).code).toBe('VALIDATION_ERROR');
    expect(parse(await run({ action: 'update', scheduleId: BASELINE })).code).toBe('VALIDATION_ERROR');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('delete takes only scheduleId', async () => {
    expect(parse(await run({ action: 'delete', scheduleId: BASELINE, enabled: false })).code).toBe('VALIDATION_ERROR');
    expect(h.remove).not.toHaveBeenCalled();
  });
});

describe('create', () => {
  it('passes the parsed input, never an actMode, and audits as the route does', async () => {
    const out = parse(await run(createBaseline));
    expect(out).toMatchObject({ id: BASELINE, ownerScope: 'partner', enabled: true });
    expect(h.create.mock.calls[0]![1]).not.toHaveProperty('actMode');
    expect(h.create.mock.calls[0]![1]).toMatchObject({ ownerScope: 'partner', agentId: AGENT });
    expect(h.create.mock.calls[0]![2]).toEqual({ refuseExistingOverride: true });
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![1]).toMatchObject({
      action: 'ai_agent.schedule.created', resourceType: 'ai_agent_schedule', resourceId: BASELINE, orgId: null, partnerId: PARTNER,
      details: expect.objectContaining({ via: 'ai_tool', ownerScope: 'partner', actMode: null, kind: 'sweep' }),
      result: 'success',
    });
  });

  it('never returns the run summary, which aggregates other organizations', async () => {
    const out = parse(await run(createBaseline));
    expect(out).not.toHaveProperty('lastRunSummary');
    expect(out).not.toHaveProperty('createdBy');
  });

  it('creates an override, whose row names its org in the audit', async () => {
    h.create.mockResolvedValue(row({ id: OVERRIDE, orgId: ORG, partnerId: null, baselineScheduleId: BASELINE, enabled: false, sweepKinds: [] }));
    const out = parse(await run(createOverride));
    expect(out).toMatchObject({ id: OVERRIDE, ownerScope: 'organization' });
    expect(h.audit.mock.calls[0]![1]).toMatchObject({ orgId: ORG });
  });
});

describe('update and delete', () => {
  it('update and delete ask the service to refuse an armed widening', async () => {
    await run({ action: 'update', scheduleId: BASELINE, enabled: false });
    expect(h.update).toHaveBeenCalledWith(expect.anything(), BASELINE, { enabled: false }, { refuseArmedWidening: true });
    await run({ action: 'delete', scheduleId: BASELINE });
    expect(h.remove).toHaveBeenCalledWith(expect.anything(), BASELINE, { refuseArmedWidening: true });
  });

  it('update audits what changed and the act-mode value', async () => {
    h.update.mockResolvedValue(row({ actMode: false }));
    await run({ action: 'update', scheduleId: BASELINE, actMode: false });
    expect(h.audit.mock.calls[0]![1]).toMatchObject({
      action: 'ai_agent.schedule.updated',
      details: expect.objectContaining({ via: 'ai_tool', changed: ['actMode'], actMode: false }),
      result: 'success',
    });
  });

  it('delete audits against the row it removed', async () => {
    h.remove.mockResolvedValue(row({ id: OVERRIDE, orgId: ORG, partnerId: null }));
    const out = parse(await run({ action: 'delete', scheduleId: OVERRIDE }));
    expect(out).toEqual({ deleted: true, scheduleId: OVERRIDE });
    expect(h.audit.mock.calls[0]![1]).toMatchObject({ action: 'ai_agent.schedule.deleted', orgId: ORG, resourceId: OVERRIDE });
  });
});

describe('errors are error envelopes with the route codes', () => {
  it.each([
    ['a validation code', new (ScheduleValidationError as never as new (c: string, m: string) => Error)('armed_widening_refused', 'Armed'), 'armed_widening_refused'],
    ['a partner-wide denial', new PartnerWideWriteDeniedError(), 'PARTNER_WIDE_WRITE_DENIED'],
    ['a not-found access denial', new AgentAccessDeniedError('Schedule not found'), 'NOT_FOUND'],
    ['a site ceiling', new AgentSiteCeilingDeniedError(), 'ACCESS_DENIED'],
    ['an existing override', new (ScheduleValidationError as never as new (c: string, m: string) => Error)('override_exists', 'Exists'), 'override_exists'],
  ])('%s', async (_label, error, code) => {
    h.update.mockRejectedValue(error);
    const out = parse(await run({ action: 'update', scheduleId: BASELINE, enabled: true }));
    expect(out.code).toBe(code);
    expect(out.error).toBeTruthy();
    for (const key of ['success', 'data', 'configured']) expect(out).not.toHaveProperty(key);
    expect(h.audit.mock.calls.at(-1)![1]).toMatchObject({ result: 'failure', details: expect.objectContaining({ refused: code }) });
  });

  it('an unknown error does not leak its message', async () => {
    h.create.mockRejectedValue(new Error('connection to 10.0.0.5 refused'));
    const out = parse(await run(createBaseline));
    expect(JSON.stringify(out)).not.toContain('10.0.0.5');
    expect(out.error).toBeTruthy();
  });
});
