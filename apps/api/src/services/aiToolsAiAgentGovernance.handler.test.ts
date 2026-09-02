/**
 * `manage_ai_agents` DISPATCH SEAM (P2-5 Task 15, #4192).
 *
 * The grant itself is covered by aiAgents/supervisedKeyGrant.test.ts. What
 * this file pins is everything the handler decides BEFORE and AFTER it —
 * which is where the tool's two structural authority rules live:
 *
 *   - `orgId` is an argument but never an authority: it must equal the
 *     EXECUTING context's org (which both release paths pin to the intent's
 *     own `org_id`), and the executor is never reached otherwise;
 *   - a refusal is RETURNED as `{error}`, not thrown — `isReturnedToolError`
 *     (jobs/intentReleaseWorker.ts) is what turns that into
 *     `failed:tool_returned_error` instead of a false success.
 *
 * Separate from aiToolsAiAgentGovernance.test.ts on purpose: that suite is a
 * REGISTRY contract and deliberately runs with no `vi.mock` at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthContext } from '../middleware/auth';
import type { ToolExecutionContext } from './toolExecutionContext';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const INTENT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const AGENT_ID = '55555555-5555-4555-8555-555555555555';
const ORG_AGENT_ID = '66666666-6666-4666-8666-666666666666';
const OP_KEY = 'manage_services:restart';

const authorizeSupervisedKeyMock = vi.hoisted(() => vi.fn());

vi.mock('./aiAgents/supervisedKeyGrant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./aiAgents/supervisedKeyGrant')>();
  return { ...actual, authorizeSupervisedKey: authorizeSupervisedKeyMock };
});

import { registerAiAgentGovernanceTools } from './aiToolsAiAgentGovernance';
import { SupervisedKeyGrantError } from './aiAgents/supervisedKeyGrant';
import type { AiTool } from './aiTools';

function handler() {
  const registry = new Map<string, AiTool>();
  registerAiAgentGovernanceTools(registry);
  return registry.get('manage_ai_agents')!.handler;
}

function auth(overrides: Record<string, unknown> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: USER_ID, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
    orgId: ORG_ID,
    ...overrides,
  } as unknown as AuthContext;
}

const ARGS = { action: 'authorize_supervised_key', kind: 'triage', opKey: OP_KEY, orgId: ORG_ID };
const RELEASE: ToolExecutionContext = { actionIntentId: INTENT_ID };

/**
 * `context` is NOT a defaulted parameter: `undefined` would silently fall back
 * to the default, which is precisely the "no release context" case this suite
 * has to be able to express.
 */
async function call(opts: {
  args?: Record<string, unknown>;
  auth?: AuthContext;
  context?: ToolExecutionContext;
} = {}): Promise<Record<string, unknown>> {
  const context = 'context' in opts ? opts.context : RELEASE;
  return JSON.parse(await handler()(opts.args ?? ARGS, opts.auth ?? auth(), context));
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizeSupervisedKeyMock.mockResolvedValue({
    agentId: AGENT_ID,
    orgAgentId: ORG_AGENT_ID,
    keys: [OP_KEY],
  });
});

describe('manage_ai_agents handler', () => {
  it('grants with the EXECUTING context org and the release intent, never the argument', async () => {
    const body = await call();

    expect(authorizeSupervisedKeyMock).toHaveBeenCalledWith({
      orgId: ORG_ID,
      kind: 'triage',
      opKey: OP_KEY,
      intentId: INTENT_ID,
      actorUserId: USER_ID,
    });
    expect(body).toEqual({
      success: true,
      data: { agentId: AGENT_ID, orgAgentId: ORG_AGENT_ID, supervisedActionKeys: [OP_KEY] },
    });
  });

  it('refuses an orgId argument that names any other organization', async () => {
    const body = await call({ args: { ...ARGS, orgId: OTHER_ORG_ID } });

    expect(body).toEqual({ error: 'org_mismatch', message: expect.any(String) });
    expect(authorizeSupervisedKeyMock).not.toHaveBeenCalled();
  });

  it('refuses when the executing context carries no org at all', async () => {
    const body = await call({ auth: auth({ orgId: null }) });

    expect(body).toEqual({ error: 'org_mismatch', message: expect.any(String) });
    expect(authorizeSupervisedKeyMock).not.toHaveBeenCalled();
  });

  it('refuses outside a release path — a grant with no approval has no provenance', async () => {
    const body = await call({ context: undefined });

    expect(body).toEqual({ error: 'no_authorizing_intent', message: expect.any(String) });
    expect(authorizeSupervisedKeyMock).not.toHaveBeenCalled();
  });

  it('refuses the ai_agent principal outright (it could grant itself authority)', async () => {
    const body = await call({
      auth: auth({ principal: { kind: 'ai_agent', agentId: AGENT_ID, runId: INTENT_ID } }),
    });

    expect(body).toEqual({ error: 'non_human_origin', message: expect.any(String) });
    expect(authorizeSupervisedKeyMock).not.toHaveBeenCalled();
  });

  it('renders an executor refusal as a RETURNED tool error, never a throw', async () => {
    authorizeSupervisedKeyMock.mockRejectedValue(
      new SupervisedKeyGrantError('not_eligible', 'no longer eligible'),
    );

    const body = await call();

    // isReturnedToolError's exact shape: `error` present, and none of
    // success/data/configured — anything else reads as a completed release.
    expect(body).toEqual({ error: 'not_eligible', message: 'no longer eligible' });
    expect(body).not.toHaveProperty('success');
    expect(body).not.toHaveProperty('data');
  });

  /**
   * The duplicate-request outcome, pinned because it is the one refusal an
   * operator actually meets and Tasks 17/18 have to render it. A second
   * approved intent for a key this org already holds is a REFUSAL, not a
   * quiet success: completing it would either overwrite
   * `ai_agent_graduation.promoted_intent_id` (which must keep naming the
   * approval that really granted the key) or complete an authority-grant
   * intent with no audit row behind it.
   */
  it('renders a duplicate request as failed:already_granted, never a false success', async () => {
    authorizeSupervisedKeyMock.mockRejectedValue(
      new SupervisedKeyGrantError('already_granted', `"${OP_KEY}" is already authorized`),
    );

    const body = await call();

    expect(body).toEqual({
      error: 'already_granted',
      message: `"${OP_KEY}" is already authorized`,
    });
    expect(body).not.toHaveProperty('success');
    expect(body).not.toHaveProperty('data');
  });

  it('lets an unexpected failure THROW so the release records execution_error', async () => {
    authorizeSupervisedKeyMock.mockRejectedValue(new Error('connection terminated'));

    await expect(handler()(ARGS, auth(), RELEASE)).rejects.toThrow('connection terminated');
  });
});
