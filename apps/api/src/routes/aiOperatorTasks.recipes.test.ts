/**
 * The Recipe Library routes (W06 R1a Task 13): `GET /workflows`,
 * `POST /task-drafts`, and `POST /tasks` for `identity_offboarding`.
 *
 * A sibling of `aiOperatorTasks.test.ts` rather than an append to it: that
 * file's harness mocks `taskService` with `admitServiceRecoveryTask` alone and
 * is kept byte-for-byte, so the service-recovery route cases it pins are the
 * untouched proof that the shipped body still admits unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  inserts: 0,
  admitTask: vi.fn(),
  admitServiceRecoveryTask: vi.fn(),
  listWorkflowReadiness: vi.fn(),
  resolveEffectiveAgent: vi.fn(),
  tasksEnabled: true,
  recipeOn: true,
  permissions: [] as Array<{ resource: string; action: string }>,
  // `resource:action` gates the mocked requirePermission refuses with a 403.
  deniedGates: [] as string[],
  wheres: [] as unknown[],
}));

vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  const pass = async (_c: unknown, next: () => Promise<void>) => next();
  return {
    authMiddleware: pass, requireScope: () => pass,
    requirePermission: (resource: string, action: string) => async (c: any, next: () => Promise<void>) => {
      if (h.deniedGates.includes(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
      return next();
    },
    requireMfa: () => pass,
    buildOrgAccessClosures: actual.buildOrgAccessClosures,
  };
});
vi.mock('../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aiOperatorTasksEnabled: () => h.tasksEnabled,
  aiOperatorServiceRecoveryEnabled: () => true,
}));
vi.mock('../services/aiOperator/taskService', () => ({
  admitServiceRecoveryTask: (i: unknown) => h.admitServiceRecoveryTask(i),
  admitTask: (i: unknown) => h.admitTask(i),
  recipeEnabled: () => h.tasksEnabled && h.recipeOn,
}));
vi.mock('../services/aiOperator/recipeReadiness', async (orig) => ({
  ...(await orig<typeof import('../services/aiOperator/recipeReadiness')>()),
  listWorkflowReadiness: (...a: unknown[]) => h.listWorkflowReadiness(...a),
}));
vi.mock('../services/aiAgents/effectivePolicy', () => ({
  resolveEffectiveAgent: (...a: unknown[]) => h.resolveEffectiveAgent(...a),
}));
vi.mock('../db', () => {
  const chain = () => {
    const c: any = {
      from: () => c, where: (w: unknown) => { h.wheres.push(w); return c; }, leftJoin: () => c, orderBy: () => c, $dynamic: () => c,
      limit: () => c,
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(h.selectQueue.shift() ?? []).then(res, rej),
    };
    return c;
  };
  return {
    db: {
      select: () => chain(),
      insert: () => { h.inserts += 1; throw new Error('a draft or a route pre-check must not write'); },
      update: () => { h.inserts += 1; throw new Error('must not write'); },
    },
  };
});

import { aiOperatorTasksRoutes } from './aiOperatorTasks';
import { computeRecipeReadiness } from '../services/aiOperator/recipeReadiness';
import { RECIPES } from '../services/aiOperator/recipes';
import { IDENTITY_OFFBOARDING_EFFECT_TOOLS } from '../services/aiOperator/recipes/identityOffboarding';

const ORG = '33333333-3333-4333-8333-333333333333';
const CONTACT = '77777777-7777-4777-8777-777777777777';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const AGENT = '11111111-1111-4111-8111-111111111111';

function app(authOverrides: Record<string, unknown> = {}) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization', orgId: ORG, partnerId: null, accessibleOrgIds: [ORG],
      user: { id: 'user-1', email: 't@example.com', name: 'Tech' },
      canAccessOrg: (id: string) => id === ORG, orgCondition: () => undefined,
      allowedSiteIds: undefined, canAccessSite: () => true, ...authOverrides,
    } as never);
    // What requireAiWrite stores after resolving the caller's grants.
    c.set('permissions', { permissions: h.permissions } as never);
    await next();
  });
  a.route('/ai/operator', aiOperatorTasksRoutes);
  return a;
}

const readyIdentity = () => computeRecipeReadiness(RECIPES.identity_offboarding!, {
  orgId: ORG, m365: null, google: { status: 'active', lastVerifiedAt: null },
  agent: { id: AGENT, kind: 'helpdesk', toolAllowlist: [...IDENTITY_OFFBOARDING_EFFECT_TOOLS] }, flagEnabled: true,
});
const readySr = () => computeRecipeReadiness(RECIPES.service_recovery!, {
  orgId: ORG, m365: null, google: null, agent: null, flagEnabled: true,
});

const body = (over: Record<string, unknown> = {}) => ({
  mode: 'live', recipeKey: 'identity_offboarding', recipeVersion: 1, orgId: ORG,
  inputs: { contactId: CONTACT }, clientIdempotencyKey: 'abcdefgh-r1a', ...over,
});
const dialect = new PgDialect();
const render = (w: unknown) => dialect.sqlToQuery(w as SQL);
const post = (path: string, b: unknown, a = app()) =>
  a.request(`/ai/operator${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue = [];
  h.inserts = 0;
  h.deniedGates = [];
  h.wheres = [];
  h.tasksEnabled = true;
  h.recipeOn = true;
  h.permissions = [{ resource: 'organizations', action: 'write' }, { resource: 'organizations', action: 'read' }];
  h.listWorkflowReadiness.mockResolvedValue([readyIdentity(), readySr()]);
  h.resolveEffectiveAgent.mockResolvedValue({ agentId: AGENT, effective: { enabled: true } });
  h.admitTask.mockResolvedValue({ ok: true, taskId: 'task-new', replayed: false });
});

describe('GET /workflows', () => {
  it('1. returns both recipes with a readiness state each', async () => {
    const res = await app().request(`/ai/operator/workflows?orgId=${ORG}`);
    expect(res.status).toBe(200);
    const json = await res.json() as { data: Array<{ recipeKey: string; readiness: string; name: string }> };
    expect(json.data.map((w) => w.recipeKey)).toEqual(['identity_offboarding', 'service_recovery']);
    for (const w of json.data) expect(['ready', 'setup_required', 'unavailable']).toContain(w.readiness);
    expect(json.data[0]!.name).toBe('Offboard a person');
  });

  it('2. an org the caller cannot access is a non-enumerating 404, computed for nothing', async () => {
    const res = await app().request('/ai/operator/workflows?orgId=44444444-4444-4444-8444-444444444444');
    expect(res.status).toBe(404);
    expect(h.listWorkflowReadiness).not.toHaveBeenCalled();
  });

  it('3. sends no cache header and recomputes on every call', async () => {
    const r1 = await app().request(`/ai/operator/workflows?orgId=${ORG}`);
    await app().request(`/ai/operator/workflows?orgId=${ORG}`);
    expect(r1.headers.get('etag')).toBeNull();
    expect(r1.headers.get('cache-control')).toBeNull();
    expect(h.listWorkflowReadiness).toHaveBeenCalledTimes(2);
  });
});

describe('POST /task-drafts', () => {
  it('4. returns the would-be effect tools and manual items and WRITES NOTHING', async () => {
    h.selectQueue = [[{ id: CONTACT, name: 'Dana Ruiz', email: 'dana@customer.example' }]];
    const res = await post('/task-drafts', { recipeKey: 'identity_offboarding', recipeVersion: 1, orgId: ORG, inputs: { contactId: CONTACT } });
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: Record<string, any> };
    expect(data.person.resolved).toMatchObject({ id: CONTACT });
    expect(data.plannedEffectTools).toContain('google_suspend_user');
    expect(data.plannedEffectTools).not.toContain('google_wipe_mobile_device');
    // M365 is not connected in this org → its tools are degraded, not planned.
    expect(data.degradedEffectTools).toContain('m365_disable_user');
    expect(data.manualWork.map((m: { key: string }) => m.key)).toContain('collect_hardware');
    expect(h.inserts).toBe(0);
    expect(h.admitTask).not.toHaveBeenCalled();
  });

  it('5. an unresolvable person returns the CANDIDATES, not an error', async () => {
    h.selectQueue = [[{ id: CONTACT, name: 'Dana Ruiz', email: null }, { id: 'x', name: 'Dana Smith', email: null }]];
    const res = await post('/task-drafts', { recipeKey: 'identity_offboarding', recipeVersion: 1, orgId: ORG, inputs: { personHint: 'Dana' } });
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: Record<string, any> };
    expect(data.person.resolved).toBeNull();
    expect(data.person.candidates.map((c: { name: string }) => c.name)).toEqual(['Dana Ruiz', 'Dana Smith']);
  });

  it('drafts refuse a site-restricted caller, a disabled recipe and a too-short hint BEFORE reading any contact', async () => {
    const d = { recipeKey: 'identity_offboarding', recipeVersion: 1, orgId: ORG, inputs: { personHint: 'Dana' } };
    expect((await post('/task-drafts', d, app({ allowedSiteIds: ['s1'] }))).status).toBe(403);
    h.recipeOn = false;
    expect((await post('/task-drafts', d)).status).toBe(422);
    h.recipeOn = true;
    expect((await post('/task-drafts', { ...d, inputs: { personHint: ' D ' } })).status).toBe(400);
    // A sentinel row is seeded: any contact read would shift it off the queue
    // and record a where clause, so both stay untouched only if the gates refuse first.
    h.selectQueue = [[{ id: CONTACT, name: 'Dana Ruiz', email: null }]];
    h.wheres = [];
    expect((await post('/task-drafts', d, app({ allowedSiteIds: ['s1'] }))).status).toBe(403);
    h.recipeOn = false;
    expect((await post('/task-drafts', d)).status).toBe(422);
    h.recipeOn = true;
    expect((await post('/task-drafts', { ...d, inputs: { personHint: ' D ' } })).status).toBe(400);
    expect(h.selectQueue).toHaveLength(1);
    expect(h.wheres).toEqual([]);
  });

  it('drafts require organizations:read: 403 without it, and no contact is read', async () => {
    h.deniedGates = ['organizations:read'];
    h.selectQueue = [[{ id: CONTACT, name: 'Dana Ruiz', email: null }]];
    const res = await post('/task-drafts', { recipeKey: 'identity_offboarding', recipeVersion: 1, orgId: ORG, inputs: { contactId: CONTACT } });
    expect(res.status).toBe(403);
    expect(h.selectQueue).toHaveLength(1);
    expect(h.wheres).toEqual([]);
    h.deniedGates = [];
    expect((await post('/task-drafts', { recipeKey: 'identity_offboarding', recipeVersion: 1, orgId: ORG, inputs: { contactId: CONTACT } })).status).toBe(200);
  });

  it('draftPerson reads carry the org_id predicate: contactId, email hint and name hint', async () => {
    const d = (inputs: Record<string, unknown>) => ({ recipeKey: 'identity_offboarding', recipeVersion: 1, orgId: ORG, inputs });
    for (const [inputs, extra] of [
      [{ contactId: CONTACT }, CONTACT],
      [{ personHint: 'dana@customer.example' }, 'dana@customer.example'],
      [{ personHint: 'Dana' }, '%Dana%'],
    ] as const) {
      h.wheres = [];
      h.selectQueue = [[]];
      expect((await post('/task-drafts', d(inputs))).status).toBe(200);
      expect(h.wheres).toHaveLength(1);
      const q = render(h.wheres[0]);
      expect(q.sql).toMatch(/"org_id" = \$\d/);
      expect(q.params).toContain(ORG);
      expect(q.params).toContain(extra);
    }
  });

  it('"resolved" uses the exact-name rule admission does, not a lone substring hit', async () => {
    const d = (personHint: string) => ({ recipeKey: 'identity_offboarding', recipeVersion: 1, orgId: ORG, inputs: { personHint } });
    h.selectQueue = [[{ id: 'x', name: 'Dana Smith', email: null }]];
    let { data } = await (await post('/task-drafts', d('Dan'))).json() as { data: Record<string, any> };
    expect(data.person.resolved).toBeNull();
    expect(data.person.candidates).toHaveLength(1);
    h.selectQueue = [[{ id: 'x', name: 'Dana Smith', email: null }]];
    ({ data } = await (await post('/task-drafts', d('dana smith '))).json() as { data: Record<string, any> });
    expect(data.person.resolved).toMatchObject({ id: 'x', name: 'Dana Smith' });
  });

  it('an unknown key is a 400 naming both supported workflows; bad inputs are a 400', async () => {
    const unknown = await post('/task-drafts', { recipeKey: 'no_such_recipe', recipeVersion: 1, orgId: ORG, inputs: {} });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { supportedRecipeKeys: string[] }).supportedRecipeKeys).toEqual(['identity_offboarding', 'service_recovery']);
    const bad = await post('/task-drafts', { recipeKey: 'identity_offboarding', recipeVersion: 1, orgId: ORG, inputs: { contactId: CONTACT, personHint: 'x' } });
    expect(bad.status).toBe(400);
  });
});

describe('POST /tasks — identity_offboarding', () => {
  it('6. a device-less identity body admits through admitTask with the helpdesk agent', async () => {
    h.selectQueue = [[{ id: CONTACT, name: 'Dana Ruiz', email: 'dana@customer.example' }]];
    const res = await post('/tasks', body());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ taskId: 'task-new', replayed: false });
    expect(h.resolveEffectiveAgent).toHaveBeenCalledWith(expect.anything(), ORG, 'helpdesk');
    expect(h.admitTask).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, agentId: AGENT, workflowKey: 'identity_offboarding', workflowVersion: 1,
      objective: 'Offboard Dana Ruiz', requesterUserId: 'user-1', clientIdempotencyKey: 'abcdefgh-r1a',
      recipeInput: expect.objectContaining({ contactId: CONTACT }),
    }));
    expect(h.admitServiceRecoveryTask).not.toHaveBeenCalled();
  });

  it('8. duplicate_live_task → 409 with the existing task id', async () => {
    h.selectQueue = [[{ id: CONTACT, name: 'Dana', email: null }]];
    h.admitTask.mockResolvedValue({ ok: false, refusal: 'duplicate_live_task', detail: 'live', existingTaskId: 'task-live' });
    const res = await post('/tasks', body());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'OPERATOR_DUPLICATE_LIVE_TASK', taskId: 'task-live' });
  });

  it('9. a contact not visible in the org is a 404 that does not say whether it exists elsewhere', async () => {
    h.selectQueue = [[]];
    const res = await post('/tasks', body());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Contact not found' });
    expect(h.admitTask).not.toHaveBeenCalled();
    h.selectQueue = [[{ id: CONTACT, name: 'Dana', email: null }]];
    h.admitTask.mockResolvedValue({ ok: false, refusal: 'contact_not_in_org', detail: 'contact x is in org y' });
    const refused = await post('/tasks', body());
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: 'Contact not found' });
  });

  it('without organizations:write the identity admission is refused', async () => {
    h.permissions = [{ resource: 'organizations', action: 'read' }];
    const res = await post('/tasks', body());
    expect(res.status).toBe(403);
    expect(h.admitTask).not.toHaveBeenCalled();
  });

  it('a site-restricted caller is refused before anything is read or admitted', async () => {
    const res = await post('/tasks', body(), app({ allowedSiteIds: ['s1'] }));
    expect(res.status).toBe(403);
    expect(h.admitTask).not.toHaveBeenCalled();
  });

  it('flag off → 422 OPERATOR_RECIPE_DISABLED; no helpdesk agent → 422 OPERATOR_NO_AGENT', async () => {
    h.recipeOn = false;
    expect((await post('/tasks', body())).status).toBe(422);
    h.recipeOn = true;
    h.selectQueue = [[{ id: CONTACT, name: 'Dana', email: null }]];
    h.resolveEffectiveAgent.mockResolvedValue(null);
    const res = await post('/tasks', body());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'OPERATOR_NO_AGENT' });
  });

  it('rejects a deviceId or a strict-input violation with 400, and an invisible selected device with 404', async () => {
    expect((await post('/tasks', body({ deviceId: DEVICE }))).status).toBe(400);
    expect((await post('/tasks', body({ inputs: { contactId: CONTACT, skipConfirmIdentity: true } }))).status).toBe(400);
    h.selectQueue = [[{ id: CONTACT, name: 'Dana', email: null }], []];
    expect((await post('/tasks', body({ inputs: { contactId: CONTACT, deviceIds: [DEVICE] } }))).status).toBe(404);
    expect(h.admitTask).not.toHaveBeenCalled();
  });

  it('10. an unknown recipe key still goes the shipped path: 400 naming both supported keys', async () => {
    h.selectQueue = [[{ id: DEVICE, orgId: ORG, siteId: 's', hostname: 'WIN-1' }]];
    const res = await post('/tasks', body({ recipeKey: 'no_such_recipe', deviceId: DEVICE, inputs: { serviceName: 'spooler' } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { supportedRecipeKeys: string[] }).supportedRecipeKeys).toEqual(['identity_offboarding', 'service_recovery']);
  });
});

describe('POST /tasks — the contact visibility read is org-predicated', () => {
  it('the identity_offboarding contactId read constrains org_id to the body orgId', async () => {
    h.selectQueue = [[{ id: CONTACT, name: 'Dana', email: null }]];
    await post('/tasks', body());
    expect(h.wheres.length).toBeGreaterThanOrEqual(1);
    const q = render(h.wheres[0]);
    expect(q.sql).toMatch(/"org_id" = \$\d/);
    expect(q.params).toContain(ORG);
    expect(q.params).toContain(CONTACT);
  });
});

// Observed once from the shipped route: formatZodError of the pre-R1a schema's error.
const HARDCODED_UNRECOGNIZED = {
  error: 'inputs: Unrecognized key: "extra"',
  details: { formErrors: [], fieldErrors: { inputs: ['Unrecognized key: "extra"'] } },
};

describe('POST /tasks — service_recovery strict fields are restored', () => {
  // The pre-R1a validator, defined inline: the shipped 400 body is whatever
  // formatZodError makes of THIS schema's error.
  const preR1a = z.object({
    deviceId: z.string().guid(),
    inputs: z.object({ serviceName: z.string().min(1).max(255) }).strict(),
  });
  const srBody = (over: Record<string, unknown> = {}) => ({
    mode: 'live', recipeKey: 'service_recovery', recipeVersion: 1, orgId: ORG, deviceId: DEVICE,
    inputs: { serviceName: 'spooler' }, clientIdempotencyKey: 'abcdefgh-sr', ...over,
  });
  const expected = async (value: unknown) => {
    const { formatZodError } = await import('../lib/validation');
    const r = preR1a.safeParse(value);
    if (r.success) throw new Error('fixture should fail the pre-R1a schema');
    return formatZodError(r.error);
  };

  it('an unknown input key is the shipped 400', async () => {
    const res = await post('/tasks', srBody({ inputs: { serviceName: 'spooler', extra: 1 } }));
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, any>;
    expect(json.error).toContain('Unrecognized key');
    expect(json).toEqual(await expected({ deviceId: DEVICE, inputs: { serviceName: 'spooler', extra: 1 } }));
    expect(json).toEqual(HARDCODED_UNRECOGNIZED);
  });

  it('a missing deviceId is a 400 with fieldErrors.deviceId', async () => {
    const { deviceId: _omit, ...noDevice } = srBody();
    const res = await post('/tasks', noDevice);
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, any>;
    expect(json.details.fieldErrors.deviceId).toBeDefined();
    expect(json).toEqual(await expected({ deviceId: undefined, inputs: { serviceName: 'spooler' } }));
  });

  it('a missing serviceName is a 400, not a 422', async () => {
    const res = await post('/tasks', srBody({ inputs: {} }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(await expected({ deviceId: DEVICE, inputs: {} }));
  });

  it('the 400 happens before the org-access check', async () => {
    const res = await post('/tasks', srBody({ orgId: '44444444-4444-4444-8444-444444444444', inputs: { serviceName: 'spooler', extra: 1 } }));
    expect(res.status).toBe(400);
    const ok = await post('/tasks', srBody({ orgId: '44444444-4444-4444-8444-444444444444' }));
    expect(ok.status).toBe(404);
  });
});
