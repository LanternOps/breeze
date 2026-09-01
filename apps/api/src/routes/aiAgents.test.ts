import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  AI_AGENT_IMPACT_REBUILD_DAYS,
  AI_AGENT_IMPACT_REBUILD_MAX_ORGS,
  AI_AGENT_LIMIT_DEFAULTS,
  AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS,
  DEFAULT_IMPACT_WEIGHTS,
  type AiAgentImpactDto,
} from '@breeze/shared';
// Real (unmocked) — pure UTC day math, no DB call. Task 8 tests compute the
// same expected from/through the route does rather than re-mocking date
// generation; see the '../jobs/aiAgentImpactRollup' mock comment below.
import { lastCompleteUtcDay, shiftUtcDay } from '../services/aiAgents/impactRollup';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';

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
  loadImpactSummaryMock,
  enqueueImpactRollupForOrgsMock,
  saveImpactWeightsMock,
  resolveImpactPartnerIdMock,
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
  // Task 8 (#4193 A8) — the impact routes. Service-layer functions mocked
  // here have their own full unit coverage (A5/A6/A7); these route tests
  // exercise only routing/auth/validation, the same convention as
  // createAndEnqueueAgentRun/getAgent/recordVerdictFeedback above.
  loadImpactSummaryMock: vi.fn(),
  enqueueImpactRollupForOrgsMock: vi.fn(),
  saveImpactWeightsMock: vi.fn(),
  resolveImpactPartnerIdMock: vi.fn(),
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

// Task 8 (#4193 A8): '../jobs/aiAgentImpactRollup' is mocked (the manual
// rebuild producer, A5); '../services/aiAgents/impactRollup' (lastCompleteUtcDay/
// shiftUtcDay, A4) is deliberately left REAL — those two functions are pure
// date math with no DB call, so these tests compute the same expected
// from/through the route does instead of re-mocking date generation.
vi.mock('../jobs/aiAgentImpactRollup', () => ({
  enqueueImpactRollupForOrgs: enqueueImpactRollupForOrgsMock,
}));

vi.mock('../services/aiAgents/impactQuery', () => ({
  loadImpactSummary: loadImpactSummaryMock,
}));

const { ImpactPartnerUnresolvedError, ImpactPartnerNotFoundError } = vi.hoisted(() => ({
  ImpactPartnerUnresolvedError: class ImpactPartnerUnresolvedError extends Error {
    constructor(message = 'Unable to resolve a single partner for this impact request') {
      super(message);
      this.name = 'ImpactPartnerUnresolvedError';
    }
  },
  ImpactPartnerNotFoundError: class ImpactPartnerNotFoundError extends Error {
    constructor(message = 'Partner not found or not writable by this caller') {
      super(message);
      this.name = 'ImpactPartnerNotFoundError';
    }
  },
}));

vi.mock('../services/aiAgents/impactWeights', () => ({
  saveImpactWeights: saveImpactWeightsMock,
  resolveImpactPartnerId: resolveImpactPartnerIdMock,
  ImpactPartnerUnresolvedError,
  ImpactPartnerNotFoundError,
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

const ZERO_COUNTERS = {
  alertsJudged: 0, noiseFlagged: 0, suppressionsApplied: 0, ticketsTriaged: 0, draftsSent: 0,
  fixesProposed: 0, fixesExecuted: 0, fixWatchesHeld: 0, fixWatchesRecurred: 0, narrativesDelivered: 0,
};

/** Task 8 (#4193 A8): a structurally-valid AiAgentImpactDto for route tests — the DTO's own field-by-field correctness is A7's unit coverage, not this file's. */
function minimalImpactDto(overrides: Partial<AiAgentImpactDto> = {}): AiAgentImpactDto {
  return {
    schemaVersion: 1,
    window: 30,
    through: '2026-08-31',
    rebuiltAt: null,
    totals: { ...ZERO_COUNTERS, llmCents: 0, estSecondsSaved: 0 },
    series: [],
    byOrg: [],
    byOrgTruncated: false,
    positiveFeedback: { up: 0, down: 0, rate: null },
    promoteEligibleCount: null,
    weights: { effective: { ...DEFAULT_IMPACT_WEIGHTS }, overrides: null },
    canEditWeights: false,
    ...overrides,
  };
}

function buildApp(withGlobalErrorHandler = false, authOverrides: Record<string, unknown> = {}): Hono {
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
      ...authOverrides,
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
  loadImpactSummaryMock.mockResolvedValue(minimalImpactDto());
  enqueueImpactRollupForOrgsMock.mockImplementation(async (orgIds: string[]) => orgIds.length);
  resolveImpactPartnerIdMock.mockResolvedValue(PARTNER_ID);
  saveImpactWeightsMock.mockResolvedValue({
    before: null,
    after: { fixExecuted: 1200 },
    effective: { ...DEFAULT_IMPACT_WEIGHTS, fixExecuted: 1200 },
  });
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
function selectChain<T>(rows: T, onWhere?: (predicate: unknown) => void) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    // `onWhere` (P2-2 Task A7, review round 1) lets a test compile the
    // predicate a route actually built and assert on its BOUND PARAMS — the
    // only way to prove a tenancy pin binds the right org id rather than
    // merely naming the `org_id` column.
    where: (predicate: unknown) => { onWhere?.(predicate); return chain; },
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

const dialect = new PgDialect();
/** Bound parameters of a compiled predicate — see `selectChain`'s `onWhere`. */
function sqlParams(predicate: unknown): unknown[] {
  return dialect.sqlToQuery(predicate as SQL).params;
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
    // Wave 6 PR 3 (#3828, Task 4); reshaped in P2-4 (#4191) onto the
    // `TicketTriageProposal` outcome (@breeze/shared) — no args/toolInput/
    // toolOutput field exists on this shape either (see
    // AiAgentRunTicketProposalDto). `intentIds`/`draftsWritten` are the two
    // DTO-only fields Task A10 wires in — the run's own `intent_ids` column
    // and a live `ticket_drafts` read, respectively (see runTrace.ts).
    ticketProposal: z.object({
      version: z.literal(1),
      summary: z.string(),
      fields: z.object({
        categoryId: z.object({
          value: z.string(),
          confidence: z.number(),
        }).strict().optional(),
        priority: z.object({
          value: z.string(),
          confidence: z.number(),
        }).strict().optional(),
      }).strict().optional(),
      device: z.object({
        hostname: z.string().optional(),
        serial: z.string().optional(),
      }).strict().optional(),
      draftReply: z.string().optional(),
      draftResolutionNote: z.string().optional(),
      notes: z.array(z.string()).optional(),
      intentIds: z.array(z.string()).optional(),
      draftsWritten: z.array(z.object({
        kind: z.enum(['reply', 'resolution_note']),
        draftId: z.string(),
      }).strict()).optional(),
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
    // Phase 2 wave P2-2 (scheduled sweeps), Task A7: `null` for every
    // full/verdict-profile run. Strict all the way down — a finding carries
    // its bounded scalar `evidence` map and the DISPOSITION of its proposal,
    // never the raw `proposedAction` args the model wrote.
    sweep: z.object({
      scheduleId: z.string().nullable(),
      occurrenceKey: z.string().nullable(),
      kinds: z.array(z.string()),
      summary: z.string(),
      evidenceTruncated: z.boolean(),
      findings: z.array(z.object({
        kind: z.string(),
        severity: z.string(),
        deviceId: z.string().nullable(),
        deviceHostname: z.string().nullable(),
        title: z.string(),
        detail: z.string(),
        evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
        proposal: z.object({
          tool: z.string(),
          action: z.string().nullable(),
          disposition: z.enum(['intent_created', 'refused', 'cap_reached', 'error']),
          reason: z.string().nullable(),
          intentId: z.string().nullable(),
        }).strict().nullable(),
      }).strict()),
    }).strict().nullable(),
    // Phase 2 wave P2-3 (weekly org narrative), Task A7: `null` for every
    // non-narrative run. Strict all the way down — the STRUCTURED sections
    // reach the wire; the derived markdown and the weekly `NarrativeContext`
    // the run was built from never do.
    narrative: z.object({
      headline: z.string(),
      sections: z.array(z.object({
        key: z.string(),
        title: z.string(),
        bullets: z.array(z.string()),
      }).strict()),
      reportRunId: z.string().nullable(),
      reportId: z.string().nullable(),
      downloadPath: z.string().nullable(),
      periodStart: z.string().nullable(),
      periodEnd: z.string().nullable(),
      contextTruncated: z.boolean(),
    }).strict().nullable(),
    reportRunId: z.string().nullable(),
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
    // Phase 2 wave P2-2, Task A7 — the web list badge reads this; a
    // schedule-triggered SWEEP is not distinguishable from `triggerKind`.
    profile: z.enum(['full', 'verdict', 'sweep']),
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
    // Phase 2 wave P2-3, Task A7 — the narrative artifact link; null for every
    // non-narrative run.
    reportRunId: null,
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

  // Phase 2 wave P2-4 (#4191), Task A10 — intentIds is the run's own
  // intent_ids column (ground truth for a triage run, see
  // RunTraceRunInput.intentIds's docstring), draftsWritten is a LIVE
  // ticket_drafts query keyed on run_id, pinned to the run's own org.
  it('projects intentIds + draftsWritten for a ticket-triage run', async () => {
    const TRIAGE_INTENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const DRAFT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    let draftWhere: unknown;
    selectMock
      .mockReturnValueOnce(selectChain([runRow({
        triggerKind: 'ticket',
        sessionId: null,
        intentIds: [TRIAGE_INTENT_ID],
        outcome: {
          executedActions: [], proposedActions: [], deniedActions: [], toolExecutionCount: 0,
          ticketProposal: { version: 1, summary: 'Restart the spooler.', notes: [] },
        },
      })])) // run + agent + device join
      .mockReturnValueOnce(selectChain([{
        id: TRIAGE_INTENT_ID, status: 'approved', actionName: 'manage_tickets.comment',
        approvalScope: 'auto', decidedVia: 'ticket_autonomy',
      }])) // intents (sessionId is null, so the ledger read is skipped)
      .mockReturnValueOnce(selectChain(
        [{ id: DRAFT_ID, kind: 'reply' }],
        (predicate) => { draftWhere = predicate; },
      )); // draft rows

    const res = await buildApp().request(`/ai-agents/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = runDetailResponseSchema.parse(body);

    expect(parsed.data.ticketProposal?.intentIds).toEqual([TRIAGE_INTENT_ID]);
    expect(parsed.data.ticketProposal?.draftsWritten).toEqual([{ kind: 'reply', draftId: DRAFT_ID }]);

    // run row, intents, draft rows — no ledger (sessionId null), no sweep
    // hostname read, no narrative artifact read (reportRunId null).
    expect(selectMock).toHaveBeenCalledTimes(3);
    const draftParams = sqlParams(draftWhere);
    expect(draftParams).toContain(ORG_ID);
    expect(draftParams).toContain(RUN_ID);
  });

  // Phase 2 wave P2-4 (#4191), Task A10.
  it('skips the draft-rows read entirely for a non-ticket run', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([runRow({ sessionId: null, intentIds: [] })])) // run + agent + device join
    // No further selects expected — intentIds empty skips intents, sessionId
    // null skips ledger, triggerKind !== 'ticket' skips draft rows.
    ;

    const res = await buildApp().request(`/ai-agents/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  // Phase 2 wave P2-2 (scheduled sweeps), Task A7.
  it('resolves sweep finding hostnames with ONE batched org-pinned read and leaks no raw proposal args', async () => {
    const OTHER_DEVICE_ID = '99999999-9999-4999-8999-999999999999';
    let hostnameWhere: unknown;
    selectMock
      .mockReturnValueOnce(selectChain([runRow({
        sessionId: null,
        intentIds: [],
        deviceId: null,
        deviceHostname: null,
        triggerKind: 'schedule',
        scheduleId: '88888888-8888-4888-8888-888888888888',
        triggerRef: {
          scheduleId: '88888888-8888-4888-8888-888888888888',
          occurrenceKey: '2026-08-29T06:00:00Z',
          sweepKinds: ['service_down'],
        },
        outcome: {
          executedActions: [], proposedActions: [], deniedActions: [], toolExecutionCount: 0,
          sweepFindings: {
            summary: 'One service is down on two machines.',
            findings: [
              {
                kind: 'service_down', severity: 'critical', deviceId: DEVICE_ID,
                title: 'Spooler is stopped', detail: 'Stopped for 3 days.',
                evidence: { state: 'stopped' },
                proposedAction: {
                  tool: 'manage_services', action: 'restart',
                  deviceId: DEVICE_ID, serviceName: 'DoNotLeakSpooler',
                },
              },
              {
                kind: 'service_down', severity: 'high', deviceId: OTHER_DEVICE_ID,
                title: 'W32Time is stopped', detail: 'Stopped for 1 day.',
                evidence: { state: 'stopped' },
              },
            ],
          },
          sweepProposals: [{
            findingIndex: 0, tool: 'manage_services', action: 'restart',
            deviceId: DEVICE_ID, disposition: 'intent_created',
            intentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          }],
          sweepEvidenceTruncated: true,
        },
      })]))
      // The ONE batched hostname read (no session, no intent ids, so this is
      // the only other query the route makes).
      .mockReturnValueOnce(selectChain(
        [{ id: DEVICE_ID, hostname: 'WKS-042' }],
        (predicate) => { hostnameWhere = predicate; },
      ));

    const res = await buildApp().request(`/ai-agents/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = runDetailResponseSchema.parse(body);

    // Two selects total: the run row and ONE batched device read for BOTH
    // findings — never a lookup per finding.
    expect(selectMock).toHaveBeenCalledTimes(2);
    // Review round 1, IMPORTANT 1: the hostname read is pinned to the RUN's
    // own org, not just the caller's accessible set — `sweepDeviceIds` come
    // out of MODEL-AUTHORED outcome jsonb, so a partner-scoped caller must
    // not be able to have a sibling org's hostname rendered inside this run.
    // Asserting the bound params (not the `org_id` column name) is what makes
    // this non-vacuous: binding some OTHER org's id would still print
    // `org_id` in the SQL text.
    const hostnameParams = sqlParams(hostnameWhere);
    expect(hostnameParams).toContain(ORG_ID);
    expect(hostnameParams).toContain(DEVICE_ID);
    expect(hostnameParams).toContain(OTHER_DEVICE_ID);
    expect(parsed.data.sweep).toEqual({
      scheduleId: '88888888-8888-4888-8888-888888888888',
      occurrenceKey: '2026-08-29T06:00:00Z',
      kinds: ['service_down'],
      summary: 'One service is down on two machines.',
      evidenceTruncated: true,
      findings: [
        {
          kind: 'service_down', severity: 'critical', deviceId: DEVICE_ID,
          deviceHostname: 'WKS-042', title: 'Spooler is stopped', detail: 'Stopped for 3 days.',
          evidence: { state: 'stopped' },
          proposal: {
            tool: 'manage_services', action: 'restart', disposition: 'intent_created',
            reason: null, intentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          },
        },
        {
          kind: 'service_down', severity: 'high', deviceId: OTHER_DEVICE_ID,
          // Not in the batched read's result (deleted, or RLS-invisible) —
          // the finding still projects, with a null hostname.
          deviceHostname: null, title: 'W32Time is stopped', detail: 'Stopped for 1 day.',
          evidence: { state: 'stopped' }, proposal: null,
        },
      ],
    });

    const json = JSON.stringify(body);
    for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
      expect(json).not.toContain(`"${forbidden}"`);
    }
    expect(json).not.toContain('proposedAction');
    expect(json).not.toContain('DoNotLeakSpooler');
  });

  // #4189 bug fix: the model omitted `finding.deviceId` while
  // `proposedAction.deviceId` correctly named an evidence device — the
  // batched hostname read must resolve THAT device (via `sweepProposals`,
  // not just `sweepFindings`), or the finding renders a null hostname even
  // though `projectSweep` now falls back to the proposal's device.
  /**
   * Phase 2 wave P2-3 (weekly org narrative), Task A7 — the artifact read.
   *
   * `report_runs` has no `org_id` of its own, so the tenancy pin lives on the
   * join to `reports`. Asserting the BOUND params (not just that `org_id`
   * appears in the SQL) is what makes this non-vacuous: binding some other
   * org's id would still print the column name.
   */
  it('reads the linked narrative artifact through an org-pinned join and projects only its scalars', async () => {
    const NARRATIVE_SCHEDULE_ID = '88888888-8888-4888-8888-888888888888';
    const REPORT_ID = '77777777-7777-4777-8777-777777777777';
    const REPORT_RUN_ID = '66666666-6666-4666-8666-666666666666';
    let artifactWhere: unknown;
    selectMock
      .mockReturnValueOnce(selectChain([runRow({
        sessionId: null,
        intentIds: [],
        deviceId: null,
        deviceHostname: null,
        triggerKind: 'schedule',
        scheduleId: NARRATIVE_SCHEDULE_ID,
        triggerRef: { scheduleId: NARRATIVE_SCHEDULE_ID, occurrenceKey: '2026-08-31T07:00:00+02:00' },
        reportRunId: REPORT_RUN_ID,
        outcome: {
          executedActions: [], proposedActions: [], deniedActions: [], toolExecutionCount: 0,
          narrative: {
            version: 1,
            headline: 'A quiet week.',
            sections: [{ key: 'overview', title: 'Overview', bullets: ['Nothing needed a person.'] }],
            markdown: '# A quiet week.',
          },
          narrativeReport: { reportId: REPORT_ID, reportRunId: REPORT_RUN_ID },
        },
      })]))
      .mockReturnValueOnce(selectChain(
        [{
          reportRunId: REPORT_RUN_ID,
          reportId: REPORT_ID,
          periodStart: '2026-08-24T07:00:00+02:00',
          periodEnd: '2026-08-31T07:00:00+02:00',
          contextTruncated: true,
        }],
        (predicate) => { artifactWhere = predicate; },
      ));

    const res = await buildApp().request(`/ai-agents/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
    const parsed = runDetailResponseSchema.parse(await res.json());

    // Two selects: the run row and the artifact. No session, no intent ids and
    // no sweep findings, so nothing else is queried.
    expect(selectMock).toHaveBeenCalledTimes(2);
    const params = sqlParams(artifactWhere);
    expect(params).toContain(ORG_ID);
    expect(params).toContain(REPORT_RUN_ID);

    expect(parsed.data.reportRunId).toBe(REPORT_RUN_ID);
    expect(parsed.data.narrative).toEqual({
      headline: 'A quiet week.',
      sections: [{ key: 'overview', title: 'Overview', bullets: ['Nothing needed a person.'] }],
      reportRunId: REPORT_RUN_ID,
      reportId: REPORT_ID,
      downloadPath: `/api/reports/runs/${REPORT_RUN_ID}/download`,
      periodStart: '2026-08-24T07:00:00+02:00',
      periodEnd: '2026-08-31T07:00:00+02:00',
      contextTruncated: true,
    });
  });

  it('skips the artifact read entirely for a run that links none', async () => {
    selectMock.mockReturnValueOnce(selectChain([runRow({ sessionId: null, intentIds: [] })]));

    const res = await buildApp().request(`/ai-agents/runs/${RUN_ID}`);

    expect(res.status).toBe(200);
    expect(selectMock).toHaveBeenCalledTimes(1);
    const parsed = runDetailResponseSchema.parse(await res.json());
    expect(parsed.data.narrative).toBeNull();
    expect(parsed.data.reportRunId).toBeNull();
  });

  it('resolves a finding\'s hostname from its proposal device when the finding omitted deviceId', async () => {
    let hostnameWhere: unknown;
    selectMock
      .mockReturnValueOnce(selectChain([runRow({
        sessionId: null,
        intentIds: [],
        deviceId: null,
        deviceHostname: null,
        triggerKind: 'schedule',
        scheduleId: '88888888-8888-4888-8888-888888888888',
        triggerRef: {
          scheduleId: '88888888-8888-4888-8888-888888888888',
          sweepKinds: ['service_down'],
        },
        outcome: {
          executedActions: [], proposedActions: [], deniedActions: [], toolExecutionCount: 0,
          sweepFindings: {
            summary: 'One service is down.',
            findings: [{
              kind: 'service_down', severity: 'critical',
              // deviceId intentionally omitted — only the proposal names it.
              title: 'Spooler is stopped', detail: 'Stopped for 3 days.',
              evidence: { state: 'stopped' },
              proposedAction: {
                tool: 'manage_services', action: 'restart',
                deviceId: DEVICE_ID, serviceName: 'Spooler',
              },
            }],
          },
          sweepProposals: [{
            findingIndex: 0, tool: 'manage_services', action: 'restart',
            deviceId: DEVICE_ID, disposition: 'intent_created',
            intentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          }],
          sweepEvidenceTruncated: false,
        },
      })]))
      .mockReturnValueOnce(selectChain(
        [{ id: DEVICE_ID, hostname: 'WKS-042' }],
        (predicate) => { hostnameWhere = predicate; },
      ));

    const res = await buildApp().request(`/ai-agents/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = runDetailResponseSchema.parse(body);

    const hostnameParams = sqlParams(hostnameWhere);
    expect(hostnameParams).toContain(DEVICE_ID);
    expect(parsed.data.sweep?.findings[0]).toMatchObject({
      deviceId: DEVICE_ID,
      deviceHostname: 'WKS-042',
    });
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
        status: 'completed', triggerKind: 'manual', profile: 'full', runVerdict: 'remediated',
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
      status: 'completed', triggerKind: 'schedule', profile: 'full', runVerdict: null,
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
      status: 'completed', triggerKind: 'schedule', profile: 'full', runVerdict: null,
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
        status: 'completed', triggerKind: 'schedule', profile: 'full', runVerdict: 'remediated',
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
        status: 'completed', triggerKind: 'manual', profile: 'full', runVerdict: 'remediated',
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
        status: 'completed', triggerKind: 'manual', profile: 'full', runVerdict: 'remediated',
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

// Final-review fix (#4189, item 8). The 409 mapping used to read `err.code`
// off the TOP-LEVEL error, which every Drizzle-issued insert defeats:
// DrizzleQueryError's own `.code` is undefined and the real SQLSTATE lives on
// `.cause`. The create race therefore surfaced as an unactionable 500 in
// exactly the situation the mapping exists for. It is also now pinned to the
// two `ai_agents` kind indexes — an unrelated 23505 from some other statement
// in the same handler must not be reported as "an agent of this kind already
// exists".
describe('mapError — agent-kind unique violation (#4189)', () => {
  const pgErr = (constraint: string) =>
    Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
      code: '23505',
      constraint_name: constraint,
    });
  const drizzleWrap = (cause: unknown) =>
    Object.assign(new Error('Failed query: insert into "ai_agents" ...'), { cause });

  const ctxWith = (jsonMock: ReturnType<typeof vi.fn>) =>
    ({ json: jsonMock }) as unknown as Parameters<typeof mapError>[0];

  it('maps a DrizzleQueryError-WRAPPED 23505 on either kind index to 409', async () => {
    for (const constraint of ['ai_agents_partner_kind_uq', 'ai_agents_org_kind_uq']) {
      const jsonMock = vi.fn((body: unknown, status: number) => ({ body, status }));

      mapError(ctxWith(jsonMock), drizzleWrap(pgErr(constraint)));

      expect(jsonMock).toHaveBeenCalledWith(
        { error: 'An agent of this kind already exists', code: 'agent_kind_exists' },
        409,
      );
    }
  });

  it('still maps an UNWRAPPED 23505 (the pre-Drizzle shape) to 409', async () => {
    const jsonMock = vi.fn((body: unknown, status: number) => ({ body, status }));

    mapError(ctxWith(jsonMock), pgErr('ai_agents_org_kind_uq'));

    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ code: 'agent_kind_exists' }), 409);
  });

  it('rethrows a 23505 from an UNRELATED constraint rather than claiming a kind conflict', async () => {
    // Unwrapped on purpose: this is the shape the old top-level `err.code`
    // check DID catch, and mis-reported as an agent-kind conflict.
    for (const err of [
      pgErr('ai_agent_runs_org_dedupe_key_uq'),
      drizzleWrap(pgErr('ai_agent_runs_org_dedupe_key_uq')),
    ]) {
      const jsonMock = vi.fn((body: unknown, status: number) => ({ body, status }));

      expect(() => mapError(ctxWith(jsonMock), err)).toThrow();
      expect(jsonMock).not.toHaveBeenCalled();
    }
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

/**
 * Regression for #4020. The create race is settled by the partial unique index,
 * and the insert that loses it is issued through Drizzle — which catches the
 * postgres-js `PostgresError` and rethrows a `DrizzleQueryError` whose own
 * `.code` is undefined, with the SQLSTATE on `.cause`. A flat fixture passes
 * whether or not the handler unwraps, so the wrapped shape is the one that
 * actually discriminates.
 */
describe('mapError — create-race unique violation (#4020)', () => {
  const callMapError = (err: unknown) => {
    const jsonMock = vi.fn((body: unknown, status: number) => ({ body, status }));
    const ctx = { json: jsonMock } as unknown as Parameters<typeof mapError>[0];
    let threw: unknown;
    try {
      mapError(ctx, err);
    } catch (e) {
      threw = e;
    }
    return { jsonMock, threw };
  };

  const CONFLICT = { error: 'An agent of this kind already exists', code: 'agent_kind_exists' };

  it('maps a flat postgres.js 23505 to 409', () => {
    const { jsonMock } = callMapError(
      Object.assign(
        new Error('duplicate key value violates unique constraint "ai_agents_org_kind_uq"'),
        { code: '23505', constraint_name: 'ai_agents_org_kind_uq' },
      ),
    );

    expect(jsonMock).toHaveBeenCalledWith(CONFLICT, 409);
  });

  it('maps a 23505 WRAPPED in a DrizzleQueryError to 409, not a 500', () => {
    // Faithful to Drizzle: own `.code` undefined, SQLSTATE on `.cause`.
    const cause = Object.assign(
      new Error('duplicate key value violates unique constraint "ai_agents_org_kind_uq"'),
      { code: '23505', constraint_name: 'ai_agents_org_kind_uq' },
    );
    const wrapped = Object.assign(new Error('Failed query: insert into "ai_agents" ...'), { cause });
    wrapped.name = 'DrizzleQueryError';

    const { jsonMock, threw } = callMapError(wrapped);

    expect(threw).toBeUndefined();
    expect(jsonMock).toHaveBeenCalledWith(CONFLICT, 409);
  });

  /**
   * The constraint scoping is itself a discriminating property, and needs a
   * fixture that can tell the difference. A 23505 from some OTHER unique index
   * does not mean "this kind is taken", so answering `agent_kind_exists` would
   * be a wrong-but-plausible 409 that nothing logs — strictly worse than the
   * 500 it would otherwise get, which is loud and reaches Sentry.
   */
  it('does not mislabel a 23505 from an unrelated constraint as agent_kind_exists', () => {
    const cause = Object.assign(
      new Error('duplicate key value violates unique constraint "some_other_table_uq"'),
      { code: '23505', constraint_name: 'some_other_table_uq' },
    );
    const wrapped = Object.assign(new Error('Failed query: insert into "some_other_table" ...'), { cause });
    wrapped.name = 'DrizzleQueryError';

    const { jsonMock, threw } = callMapError(wrapped);

    expect(threw).toBe(wrapped);
    expect(jsonMock).not.toHaveBeenCalled();
  });

  it('maps a wrapped 23505 on the PARTNER-wide index to 409 too', () => {
    const cause = Object.assign(
      new Error('duplicate key value violates unique constraint "ai_agents_partner_kind_uq"'),
      { code: '23505', constraint_name: 'ai_agents_partner_kind_uq' },
    );
    const wrapped = Object.assign(new Error('Failed query: insert into "ai_agents" ...'), { cause });
    wrapped.name = 'DrizzleQueryError';

    const { jsonMock, threw } = callMapError(wrapped);

    expect(threw).toBeUndefined();
    expect(jsonMock).toHaveBeenCalledWith(CONFLICT, 409);
  });

  it('rethrows a wrapped SQLSTATE that is not a unique violation', () => {
    const cause = Object.assign(new Error('null value in column violates not-null constraint'), { code: '23502' });
    const wrapped = Object.assign(new Error('Failed query: insert into "ai_agents" ...'), { cause });
    wrapped.name = 'DrizzleQueryError';

    const { jsonMock, threw } = callMapError(wrapped);

    expect(threw).toBe(wrapped);
    expect(jsonMock).not.toHaveBeenCalled();
  });
});

// Task 8 (#4193 A8) — GET /impact, POST /impact/rebuild, PUT/DELETE
// /impact/weights. Registered ahead of GET /:id (line 716) for the same
// reason as /effective, /policy-decidable-keys and /runs/:runId above it —
// a literal path segment must not fall into the `:id` param route.
describe('AI agents impact routes — registration order (#4193 A8)', () => {
  it('GET /ai-agents/impact resolves the impact handler, not GET /:id', async () => {
    const app = buildApp();

    const res = await app.request('/ai-agents/impact');

    expect(res.status).toBe(200);
    expect(loadImpactSummaryMock).toHaveBeenCalledTimes(1);
    expect(getAgentMock).not.toHaveBeenCalled();
  });

  it('GET /ai-agents/:id still resolves the agent handler for a literal uuid', async () => {
    // A fuller fixture than the shared `agent()` helper — mapRow (the GET
    // /:id wire mapper) reads createdAt/updatedAt directly, which the other
    // fixtures never exercise since every other test on this file mocks
    // getAgent as an authorization/visibility handle, not a rendered row.
    getAgentMock.mockResolvedValue({
      ...agent(),
      enabled: true,
      mode: 'supervised',
      model: 'default',
      toolAllowlist: [],
      protectedResources: [],
      limits: AI_AGENT_LIMIT_DEFAULTS,
      triggers: [],
      recipients: [],
      actAssets: {},
      instructions: null,
      cooldownSeconds: 0,
      disabledAt: null,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const app = buildApp();

    const res = await app.request(`/ai-agents/${AGENT_ID}`);

    expect(res.status).toBe(200);
    expect(getAgentMock).toHaveBeenCalledWith(expect.anything(), AGENT_ID);
    expect(loadImpactSummaryMock).not.toHaveBeenCalled();
  });
});

describe('GET /ai-agents/impact', () => {
  it('defaults the window to 30 and passes orgId through as undefined', async () => {
    const app = buildApp();

    const res = await app.request('/ai-agents/impact');

    expect(res.status).toBe(200);
    expect(loadImpactSummaryMock).toHaveBeenCalledWith(
      expect.anything(),
      { window: 30, orgId: undefined },
    );
  });

  it('passes ?window=90 through to loadImpactSummary', async () => {
    const app = buildApp();

    const res = await app.request('/ai-agents/impact?window=90');

    expect(res.status).toBe(200);
    expect(loadImpactSummaryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ window: 90 }),
    );
  });

  it('rejects an unsupported window', async () => {
    const app = buildApp();

    const res = await app.request('/ai-agents/impact?window=1');

    expect(res.status).toBe(400);
    expect(loadImpactSummaryMock).not.toHaveBeenCalled();
  });

  it('requires an orgId for a system-scoped caller', async () => {
    const app = buildApp(false, { scope: 'system', partnerId: null });

    const res = await app.request('/ai-agents/impact');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'org_id_required',
      message: 'A system-scoped impact query must name one organization — one weight set belongs to one partner.',
    });
    expect(loadImpactSummaryMock).not.toHaveBeenCalled();
  });

  it('answers 200 for a system-scoped caller that names an accessible org', async () => {
    const app = buildApp(false, { scope: 'system', partnerId: null, canAccessOrg: () => true });

    const res = await app.request(`/ai-agents/impact?orgId=${OTHER_ORG_ID}`);

    expect(res.status).toBe(200);
    expect(loadImpactSummaryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: OTHER_ORG_ID }),
    );
  });

  it('rejects an inaccessible orgId with 403', async () => {
    const app = buildApp(false, { canAccessOrg: () => false });

    const res = await app.request(`/ai-agents/impact?orgId=${OTHER_ORG_ID}`);

    expect(res.status).toBe(403);
    expect(loadImpactSummaryMock).not.toHaveBeenCalled();
  });
});

describe('POST /ai-agents/impact/rebuild', () => {
  it('answers 409 too_many_orgs when the accessible set exceeds the cap', async () => {
    const orgIds = Array.from({ length: AI_AGENT_IMPACT_REBUILD_MAX_ORGS + 1 }, (_, i) => `org-${i}`);
    const app = buildApp(false, { accessibleOrgIds: orgIds });

    const res = await app.request('/ai-agents/impact/rebuild', { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'too_many_orgs',
      limit: AI_AGENT_IMPACT_REBUILD_MAX_ORGS,
      count: orgIds.length,
    });
    expect(enqueueImpactRollupForOrgsMock).not.toHaveBeenCalled();
  });

  it('enqueues a 90-day rebuild ending at the last complete UTC day and audits it', async () => {
    const orgIds = [ORG_ID, OTHER_ORG_ID, 'third-org-id'];
    const app = buildApp(false, { accessibleOrgIds: orgIds });

    const res = await app.request('/ai-agents/impact/rebuild', { method: 'POST' });

    const through = lastCompleteUtcDay();
    const from = shiftUtcDay(through, -(AI_AGENT_IMPACT_REBUILD_DAYS - 1));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: 3, from, through });
    expect(enqueueImpactRollupForOrgsMock).toHaveBeenCalledWith(orgIds, from, through);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ai_agent_impact.rebuild_requested',
        details: { orgCount: 3, from, through },
      }),
    );
  });

  it('rejects a rebuild request for an inaccessible org', async () => {
    const app = buildApp(false, { canAccessOrg: () => false });

    const res = await app.request(`/ai-agents/impact/rebuild?orgId=${OTHER_ORG_ID}`, { method: 'POST' });

    expect(res.status).toBe(403);
    expect(enqueueImpactRollupForOrgsMock).not.toHaveBeenCalled();
  });

  it('requires an orgId for a system-scoped caller with no accessible-org list', async () => {
    const app = buildApp(false, { scope: 'system', partnerId: null, accessibleOrgIds: null });

    const res = await app.request('/ai-agents/impact/rebuild', { method: 'POST' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'org_id_required' }));
    expect(enqueueImpactRollupForOrgsMock).not.toHaveBeenCalled();
  });
});

describe('PUT /ai-agents/impact/weights', () => {
  const validBody = { fixExecuted: 1200 };

  it('denies a selected-access partner member', async () => {
    const app = buildApp(false, { scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'selected' });

    const res = await app.request('/ai-agents/impact/weights', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(saveImpactWeightsMock).not.toHaveBeenCalled();
  });

  it('denies an organization-scoped caller', async () => {
    const app = buildApp();

    const res = await app.request('/ai-agents/impact/weights', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(403);
    expect(saveImpactWeightsMock).not.toHaveBeenCalled();
  });

  it('accepts a full-partner-admin write and audits before/after', async () => {
    const app = buildApp(false, { scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'all' });

    const res = await app.request('/ai-agents/impact/weights', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { effective: { ...DEFAULT_IMPACT_WEIGHTS, fixExecuted: 1200 }, overrides: { fixExecuted: 1200 } },
    });
    expect(saveImpactWeightsMock).toHaveBeenCalledWith(expect.anything(), PARTNER_ID, validBody);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: null,
        action: 'ai_agent_impact_weights.updated',
        details: { before: null, after: { fixExecuted: 1200 } },
      }),
    );
  });

  it('rejects an out-of-range weight value', async () => {
    const app = buildApp(false, { scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'all' });

    const res = await app.request('/ai-agents/impact/weights', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixExecuted: 86401 }),
    });

    expect(res.status).toBe(400);
    expect(saveImpactWeightsMock).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized key (strict schema)', async () => {
    const app = buildApp(false, { scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'all' });

    const res = await app.request('/ai-agents/impact/weights', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bogus: 1 }),
    });

    expect(res.status).toBe(400);
    expect(saveImpactWeightsMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /ai-agents/impact/weights', () => {
  it('resets to defaults for a full-partner-admin', async () => {
    saveImpactWeightsMock.mockResolvedValue({
      before: { fixExecuted: 1200 },
      after: null,
      effective: { ...DEFAULT_IMPACT_WEIGHTS },
    });
    const app = buildApp(false, { scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'all' });

    const res = await app.request('/ai-agents/impact/weights', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { effective: DEFAULT_IMPACT_WEIGHTS, overrides: null } });
    expect(saveImpactWeightsMock).toHaveBeenCalledWith(expect.anything(), PARTNER_ID, null);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ai_agent_impact_weights.updated',
        details: { before: { fixExecuted: 1200 }, after: null },
      }),
    );
  });

  it('denies a non-full-partner caller', async () => {
    const app = buildApp();

    const res = await app.request('/ai-agents/impact/weights', { method: 'DELETE' });

    expect(res.status).toBe(403);
    expect(saveImpactWeightsMock).not.toHaveBeenCalled();
  });
});
