import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperatorTaskSchema, identityOffboardingInputSchema, type AiOperatorWorkflowDto } from '@breeze/shared';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../components/shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../runAction';
import {
  AGENT_TOOL_ALLOWLIST_MAX,
  WorkflowsLoadError,
  addToolsToAgent,
  createOperatorTaskDraft,
  fetchOperatorWorkflows,
  newClientIdempotencyKey,
  parseOperatorTaskDraft,
  parseStartedOperatorTask,
  startOperatorTask,
} from './aiOperatorWorkflows';

const fetchMock = vi.mocked(fetchWithAuth);

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

const ORG = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';

function workflow(overrides: Partial<AiOperatorWorkflowDto> = {}): AiOperatorWorkflowDto {
  return {
    recipeKey: 'identity_offboarding',
    recipeVersion: 7,
    name: 'Offboard a person',
    summary: 'Remove a departing person’s access.',
    gateClass: 'deterministic',
    targetKinds: ['contact'],
    readiness: 'ready',
    missingCapabilities: [],
    alwaysManualCapabilities: [],
    manualStepCount: 0,
    degradedEffects: [],
    agentId: AGENT,
    agentKind: 'helpdesk',
    ...overrides,
  };
}

function bodyOf(callIndex: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>;
}

beforeEach(() => fetchMock.mockReset());
afterEach(() => vi.clearAllMocks());

describe('fetchOperatorWorkflows', () => {
  it('reads the Library for an explicitly pinned org', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [workflow()] }));
    const rows = await fetchOperatorWorkflows(ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipeKey).toBe('identity_offboarding');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/ai/operator/workflows?orgId=${ORG}`);
    // Pinned, so an ambient org switcher selection can never retarget the read.
    expect((init as { orgIdOverride?: string }).orgIdOverride).toBe(ORG);
  });

  it('throws on a non-2xx and on a malformed envelope, never returning an empty Library', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'nope' }, 500));
    await expect(fetchOperatorWorkflows(ORG)).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(json({ data: 'not-a-list' }));
    await expect(fetchOperatorWorkflows(ORG)).rejects.toThrow();
  });
});

describe('createOperatorTaskDraft', () => {
  it('POSTs the draft body and the parser unwraps the typed draft', async () => {
    const draft = {
      recipeKey: 'identity_offboarding', recipeVersion: 7, input: {}, workflow: workflow(),
      person: { resolved: null, candidates: [] }, plannedEffectTools: ['m365_disable_user'],
      degradedEffectTools: [], manualWork: [],
    };
    fetchMock.mockResolvedValueOnce(json({ data: draft }));
    const result = await runAction({
      request: () => createOperatorTaskDraft({ recipeKey: 'identity_offboarding', recipeVersion: 7, orgId: ORG, inputs: { personHint: 'Dana' } }),
      parseSuccess: parseOperatorTaskDraft,
      errorFallback: 'x',
    });
    expect(result.plannedEffectTools).toEqual(['m365_disable_user']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/ai/operator/task-drafts');
    expect((init as RequestInit).method).toBe('POST');
    expect(bodyOf(0)).toEqual({ recipeKey: 'identity_offboarding', recipeVersion: 7, orgId: ORG, inputs: { personHint: 'Dana' } });
  });

  it('refuses a draft envelope missing its required fields', () => {
    expect(() => parseOperatorTaskDraft({ data: { recipeKey: 'identity_offboarding' } })).toThrow();
  });
});

describe('startOperatorTask', () => {
  it('sends mode live, the recipe key and version the Library returned, and the session key', async () => {
    fetchMock.mockResolvedValueOnce(json({ taskId: 'task-1', replayed: false }, 202));
    const res = await runAction({
      request: () => startOperatorTask({
        workflow: workflow({ recipeVersion: 7 }), orgId: ORG, inputs: { personHint: 'Dana' }, clientIdempotencyKey: 'offboard-abcdef12',
      }),
      parseSuccess: parseStartedOperatorTask,
      errorFallback: 'x',
    });
    expect(res.taskId).toBe('task-1');
    expect(fetchMock.mock.calls[0]![0]).toBe('/ai/operator/tasks');
    expect(bodyOf(0)).toEqual({
      mode: 'live',
      recipeKey: 'identity_offboarding',
      recipeVersion: 7,
      orgId: ORG,
      inputs: { personHint: 'Dana' },
      clientIdempotencyKey: 'offboard-abcdef12',
    });
    // G3: an identity task never cites a source — the route refuses one.
    expect(bodyOf(0)).not.toHaveProperty('sourceKind');
    expect(bodyOf(0)).not.toHaveProperty('sourceId');
  });

  it('surfaces a 409 duplicate as an ActionError carrying the existing task id', async () => {
    fetchMock.mockResolvedValueOnce(json({
      error: 'An offboarding task is already running for this person.',
      code: 'OPERATOR_DUPLICATE_LIVE_TASK',
      taskId: 'task-live',
    }, 409));
    const err = await runAction({
      request: () => startOperatorTask({ workflow: workflow(), orgId: ORG, inputs: {}, clientIdempotencyKey: 'offboard-abcdef12' }),
      errorFallback: 'x',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).status).toBe(409);
    expect((err as ActionError).code).toBe('OPERATOR_DUPLICATE_LIVE_TASK');
    expect(((err as ActionError).body as { taskId: string }).taskId).toBe('task-live');
  });

  it('mints keys long enough for the schema and different per form session', () => {
    const a = newClientIdempotencyKey();
    const b = newClientIdempotencyKey();
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(a.length).toBeLessThanOrEqual(200);
    expect(a).not.toBe(b);
  });
});

describe('addToolsToAgent', () => {
  function agentResponse(toolAllowlist: string[]) {
    return json({ data: { id: AGENT, name: 'Helpdesk', toolAllowlist, enabled: true, mode: 'act' } });
  }

  it('unions the missing tools onto the existing list: order kept, action-scoped entries kept, nothing removed', async () => {
    fetchMock
      .mockResolvedValueOnce(agentResponse(['manage_services:restart', 'run_script', 'm365_disable_user']))
      .mockResolvedValueOnce(json({ data: { id: AGENT } }));
    const res = await addToolsToAgent(AGENT, ['m365_disable_user', 'google_suspend_user', 'google_suspend_user']);
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe(`/ai/agents/${AGENT}`);
    expect((fetchMock.mock.calls[0]![1] as RequestInit | undefined)?.method ?? 'GET').toBe('GET');
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(`/ai/agents/${AGENT}`);
    expect((init as RequestInit).method).toBe('PATCH');
    // ONLY toolAllowlist — no other policy field rides along.
    expect(bodyOf(1)).toEqual({
      toolAllowlist: ['manage_services:restart', 'run_script', 'm365_disable_user', 'google_suspend_user'],
    });
  });

  it('sends nothing when every tool is already allowed', async () => {
    fetchMock.mockResolvedValueOnce(agentResponse(['google_suspend_user']));
    const res = await addToolsToAgent(AGENT, ['google_suspend_user']);
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses client-side, without truncating or sending, when the union would exceed the cap', async () => {
    const full = Array.from({ length: AGENT_TOOL_ALLOWLIST_MAX }, (_, i) => `tool_${i}`);
    fetchMock.mockResolvedValueOnce(agentResponse(full));
    const err = await runAction({
      request: () => addToolsToAgent(AGENT, ['google_suspend_user']),
      errorFallback: 'x',
    }).catch((e: unknown) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).code).toBe('AGENT_TOOL_ALLOWLIST_FULL');
  });

  it('hands a failed agent read straight back, so runAction surfaces it and no PATCH is sent', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Agent not found' }, 404));
    const res = await addToolsToAgent(AGENT, ['google_suspend_user']);
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes an MFA step-up refusal through as an ActionError, never swallowed', async () => {
    fetchMock
      .mockResolvedValueOnce(agentResponse([]))
      .mockResolvedValueOnce(json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403));
    const err = await runAction({ request: () => addToolsToAgent(AGENT, ['google_suspend_user']), errorFallback: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).status).toBe(403);
    expect((err as ActionError).code).toBe('MFA_REQUIRED');
  });

  it.each([
    ['a missing allowlist', { id: AGENT, name: 'Helpdesk' }],
    ['a null allowlist', { id: AGENT, name: 'Helpdesk', toolAllowlist: null }],
    ['a non-string entry', { id: AGENT, name: 'Helpdesk', toolAllowlist: ['run_script', 42] }],
  ])('refuses on %s instead of PATCHing a list built from nothing', async (_label, data) => {
    fetchMock.mockResolvedValueOnce(json({ data }));
    const res = await addToolsToAgent(AGENT, ['google_suspend_user']);
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('admission body vs the server schema', () => {
  it('parses under the shared createOperatorTaskSchema the route validates with', async () => {
    fetchMock.mockResolvedValueOnce(json({ taskId: 't', replayed: false }, 202));
    const inputs = identityOffboardingInputSchema.parse({ contactId: '33333333-3333-4333-8333-333333333333' });
    await startOperatorTask({ workflow: workflow(), orgId: ORG, inputs, clientIdempotencyKey: newClientIdempotencyKey() });
    const body = bodyOf(0);
    expect(createOperatorTaskSchema.safeParse(body).success).toBe(true);
    expect(identityOffboardingInputSchema.safeParse(body.inputs).success).toBe(true);
  });
});

describe('load errors', () => {
  it('carries a 4xx refusal\'s own text and marks it not retryable; a 5xx stays retryable', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Permission denied', code: 'PERMISSION_DENIED' }, 403));
    const refused = await fetchOperatorWorkflows(ORG).catch((e: unknown) => e) as WorkflowsLoadError;
    expect(refused).toBeInstanceOf(WorkflowsLoadError);
    expect(refused.serverMessage).toBe('Permission denied');
    expect(refused.retryable).toBe(false);
    fetchMock.mockResolvedValueOnce(json({ error: 'boom' }, 503));
    const broken = await fetchOperatorWorkflows(ORG).catch((e: unknown) => e) as WorkflowsLoadError;
    expect(broken.serverMessage).toBeNull();
    expect(broken.retryable).toBe(true);
  });
});
