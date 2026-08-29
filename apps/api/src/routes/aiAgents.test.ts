import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { AI_AGENT_LIMIT_DEFAULTS, AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS } from '@breeze/shared';

const {
  selectMock,
  hasPermMock,
  mfaOkMock,
  getAgentMock,
  resolveEffectiveAgentMock,
  createAndEnqueueAgentRunMock,
  verifyDeviceAccessMock,
  writeRouteAuditMock,
  getCircuitStateMock,
  resetCircuitMock,
  recordVerdictFeedbackMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  // Explicit generic: vitest infers a zero-arg tuple from a bare `() => true`
  // impl, and `tsc` (not vitest) then rejects both the two-arg call inside the
  // requirePermission mock and the two-arg assertion below.
  hasPermMock: vi.fn<(resource: string, action: string) => boolean>(() => true),
  mfaOkMock: vi.fn(() => true),
  getAgentMock: vi.fn(),
  resolveEffectiveAgentMock: vi.fn(),
  createAndEnqueueAgentRunMock: vi.fn(),
  verifyDeviceAccessMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
  getCircuitStateMock: vi.fn(),
  resetCircuitMock: vi.fn(),
  // Carry-in B (PR-A review, feedback-route hardening) — `recordVerdictFeedback`
  // now returns a discriminated result, not a bare boolean; see
  // `RecordVerdictFeedbackResult` in services/aiAgents/alertVerdicts.ts.
  recordVerdictFeedbackMock: vi.fn<(auth: unknown, verdictId: string, feedback: string) => Promise<
    { status: 'ok'; orgId: string } | { status: 'not_found' } | { status: 'conflict'; orgId: string }
  >>(),
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

const { ActPrerequisitesNotMetError, InvalidSupervisedActionKeysError } = vi.hoisted(() => ({
  ActPrerequisitesNotMetError: class ActPrerequisitesNotMetError extends Error {
    readonly code = 'act_prerequisites_not_met';
    constructor(public missing: string[]) {
      super(`act_prerequisites_not_met: ${missing.join(', ')}`);
    }
  },
  InvalidSupervisedActionKeysError: class InvalidSupervisedActionKeysError extends Error {
    readonly code = 'invalid_supervised_action_keys';
    constructor(public rejected: Array<{ key: string; reason: string }>) {
      super(`invalid_supervised_action_keys: ${rejected.map((r) => r.key).join(', ')}`);
    }
  },
}));

vi.mock('../services/aiAgents/agentService', () => ({
  AgentInvariantError: class AgentInvariantError extends Error {},
  AgentKindConflictError: class AgentKindConflictError extends Error {},
  UnsupportedAgentModeError: class UnsupportedAgentModeError extends Error {},
  ActPrerequisitesNotMetError,
  InvalidSupervisedActionKeysError,
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  disableAgent: vi.fn(),
  listAgents: vi.fn(),
  getAgent: getAgentMock,
}));

vi.mock('../services/aiAgents/runService', () => ({
  createAndEnqueueAgentRun: createAndEnqueueAgentRunMock,
}));

// Wave 6 PR 2 (#3828): agentCircuit.ts has its own full unit coverage in
// agentCircuit.test.ts (classification, threshold, notify/audit). Mocked
// here so these route tests exercise only routing/auth/orgId-resolution —
// consistent with how `createAndEnqueueAgentRun` above is mocked rather than
// re-driven through a real DB.
vi.mock('../services/aiAgents/agentCircuit', () => ({
  getCircuitState: getCircuitStateMock,
  resetCircuit: resetCircuitMock,
}));

// Phase 2 wave P2-1 (alert verdicts), Task 8: `recordVerdictFeedback` has its
// own full unit coverage in alertVerdicts.test.ts — mocked here so this
// route test exercises only routing/auth/validation, matching how
// agentCircuit/runService above are mocked rather than re-driven through db.
// `projectAlertVerdict` is passed through to the REAL implementation
// (importOriginal) — `buildRunTrace` (runTrace.ts) calls it unconditionally
// on every `GET /runs/:runId`, and it has no db/service dependency of its
// own to mock away, so it stays the real safe-projection function here too.
vi.mock('../services/aiAgents/alertVerdicts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiAgents/alertVerdicts')>();
  return {
    ...actual,
    recordVerdictFeedback: recordVerdictFeedbackMock,
  };
});

vi.mock('../services/aiTools', () => ({
  verifyDeviceAccess: verifyDeviceAccessMock,
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: writeRouteAuditMock,
}));

vi.mock('../db', () => ({
  db: { select: selectMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  getCurrentDbAccessContext: () => undefined,
}));

vi.mock('../services/aiAgents/effectivePolicy', () => ({
  resolveEffectiveAgent: resolveEffectiveAgentMock,
}));

const envMock = vi.hoisted(() => ({ policyDecideEnabled: vi.fn(() => true) }));
vi.mock('../config/env', () => ({ policyDecideEnabled: envMock.policyDecideEnabled }));

import { aiAgentsRoutes, mapError } from './aiAgents';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ORG_ID = '44444444-4444-4444-8444-444444444444';
const PARTNER_ID = '55555555-5555-4555-8555-555555555555';
const RUN_ID = '66666666-6666-4666-8666-666666666666';
const USER_ID = '77777777-7777-4777-8777-777777777777';

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    kind: 'triage',
    name: 'Triage',
    orgId: ORG_ID,
    partnerId: null,
    ...overrides,
  };
}

function buildApp(withGlobalErrorHandler = false): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      user: { id: USER_ID, email: 'tech@example.com', name: 'Tech' },
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    } as never);
    await next();
  });
  if (withGlobalErrorHandler) {
    app.onError((err, c) => {
      if (err instanceof HTTPException) {
        return c.json({ error: err.message }, err.status);
      }
      return c.json({ error: 'Internal server error' }, 500);
    });
  }
  app.route('/ai-agents', aiAgentsRoutes);
  return app;
}

function trigger(app: Hono, body: unknown = { deviceId: DEVICE_ID }, id = AGENT_ID) {
  return app.request(`/ai-agents/${id}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  hasPermMock.mockReturnValue(true);
  mfaOkMock.mockReturnValue(true);
  getAgentMock.mockResolvedValue(agent());
  verifyDeviceAccessMock.mockResolvedValue({
    device: { id: DEVICE_ID, orgId: ORG_ID, siteId: null },
  });
  createAndEnqueueAgentRunMock.mockResolvedValue({
    created: true,
    run: { id: RUN_ID, status: 'queued' },
  });
  envMock.policyDecideEnabled.mockReturnValue(true);
  recordVerdictFeedbackMock.mockResolvedValue({ status: 'ok', orgId: ORG_ID });
});

describe('POST /ai-agents/:id/runs', () => {
  it('queues a manual run and audits the accountable human actor', async () => {
    const res = await trigger(buildApp());

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { runId: RUN_ID, status: 'queued' } });
    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledWith({
      orgId: ORG_ID,
      kind: 'triage',
      triggerKind: 'manual',
      deviceId: DEVICE_ID,
      dedupeKey: expect.stringMatching(/^manual:[0-9a-f-]{36}$/),
      triggerRef: { requestedByUserId: USER_ID, agentId: AGENT_ID },
    });
    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        action: 'ai_agent.run.manual_trigger',
        resourceType: 'ai_agent',
        resourceId: AGENT_ID,
        resourceName: 'Triage',
        result: 'success',
        details: { deviceId: DEVICE_ID, runId: RUN_ID, triggerKind: 'manual' },
      }),
    );
  });

  it("uses the device's organization when the visible agent is partner-wide", async () => {
    getAgentMock.mockResolvedValue(agent({ orgId: null, partnerId: PARTNER_ID }));

    const res = await trigger(buildApp());

    expect(res.status).toBe(202);
    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, kind: 'triage' }),
    );
  });

  it('requires the ai_agents:write permission before admission', async () => {
    hasPermMock.mockImplementation((resource: string, action: string) => (
      resource !== 'ai_agents' || action !== 'write'
    ));

    const res = await trigger(buildApp());

    expect(res.status).toBe(403);
    // These literals are the public permission contract consumed by the route.
    expect(hasPermMock).toHaveBeenCalledTimes(1);
    expect(hasPermMock).toHaveBeenCalledWith('ai_agents', 'write');
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('requires MFA before admission', async () => {
    mfaOkMock.mockReturnValue(false);

    const res = await trigger(buildApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'MFA required', code: 'MFA_REQUIRED' });
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('returns a uniform 404 for a foreign-tenant agent before probing the device', async () => {
    getAgentMock.mockResolvedValue(null);

    const res = await trigger(buildApp());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Agent not found' });
    expect(verifyDeviceAccessMock).not.toHaveBeenCalled();
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid agent id without touching the database', async () => {
    const res = await trigger(buildApp(), { deviceId: DEVICE_ID }, 'not-a-uuid');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Agent not found' });
    expect(getAgentMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the device is outside the caller's scope", async () => {
    verifyDeviceAccessMock.mockResolvedValue({ error: 'Device not found or access denied' });

    const res = await trigger(buildApp());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Device not found or access denied' });
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('surfaces a cooldown skip as a conflict and audits the failure', async () => {
    createAndEnqueueAgentRunMock.mockResolvedValue({ created: false, skipped: 'cooldown' });

    const res = await trigger(buildApp());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'run_skipped', reason: 'cooldown' });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: 'failure',
        details: { deviceId: DEVICE_ID, reason: 'cooldown' },
      }),
    );
  });

  it('returns a deliberate conflict when the kill switch is off', async () => {
    createAndEnqueueAgentRunMock.mockResolvedValue({ created: false, skipped: 'kill_switch_off' });

    const res = await trigger(buildApp());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'run_skipped', reason: 'kill_switch_off' });
  });

  it('reports a created terminal-failed row as an enqueue failure', async () => {
    createAndEnqueueAgentRunMock.mockResolvedValue({
      created: true,
      run: { id: RUN_ID, status: 'failed', errorCode: 'enqueue_failed' },
    });

    const res = await trigger(buildApp());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'run_enqueue_failed',
      code: 'enqueue_failed',
      runId: RUN_ID,
    });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: 'failure',
        details: { deviceId: DEVICE_ID, runId: RUN_ID, errorCode: 'enqueue_failed' },
      }),
    );
  });

  it('rejects missing, malformed, and non-strict request bodies before admission', async () => {
    const app = buildApp();

    const missing = await trigger(app, {});
    const malformed = await trigger(app, { deviceId: 'not-a-uuid' });
    const smuggled = await trigger(app, { deviceId: DEVICE_ID, orgId: OTHER_ORG_ID });

    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(smuggled.status).toBe(400);
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('lets a missing-organization HTTPException reach the global error handler', async () => {
    createAndEnqueueAgentRunMock.mockRejectedValue(
      new HTTPException(404, { message: 'Organization not found' }),
    );

    const res = await trigger(buildApp(true));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
  });
});

// Review fix (#3828): the LEAK PROBE that found this — a bare `db.select()`
// on `ai_agent_runs` put the whole `outcome` jsonb on the wire, including
// `proposedActions[].args` (the verbatim raw tool input the model proposed),
// under the identical ai_agents:read gate the hardened routes below enforce.
// The route now projects through the same `mapRunListItem` mapper as the
// org-wide `GET /runs` list.
describe('GET /ai-agents/:id/runs (legacy per-agent list, review fix #3828)', () => {
  it('is gated on ai_agents:read', async () => {
    hasPermMock.mockReturnValue(false);
    const res = await buildApp().request(`/ai-agents/${AGENT_ID}/runs`);
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns a uniform 404 for a foreign-tenant/missing agent', async () => {
    getAgentMock.mockResolvedValue(null);
    const res = await buildApp().request(`/ai-agents/${AGENT_ID}/runs`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Agent not found' });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('never carries the raw outcome payload — no args, proposedActions, session, or policy internals', async () => {
    selectMock.mockReturnValueOnce(selectChain([runRow({ orgName: 'Acme Corp' })]));

    const res = await buildApp().request(`/ai-agents/${AGENT_ID}/runs`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: RUN_ID, agentId: AGENT_ID, agentName: 'Triage', orgId: ORG_ID, orgName: 'Acme Corp',
    });
    expect(body.data[0]).not.toHaveProperty('outcome');
    expect(body.data[0]).not.toHaveProperty('trace');
    expect(body.data[0]).not.toHaveProperty('sessionId');
    expect(body.data[0]).not.toHaveProperty('intentIds');
    expect(body.data[0]).not.toHaveProperty('policySnapshot');
    expect(body.data[0]).not.toHaveProperty('dedupeKey');

    const json = JSON.stringify(body);
    for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
      expect(json).not.toContain(`"${forbidden}"`);
    }
    expect(json).not.toContain('do-not-leak-me');
    expect(json).not.toContain('scriptId');
  });
});

describe('GET /ai-agents/policy-decidable-keys (Task 5, #3827)', () => {
  it('returns the POLICY_DECIDABLE_TIER3 registry, one entry per headless-compatible key', async () => {
    const res = await buildApp().request('/ai-agents/policy-decidable-keys');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ key: string; toolName: string; action: string | null }> };
    expect(body.data.length).toBeGreaterThan(0);
    // Every real registry entry, not a filtered/renamed subset — e.g. the
    // multiplexed manage_services actions must be present with their real
    // tool:action key, exactly what the client needs to group by tool and
    // POST back into actAssets.supervisedActionKeys unchanged.
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'manage_services:restart', toolName: 'manage_services', action: 'restart' }),
        expect.objectContaining({ key: 'security_scan:quarantine', toolName: 'security_scan', action: 'quarantine' }),
      ]),
    );
    // No internal registry-review fields (maxTargetCardinality,
    // requiresEffectPin, headlessCompatible) leak onto the wire — those are
    // implementation notes for whoever edits policyDecidable.ts, not client
    // data.
    for (const entry of body.data) {
      expect(entry).not.toHaveProperty('maxTargetCardinality');
      expect(entry).not.toHaveProperty('requiresEffectPin');
      expect(entry).not.toHaveProperty('headlessCompatible');
    }
  });

  it('is gated on ai_agents:read like every other agent-config read', async () => {
    hasPermMock.mockReturnValue(false);
    const res = await buildApp().request('/ai-agents/policy-decidable-keys');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Wave 6 PR 1 (#3828) — exposure budget readout
// ---------------------------------------------------------------------------

describe('GET /ai-agents/exposure-budget (recorded exposure readout, #3828)', () => {
  const exposureBudgetQuery = `orgId=${ORG_ID}&kind=patch`;

  function mockResolvedAgent(overrides: Record<string, unknown> = {}) {
    resolveEffectiveAgentMock.mockResolvedValue({
      schemaVersion: 4,
      agentId: AGENT_ID,
      kind: 'patch',
      effective: {
        limits: { maxFleetPercentPerDay: 5, maxPolicyDecisionsPerDay: 10 },
      },
      ...overrides,
    });
  }

  it('is gated on ai_agents:read', async () => {
    hasPermMock.mockReturnValue(false);
    const res = await buildApp().request(`/ai-agents/exposure-budget?${exposureBudgetQuery}`);
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('rejects a missing/invalid kind before touching the database', async () => {
    const res = await buildApp().request(`/ai-agents/exposure-budget?orgId=${ORG_ID}&kind=bogus`);
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns 404 when there is no active agent policy for the org/kind', async () => {
    resolveEffectiveAgentMock.mockResolvedValue(null);
    const res = await buildApp().request(`/ai-agents/exposure-budget?${exposureBudgetQuery}`);
    expect(res.status).toBe(404);
  });

  it('reuses computeExposureBudget and returns a schemaVersion-1, recordedOnly readout', async () => {
    mockResolvedAgent();
    selectMock
      .mockReturnValueOnce(selectChain([{ deviceId: 'd1' }, { deviceId: 'd2' }])) // exposedDeviceRows
      .mockReturnValueOnce(selectChain([{ n: 40 }])) // countContractDevices
      .mockReturnValueOnce(selectChain([{ n: 3 }])); // dayCountRow

    const res = await buildApp().request(`/ai-agents/exposure-budget?${exposureBudgetQuery}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(body.data).toEqual({
      schemaVersion: 1,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      distinctDevices: 2,
      contractDeviceCount: 40,
      maxFleetPercentPerDay: 5,
      allowance: 2, // floor(40 * 5 / 100)
      policyDecisionsToday: 3,
      maxPolicyDecisionsPerDay: 10,
      windowHours: 24,
      recordedOnly: true,
      accountingMode: 'full',
    });
  });

  it('labels accountingMode "partial" while the policy-decide flag is dark', async () => {
    envMock.policyDecideEnabled.mockReturnValue(false);
    mockResolvedAgent();
    selectMock
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([{ n: 10 }]))
      .mockReturnValueOnce(selectChain([{ n: 0 }]));

    const res = await buildApp().request(`/ai-agents/exposure-budget?${exposureBudgetQuery}`);
    const body = (await res.json()) as { data: { accountingMode: string } };
    expect(body.data.accountingMode).toBe('partial');
  });

  it('never leaks a raw tool-input-shaped key onto the wire', async () => {
    mockResolvedAgent();
    selectMock
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([{ n: 10 }]))
      .mockReturnValueOnce(selectChain([{ n: 0 }]));

    const res = await buildApp().request(`/ai-agents/exposure-budget?${exposureBudgetQuery}`);
    const json = JSON.stringify(await res.json());
    for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
      expect(json).not.toContain(`"${forbidden}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Wave 6 PR 1 (#3828) — execution-trace runs list + detail
// ---------------------------------------------------------------------------

/**
 * A minimal chainable stand-in for a Drizzle `db.select(...)` call. Every
 * chain method returns the same object; `then` resolves it to `rows` so
 * `await db.select({...}).from(...).where(...).orderBy(...).limit(...)`
 * resolves exactly like the real query would. The route under test never
 * inspects the arguments passed to `.where`/`.orderBy`/etc in these unit
 * tests — those are exercised for real (no mocking) inside
 * runsListCursor.ts/runTrace.ts's own suites and by the RLS/integration
 * contract tests.
 */
function selectChain<T>(rows: T) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

// Strict response-shape schemas (DTO rule, Global Constraints): a route that
// starts spreading a raw row again — pulling in dedupeKey, policySnapshot,
// the outcome column itself, sessionId, intentIds, or any tool-input field —
// fails `.strict().parse()` here even though the specific leaked field was
// never anticipated by name.
const traceEntryResponseSchema = z.union([
  z.object({
    kind: z.literal('executed'),
    tool: z.string(),
    action: z.string().optional(),
    result: z.enum(['ok', 'failed']),
    durationMs: z.number(),
    execution: z.enum(['succeeded', 'failed', 'timeout', 'unknown']).optional(),
    verification: z.enum(['passed', 'failed', 'inconclusive', 'skipped']).optional(),
    verifyDetail: z.string().optional(),
    actOpKey: z.string().optional(),
    actTargetName: z.string().optional(),
  }).strict(),
  z.object({
    kind: z.literal('proposed'),
    tool: z.string(),
    action: z.string().optional(),
    intentId: z.string().optional(),
    intentError: z.string().optional(),
    downgradeReason: z.string().optional(),
  }).strict(),
  z.object({
    kind: z.literal('denied'),
    tool: z.string(),
    reason: z.string(),
  }).strict(),
]);

const runDetailResponseSchema = z.object({
  data: z.object({
    schemaVersion: z.literal(1),
    id: z.string(),
    agentId: z.string(),
    agentName: z.string().nullable(),
    agentKind: z.string().nullable(),
    orgId: z.string(),
    deviceId: z.string().nullable(),
    deviceHostname: z.string().nullable(),
    alertId: z.string().nullable(),
    triggerKind: z.string(),
    modeAtStart: z.string(),
    status: z.string(),
    summary: z.string().nullable(),
    runVerdict: z.string().nullable(),
    turnCount: z.number(),
    costCents: z.number(),
    errorCode: z.string().nullable(),
    queuedAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    budgetExceeded: z.boolean(),
    wallClockExceeded: z.boolean(),
    maxTurnsExceeded: z.boolean(),
    trace: z.array(traceEntryResponseSchema),
    ledger: z.array(z.object({
      toolName: z.string(),
      status: z.string(),
      durationMs: z.number().nullable(),
      createdAt: z.string(),
      completedAt: z.string().nullable(),
      errorMessage: z.string().nullable(),
    }).strict()),
    intents: z.array(z.object({
      id: z.string(),
      status: z.string(),
      actionName: z.string(),
      approvalScope: z.string(),
      decidedVia: z.string().nullable(),
    }).strict()),
    // Wave 6 PR 3 (#3828, Task 4) — text-only; no args/toolInput/toolOutput
    // field exists on this shape either (see AiAgentRunTicketProposalDto).
    ticketProposal: z.object({
      summary: z.string(),
      proposedReply: z.string().optional(),
      proposedStatus: z.string().optional(),
      proposedPriority: z.string().optional(),
      notes: z.array(z.string()),
    }).strict().nullable(),
    // Phase 2 wave P2-1 (alert verdicts): `null` for a full-profile run and
    // for a verdict run that hasn't produced one. `suggestedAction`'s
    // `disposition`/`reason` (review round 1, IMPORTANT 2) are the Tier-2
    // intent attempt's outcome, never the raw tool args/error message.
    alertVerdict: z.object({
      classification: z.string(),
      confidence: z.number(),
      rationale: z.string(),
      patternKind: z.string().nullable(),
      evidenceAlertIds: z.array(z.string()),
      suggestedAction: z.object({
        tool: z.literal('manage_alerts'),
        action: z.enum(['suppress', 'resolve']),
        disposition: z.enum(['intent_created', 'not_created']),
        reason: z.enum([
          'low_confidence', 'target_mismatch', 'alert_not_found', 'no_eligible_approvers', 'intent_error',
          'not_allowlisted', 'superseded_concurrently',
        ]).nullable(),
      }).strict().nullable(),
    }).strict().nullable(),
  }).strict(),
}).strict();

const runListResponseSchema = z.object({
  data: z.array(z.object({
    schemaVersion: z.literal(1),
    id: z.string(),
    agentId: z.string(),
    agentName: z.string().nullable(),
    orgId: z.string(),
    orgName: z.string().nullable(),
    deviceId: z.string().nullable(),
    status: z.string(),
    triggerKind: z.string(),
    runVerdict: z.string().nullable(),
    queuedAt: z.string(),
    finishedAt: z.string().nullable(),
    costCents: z.number(),
  }).strict()),
  nextCursor: z.string().nullable(),
}).strict();

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    deviceId: DEVICE_ID,
    alertId: null,
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    triggerKind: 'manual',
    modeAtStart: 'shadow',
    status: 'completed',
    summary: 'Restarted the print spooler.',
    outcome: {
      findings: [],
      executedActions: [{
        tool: 'manage_services', action: 'restart', executionId: 'exec-1',
        result: 'ok', durationMs: 340, execution: 'succeeded', verification: 'passed',
        verifyDetail: 'service running', actOpKey: 'manage_services.restart', actTargetName: 'Spooler',
      }],
      proposedActions: [{
        tool: 'run_script', action: 'invoke',
        args: { scriptId: 'abc', secretParam: 'do-not-leak-me' },
        intentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }],
      deniedActions: [{ tool: 'delete_registry_key', reason: 'protected resource' }],
      toolExecutionCount: 2,
      runVerdict: 'partial',
    },
    intentIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    turnCount: 3,
    costCents: 12,
    errorCode: null,
    queuedAt: new Date('2026-08-28T10:00:00.000Z'),
    startedAt: new Date('2026-08-28T10:00:01.000Z'),
    finishedAt: new Date('2026-08-28T10:00:30.000Z'),
    agentName: 'Triage',
    agentKind: 'triage',
    deviceHostname: 'WKS-042',
    ...overrides,
  };
}

describe('GET /ai-agents/runs/:runId (execution-trace detail, #3828)', () => {
  it('returns 404 for a run outside the caller\'s org (or that does not exist)', async () => {
    selectMock.mockReturnValueOnce(selectChain([]));
    const res = await buildApp().request(`/ai-agents/runs/${RUN_ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Run not found' });
  });

  it('rejects a non-uuid run id without touching the database', async () => {
    const res = await buildApp().request('/ai-agents/runs/not-a-uuid');
    expect(res.status).toBe(404);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('is gated on ai_agents:read', async () => {
    hasPermMock.mockReturnValue(false);
    const res = await buildApp().request(`/ai-agents/runs/${RUN_ID}`);
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('stitches run + ledger + intents into the safe-projected trace DTO, matching the strict wire schema', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([runRow()])) // run + agent + device join
      .mockReturnValueOnce(selectChain([{
        toolName: 'run_script', status: 'completed', durationMs: 210,
        createdAt: new Date('2026-08-28T10:00:05.000Z'),
        completedAt: new Date('2026-08-28T10:00:06.000Z'),
        errorMessage: null,
      }])) // ledger
      .mockReturnValueOnce(selectChain([{
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        status: 'pending_approval',
        actionName: 'run_script.invoke',
        approvalScope: 'four_eyes',
        decidedVia: null,
      }])); // intents

    const res = await buildApp().request(`/ai-agents/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const parsed = runDetailResponseSchema.parse(body);
    expect(parsed.data.id).toBe(RUN_ID);
    expect(parsed.data.agentName).toBe('Triage');
    expect(parsed.data.deviceHostname).toBe('WKS-042');
    expect(parsed.data.runVerdict).toBe('partial');
    expect(parsed.data.trace).toHaveLength(3);
    expect(parsed.data.ledger).toHaveLength(1);
    expect(parsed.data.intents).toHaveLength(1);

    // The leak tripwire: the raw tool input the model proposed
    // (`{ scriptId: 'abc', secretParam: 'do-not-leak-me' }`) must never reach
    // the wire, under any key name.
    const json = JSON.stringify(body);
    for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
      expect(json).not.toContain(`"${forbidden}"`);
    }
    expect(json).not.toContain('do-not-leak-me');
    expect(json).not.toContain('scriptId');
  });

  it('skips the ledger/intents queries when the run has no session and no intent ids', async () => {
    selectMock.mockReturnValueOnce(selectChain([runRow({ sessionId: null, intentIds: [] })]));

    const res = await buildApp().request(`/ai-agents/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.ledger).toEqual([]);
    expect(body.data.intents).toEqual([]);
    // Only the run-row select ran — no second/third db.select for ledger/intents.
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  // Review fix (#3828): ai_agents is dual-ownership (#2135) — a partner-wide
  // agent's row is RLS-invisible to an org-scoped caller even though the run
  // it produced (plain org-scoped) stays visible. Before this fix the route
  // innerJoin'd ai_agents, so this case 404'd instead of returning the run.
  it('returns the run (not 404) when its agent row is RLS-invisible, with agentName/agentKind null', async () => {
    selectMock.mockReturnValueOnce(selectChain([
      runRow({ sessionId: null, intentIds: [], agentName: null, agentKind: null }),
    ]));

    const res = await buildApp().request(`/ai-agents/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = runDetailResponseSchema.parse(body);
    expect(parsed.data.id).toBe(RUN_ID);
    expect(parsed.data.agentName).toBeNull();
    expect(parsed.data.agentKind).toBeNull();
  });

  // Review round 1, fix round 1 (IMPORTANT 1) — carry-in C's new
  // `superseded_concurrently` suggestionReason (alertVerdicts.ts's 23505
  // race handling) must round-trip through `GET /runs/:runId` without
  // tripping the strict wire schema. `projectAlertVerdict` is the REAL
  // implementation here (importOriginal, see this file's own mock comment
  // above `alertVerdicts`), so this exercises the actual projection, not a
  // stub — the schema parse below is the assertion that matters.
  it('round-trips alertVerdict.suggestedAction.reason: superseded_concurrently through the strict wire schema', async () => {
    selectMock.mockReturnValueOnce(selectChain([
      runRow({
        sessionId: null,
        intentIds: [],
        outcome: {
          findings: [],
          executedActions: [],
          proposedActions: [],
          deniedActions: [],
          toolExecutionCount: 0,
          runVerdict: 'partial',
          alertVerdict: {
            classification: 'actionable',
            confidence: 0.9,
            rationale: 'Another run already recorded a verdict for this alert.',
            suggestedAction: { tool: 'manage_alerts', action: 'resolve', alertId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
          },
          alertVerdictIntent: { disposition: 'not_created', reason: 'superseded_concurrently' },
        },
      }),
    ]));

    const res = await buildApp().request(`/ai-agents/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = runDetailResponseSchema.parse(body);
    expect(parsed.data.alertVerdict?.suggestedAction?.disposition).toBe('not_created');
    expect(parsed.data.alertVerdict?.suggestedAction?.reason).toBe('superseded_concurrently');
  });
});

// Phase 2 wave P2-1 (alert verdicts), Task 8.
describe('POST /ai-agents/verdicts/:verdictId/feedback', () => {
  const VERDICT_ID = '88888888-8888-4888-8888-888888888888';

  it('records feedback, audits it, and returns { ok: true }', async () => {
    const res = await buildApp().request(`/ai-agents/verdicts/${VERDICT_ID}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feedback: 'up' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(recordVerdictFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: USER_ID }) }),
      VERDICT_ID,
      'up',
    );
    // Carry-in B — every successful write is audited.
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        action: 'ai_agent.verdict_feedback',
        resourceType: 'ai_alert_verdict',
        resourceId: VERDICT_ID,
        details: { feedback: 'up' },
        result: 'success',
      }),
    );
  });

  it('is gated on ai_agents:read (not ai_agents:write)', async () => {
    hasPermMock.mockReturnValue(false);
    const res = await buildApp().request(`/ai-agents/verdicts/${VERDICT_ID}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feedback: 'up' }),
    });
    expect(res.status).toBe(403);
    expect(recordVerdictFeedbackMock).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid verdict id without touching the service', async () => {
    const res = await buildApp().request('/ai-agents/verdicts/not-a-uuid/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feedback: 'up' }),
    });
    expect(res.status).toBe(404);
    expect(recordVerdictFeedbackMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid feedback value', async () => {
    const res = await buildApp().request(`/ai-agents/verdicts/${VERDICT_ID}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feedback: 'sideways' }),
    });
    expect(res.status).toBe(400);
    expect(recordVerdictFeedbackMock).not.toHaveBeenCalled();
  });

  it('returns 404 when no verdict row matched (not found, or RLS-denied cross-org)', async () => {
    recordVerdictFeedbackMock.mockResolvedValue({ status: 'not_found' });
    const res = await buildApp().request(`/ai-agents/verdicts/${VERDICT_ID}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feedback: 'down' }),
    });
    expect(res.status).toBe(404);
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  // Carry-in B (PR-A review) — a caller must not silently overwrite ANOTHER
  // user's already-recorded feedback.
  it('returns 409 (and does not audit) when the row already carries another user\'s feedback', async () => {
    recordVerdictFeedbackMock.mockResolvedValue({ status: 'conflict', orgId: ORG_ID });
    const res = await buildApp().request(`/ai-agents/verdicts/${VERDICT_ID}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feedback: 'down' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Feedback already recorded by another user' });
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });
});

describe('GET /ai-agents/runs (org-wide keyset list, #3828)', () => {
  it('is gated on ai_agents:read', async () => {
    hasPermMock.mockReturnValue(false);
    const res = await buildApp().request('/ai-agents/runs');
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns a page with no nextCursor when fewer rows than the limit come back', async () => {
    selectMock.mockReturnValueOnce(selectChain([
      {
        id: RUN_ID, agentId: AGENT_ID, agentName: 'Triage', orgId: ORG_ID, orgName: 'Acme Corp',
        deviceId: DEVICE_ID,
        status: 'completed', triggerKind: 'manual', runVerdict: 'remediated',
        queuedAt: new Date('2026-08-28T10:00:00.000Z'),
        queuedAtRaw: '2026-08-28T10:00:00.000000Z',
        finishedAt: new Date('2026-08-28T10:00:30.000Z'),
        costCents: 12,
      },
    ]));

    const res = await buildApp().request('/ai-agents/runs');
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = runListResponseSchema.parse(body);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.nextCursor).toBeNull();
    expect(parsed.data[0]).toMatchObject({
      id: RUN_ID, agentName: 'Triage', orgId: ORG_ID, orgName: 'Acme Corp', runVerdict: 'remediated',
    });
  });

  it('returns a nextCursor and trims the peeked row when a full extra page comes back', async () => {
    const makeRow = (i: number) => ({
      id: `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`,
      agentId: AGENT_ID, agentName: 'Triage', orgId: ORG_ID, orgName: 'Acme Corp', deviceId: null,
      status: 'completed', triggerKind: 'schedule', runVerdict: null,
      queuedAt: new Date(Date.UTC(2026, 7, 28, 10, 0, i)),
      queuedAtRaw: `2026-08-28T10:00:${String(i).padStart(2, '0')}.000000Z`,
      finishedAt: null, costCents: 0,
    });
    // Default limit is 25 — return 26 rows to trigger the peek.
    const rows = Array.from({ length: 26 }, (_, i) => makeRow(i));
    selectMock.mockReturnValueOnce(selectChain(rows));

    const res = await buildApp().request('/ai-agents/runs');
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = runListResponseSchema.parse(body);
    expect(parsed.data).toHaveLength(25);
    expect(parsed.nextCursor).not.toBeNull();
  });

  // Review fix (#3828): built from the row's `queuedAtRaw` microsecond text,
  // never `queuedAt.toISOString()` — a JS Date truncates to milliseconds,
  // which would silently drop same-millisecond siblings from the next page.
  it('seeds nextCursor from the peeked row\'s queuedAtRaw, not the millisecond-truncated queuedAt Date', async () => {
    const microPrecise = '2026-08-28T10:00:00.123456Z';
    const makeRow = (i: number) => ({
      id: `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`,
      agentId: AGENT_ID, agentName: 'Triage', orgId: ORG_ID, orgName: 'Acme Corp', deviceId: null,
      status: 'completed', triggerKind: 'schedule', runVerdict: null,
      // Every row shares the same millisecond-truncated Date — the last
      // (limit+1-th, trimmed) row's true value differs only in microseconds.
      queuedAt: new Date('2026-08-28T10:00:00.123Z'),
      // limit is 25, so pageRows is indices 0..24 and index 24 is `last` —
      // the seed for nextCursor. Index 25 is the peeked/trimmed row.
      queuedAtRaw: i === 24 ? microPrecise : '2026-08-28T10:00:00.123999Z',
      finishedAt: null, costCents: 0,
    });
    const rows = Array.from({ length: 26 }, (_, i) => makeRow(i));
    selectMock.mockReturnValueOnce(selectChain(rows));

    const res = await buildApp().request('/ai-agents/runs');
    const body = await res.json();
    const parsed = runListResponseSchema.parse(body);
    expect(parsed.nextCursor).not.toBeNull();

    const decoded = JSON.parse(Buffer.from(parsed.nextCursor as string, 'base64url').toString('utf8'));
    expect(decoded.q).toBe(microPrecise);
  });

  // Review fix (#3828): ai_agents is dual-ownership (#2135) — a partner-wide
  // agent's row is RLS-invisible to an org-scoped caller even though the run
  // it produced (plain org-scoped) stays visible. The route left-joins
  // ai_agents so the run survives; agentName comes back null instead.
  it('includes a run whose agent row is RLS-invisible (partner-wide agent), with agentName null', async () => {
    selectMock.mockReturnValueOnce(selectChain([
      {
        id: RUN_ID, agentId: AGENT_ID, agentName: null, orgId: ORG_ID, orgName: 'Acme Corp',
        deviceId: DEVICE_ID,
        status: 'completed', triggerKind: 'schedule', runVerdict: 'remediated',
        queuedAt: new Date('2026-08-28T10:00:00.000Z'),
        queuedAtRaw: '2026-08-28T10:00:00.000000Z',
        finishedAt: new Date('2026-08-28T10:00:30.000Z'),
        costCents: 12,
      },
    ]));

    const res = await buildApp().request('/ai-agents/runs');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(RUN_ID);
    expect(body.data[0].agentName).toBeNull();
  });

  // Review fix (#3828): `?orgId=` is what `fetchWithAuth` auto-injects when
  // the org switcher has one org selected (apps/web/src/stores/auth.ts) —
  // before this fix the query schema silently stripped it and selecting an
  // org never narrowed the fleet-wide list.
  it('rejects an orgId the caller cannot access, before touching the database', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        scope: 'organization', orgId: ORG_ID, partnerId: null, accessibleOrgIds: [ORG_ID],
        user: { id: USER_ID, email: 'tech@example.com', name: 'Tech' },
        canAccessOrg: (id: string) => id === ORG_ID,
        orgCondition: () => undefined,
      } as never);
      await next();
    });
    app.route('/ai-agents', aiAgentsRoutes);

    const res = await app.request(`/ai-agents/runs?orgId=${OTHER_ORG_ID}`);
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('applies an accessible orgId filter and returns its rows', async () => {
    selectMock.mockReturnValueOnce(selectChain([
      {
        id: RUN_ID, agentId: AGENT_ID, agentName: 'Triage', orgId: ORG_ID, orgName: 'Acme Corp',
        deviceId: DEVICE_ID,
        status: 'completed', triggerKind: 'manual', runVerdict: 'remediated',
        queuedAt: new Date('2026-08-28T10:00:00.000Z'),
        queuedAtRaw: '2026-08-28T10:00:00.000000Z',
        finishedAt: new Date('2026-08-28T10:00:30.000Z'),
        costCents: 12,
      },
    ]));

    const res = await buildApp().request(`/ai-agents/runs?orgId=${ORG_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = runListResponseSchema.parse(body);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0]).toMatchObject({ id: RUN_ID, orgId: ORG_ID, orgName: 'Acme Corp' });
  });

  it('rejects a malformed orgId', async () => {
    const res = await buildApp().request('/ai-agents/runs?orgId=not-a-uuid');
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed cursor with 400 before touching the database', async () => {
    const res = await buildApp().request('/ai-agents/runs?cursor=not-valid-base64url!!!');
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('rejects a limit above the 50 ceiling', async () => {
    const res = await buildApp().request('/ai-agents/runs?limit=51');
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized status filter', async () => {
    const res = await buildApp().request('/ai-agents/runs?status=bogus_status');
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('never carries an outcome/trace payload on the list item, even though runVerdict is derived from the outcome column', async () => {
    selectMock.mockReturnValueOnce(selectChain([
      {
        id: RUN_ID, agentId: AGENT_ID, agentName: 'Triage', orgId: ORG_ID, orgName: 'Acme Corp',
        deviceId: DEVICE_ID,
        status: 'completed', triggerKind: 'manual', runVerdict: 'remediated',
        queuedAt: new Date('2026-08-28T10:00:00.000Z'),
        finishedAt: new Date('2026-08-28T10:00:30.000Z'),
        costCents: 12,
      },
    ]));
    const res = await buildApp().request('/ai-agents/runs');
    const body = await res.json();
    expect(body.data[0]).not.toHaveProperty('trace');
    expect(body.data[0]).not.toHaveProperty('outcome');
    expect(body.data[0]).not.toHaveProperty('ledger');
  });
});

describe('mapError — act-mode activation prerequisites (Task 6, #3826)', () => {
  it('maps ActPrerequisitesNotMetError to a 422 naming exactly what is missing', async () => {
    const jsonMock = vi.fn((body: unknown, status: number) => ({ body, status }));
    const ctx = { json: jsonMock } as unknown as Parameters<typeof mapError>[0];

    mapError(ctx, new ActPrerequisitesNotMetError(['recipient', 'act_eligible_tool']));

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'act_prerequisites_not_met',
        missing: ['recipient', 'act_eligible_tool'],
      }),
      422,
    );
  });
});

// ---------------------------------------------------------------------------
// Wave 6 PR 2 (#3828) — per-org circuit breaker read + MFA reset routes
// ---------------------------------------------------------------------------

function circuitSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG_ID,
    agentId: AGENT_ID,
    state: 'closed',
    consecutiveFailures: 0,
    openedAt: null,
    openedReason: null,
    lastRunId: null,
    lastTransitionAt: null,
    resetBy: null,
    resetAt: null,
    ...overrides,
  };
}

describe('GET /ai-agents/:id/circuit', () => {
  beforeEach(() => {
    getCircuitStateMock.mockResolvedValue(circuitSnapshot());
    resolveEffectiveAgentMock.mockResolvedValue({
      effective: { limits: { maxConsecutiveFailures: 4 } },
    });
  });

  it('is gated on ai_agents:read', async () => {
    hasPermMock.mockReturnValue(false);
    const res = await buildApp().request(`/ai-agents/${AGENT_ID}/circuit`);
    expect(res.status).toBe(403);
    expect(getCircuitStateMock).not.toHaveBeenCalled();
  });

  it('returns a uniform 404 for a foreign-tenant/unknown agent', async () => {
    getAgentMock.mockResolvedValue(null);
    const res = await buildApp().request(`/ai-agents/${AGENT_ID}/circuit`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Agent not found' });
    expect(getCircuitStateMock).not.toHaveBeenCalled();
  });

  it('returns the state merged with the currently-effective threshold', async () => {
    const res = await buildApp().request(`/ai-agents/${AGENT_ID}/circuit`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ...circuitSnapshot(), maxConsecutiveFailures: 4 } });
    expect(getCircuitStateMock).toHaveBeenCalledWith(ORG_ID, AGENT_ID);
  });

  it('falls back to the shared default threshold when no effective policy resolves', async () => {
    resolveEffectiveAgentMock.mockResolvedValue(null);
    const res = await buildApp().request(`/ai-agents/${AGENT_ID}/circuit`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { maxConsecutiveFailures: number } };
    expect(body.data.maxConsecutiveFailures).toBe(AI_AGENT_LIMIT_DEFAULTS.maxConsecutiveFailures);
  });

  it("rejects an org-scoped caller's mismatched orgId query param", async () => {
    const res = await buildApp().request(`/ai-agents/${AGENT_ID}/circuit?orgId=${OTHER_ORG_ID}`);
    expect(res.status).toBe(403);
    expect(getCircuitStateMock).not.toHaveBeenCalled();
  });
});

describe('POST /ai-agents/:id/circuit/reset', () => {
  function resetReq(app: Hono, body: unknown = { reason: 'confirmed false positive' }) {
    return app.request(`/ai-agents/${AGENT_ID}/circuit/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    resetCircuitMock.mockResolvedValue(circuitSnapshot({
      resetBy: USER_ID, resetAt: '2026-08-28T00:00:00.000Z',
    }));
  });

  it('requires the ai_agents:write permission', async () => {
    hasPermMock.mockImplementation((resource: string, action: string) => (
      resource !== 'ai_agents' || action !== 'write'
    ));
    const res = await resetReq(buildApp());
    expect(res.status).toBe(403);
    expect(resetCircuitMock).not.toHaveBeenCalled();
  });

  it('requires MFA', async () => {
    mfaOkMock.mockReturnValue(false);
    const res = await resetReq(buildApp());
    expect(res.status).toBe(403);
    expect(resetCircuitMock).not.toHaveBeenCalled();
  });

  it('returns a uniform 404 for a foreign-tenant/unknown agent', async () => {
    getAgentMock.mockResolvedValue(null);
    const res = await resetReq(buildApp());
    expect(res.status).toBe(404);
    expect(resetCircuitMock).not.toHaveBeenCalled();
  });

  it('rejects a reason under 3 characters before touching the service', async () => {
    const res = await resetReq(buildApp(), { reason: 'no' });
    expect(res.status).toBe(400);
    expect(resetCircuitMock).not.toHaveBeenCalled();
  });

  it('resets the circuit and audits the human actor + reason', async () => {
    const res = await resetReq(buildApp(), { reason: 'confirmed false positive, patch was unrelated' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: circuitSnapshot({ resetBy: USER_ID, resetAt: '2026-08-28T00:00:00.000Z' }),
    });
    expect(resetCircuitMock).toHaveBeenCalledWith(ORG_ID, AGENT_ID, USER_ID);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        action: 'ai_agent.circuit_reset',
        resourceType: 'ai_agent',
        resourceId: AGENT_ID,
        result: 'success',
        details: expect.objectContaining({ reason: 'confirmed false positive, patch was unrelated' }),
      }),
    );
  });
});

describe('mapError — supervisedActionKeys write-time rejection (wave 5 Part B, #3827)', () => {
  it('maps InvalidSupervisedActionKeysError to a 422 naming exactly which keys were rejected and why', async () => {
    const jsonMock = vi.fn((body: unknown, status: number) => ({ body, status }));
    const ctx = { json: jsonMock } as unknown as Parameters<typeof mapError>[0];
    const rejected = [{ key: 'bogus_key', reason: 'not registered in POLICY_DECIDABLE_TIER3' }];

    mapError(ctx, new InvalidSupervisedActionKeysError(rejected));

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'invalid_supervised_action_keys',
        rejected,
      }),
      422,
    );
  });
});
