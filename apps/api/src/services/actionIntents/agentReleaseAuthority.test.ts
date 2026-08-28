import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted shared mock state. The REAL checkAgentGuardrails and the REAL
// buildAgentAuthContext/assertRunOwnership run in this suite — the whole point
// of the stricter-combination veto is the structural gate itself, so stubbing
// it would make every test vacuous. Only the db and the effective-policy
// resolver are mocked.
// ---------------------------------------------------------------------------

const { dbState, policyState } = vi.hoisted(() => ({
  dbState: {
    selectAgentRunsResults: [] as unknown[][],
    selectAgentsResults: [] as unknown[][],
    selectOrgsResults: [] as unknown[][],
    selectDevicesResults: [] as unknown[][],
  },
  policyState: {
    resolveEffectiveAgent: vi.fn(),
  },
}));

vi.mock('../../db', async () => {
  const { aiAgentRuns, aiAgents } = await import('../../db/schema/aiAgents');
  const { organizations } = await import('../../db/schema/orgs');
  const { devices } = await import('../../db/schema/devices');
  const resultBox = (getResult: () => unknown) => ({
    limit: vi.fn(() => Promise.resolve(getResult())),
  });
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn(() => {
            if (table === aiAgentRuns) return resultBox(() => dbState.selectAgentRunsResults.shift() ?? []);
            if (table === aiAgents) return resultBox(() => dbState.selectAgentsResults.shift() ?? []);
            if (table === organizations) return resultBox(() => dbState.selectOrgsResults.shift() ?? []);
            if (table === devices) return resultBox(() => dbState.selectDevicesResults.shift() ?? []);
            throw new Error('unexpected select table in mock');
          }),
        })),
      })),
    },
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('../aiAgents/effectivePolicy', () => ({
  resolveEffectiveAgent: policyState.resolveEffectiveAgent,
}));

import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentPolicy } from '@breeze/shared';
import type { ActionIntent } from '../../db/schema/actionIntents';
import { checkAgentReleaseAuthority } from './agentReleaseAuthority';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const effectivePolicy = (overrides: Partial<AiAgentPolicy> = {}): AiAgentPolicy => ({
  enabled: true,
  mode: 'shadow',
  model: null,
  toolAllowlist: ['manage_services:restart'],
  protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
  limits: AI_AGENT_LIMIT_DEFAULTS,
  triggers: { alertSeverities: ['critical'], respectMaintenanceWindows: true },
  recipients: { userIds: [], roleIds: [] },
  actAssets: { scriptIds: [] },
  instructions: null,
  cooldownSeconds: 0,
  ...overrides,
});

const runRow = (snapshotEffective: AiAgentPolicy = effectivePolicy()) => ({
  id: 'run-1',
  agentId: 'agent-1',
  orgId: 'org-1',
  deviceId: 'dev-1',
  policySnapshot: {
    schemaVersion: 1,
    agentId: 'agent-1',
    kind: 'triage',
    effective: snapshotEffective,
    provenance: {},
    resolvedAt: '2026-08-23T00:00:00.000Z',
  },
});

const agentRow = {
  id: 'agent-1', orgId: null, partnerId: 'partner-1', name: 'Alert Triage', kind: 'triage',
};

const resolvedAgent = (eff: AiAgentPolicy = effectivePolicy(), agentId = 'agent-1') => ({
  schemaVersion: 1,
  agentId,
  kind: 'triage',
  effective: eff,
  provenance: {},
  resolvedAt: '2026-08-23T01:00:00.000Z',
});

function intentFixture(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    id: 'intent-1',
    orgId: 'org-1',
    partnerId: 'partner-1',
    requestedByUserId: null,
    requestingApiKeyId: null,
    requestingAgentRunId: 'run-1',
    originPrincipalKind: 'ai_agent',
    originPrincipalId: 'agent-1',
    source: 'ai_agent',
    actionName: 'manage_services',
    arguments: { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler', siteId: 'site-a' },
    riskTier: 3,
    ...overrides,
  } as ActionIntent;
}

function seedHappyRows(overrides: {
  run?: unknown; agent?: unknown; org?: unknown; deviceSiteId?: string | null;
} = {}) {
  dbState.selectAgentRunsResults.push([overrides.run ?? runRow()]);
  dbState.selectAgentsResults.push([overrides.agent ?? agentRow]);
  dbState.selectOrgsResults.push([overrides.org ?? { partnerId: 'partner-1' }]);
  dbState.selectDevicesResults.push([{ siteId: overrides.deviceSiteId === undefined ? 'site-a' : overrides.deviceSiteId }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  dbState.selectAgentRunsResults.length = 0;
  dbState.selectAgentsResults.length = 0;
  dbState.selectOrgsResults.length = 0;
  dbState.selectDevicesResults.length = 0;
  policyState.resolveEffectiveAgent.mockResolvedValue(resolvedAgent());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The stricter-combination veto
// ---------------------------------------------------------------------------

describe('checkAgentReleaseAuthority', () => {
  it('passes when both snapshot and current policy yield propose', async () => {
    seedHappyRows();

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toEqual({ ok: true });
    // The current policy is resolved through the reconstructed AGENT auth
    // (structural, never user RBAC) for the run's org + the agent's kind.
    expect(policyState.resolveEffectiveAgent).toHaveBeenCalledTimes(1);
    const [auth, orgId, kind] = policyState.resolveEffectiveAgent.mock.calls[0]!;
    expect(auth.principal).toEqual({ kind: 'ai_agent', agentId: 'agent-1', runId: 'run-1' });
    expect(orgId).toBe('org-1');
    expect(kind).toBe('triage');
  });

  it('vetoes when the CURRENT allowlist dropped the tool (snapshot still allows)', async () => {
    seedHappyRows();
    policyState.resolveEffectiveAgent.mockResolvedValue(
      resolvedAgent(effectivePolicy({ toolAllowlist: [] })),
    );

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { policy: 'current' },
    });
  });

  it('vetoes when the agent was disabled after approval', async () => {
    seedHappyRows();
    policyState.resolveEffectiveAgent.mockResolvedValue(
      resolvedAgent(effectivePolicy({ enabled: false })),
    );

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { policy: 'current' },
    });
  });

  it('vetoes agent_policy_denied when no effective agent resolves any more', async () => {
    seedHappyRows();
    policyState.resolveEffectiveAgent.mockResolvedValue(null);

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { reason: 'no effective agent' },
    });
  });

  it('vetoes when the kill switch is off', async () => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');
    seedHappyRows();

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({ ok: false, errorCode: 'agent_policy_denied' });
  });

  it('vetoes when current mode is off', async () => {
    seedHappyRows();
    policyState.resolveEffectiveAgent.mockResolvedValue(
      resolvedAgent(effectivePolicy({ mode: 'off' })),
    );

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { policy: 'current' },
    });
  });

  it('vetoes agent_identity_changed when the org+kind resolves to a different agent', async () => {
    seedHappyRows();
    policyState.resolveEffectiveAgent.mockResolvedValue(
      resolvedAgent(effectivePolicy(), 'agent-2'),
    );

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({ ok: false, errorCode: 'agent_identity_changed' });
  });

  it('re-resolves the device site at release (device moved site => site-scoped input vetoes)', async () => {
    // The proposal cited siteId 'site-a' and was approved while the device
    // lived there; the device has since moved to site-b. BOTH evaluations use
    // the CURRENT site, so even the snapshot policy now denies.
    seedHappyRows({ deviceSiteId: 'site-b' });

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { policy: 'snapshot' },
    });
  });

  it('fails agent_run_invalid when the run is missing', async () => {
    dbState.selectAgentRunsResults.push([]);

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({ ok: false, errorCode: 'agent_run_invalid' });
    expect(policyState.resolveEffectiveAgent).not.toHaveBeenCalled();
  });

  it('fails agent_run_invalid when the run targets another org than the intent', async () => {
    seedHappyRows({ run: { ...runRow(), orgId: 'org-2' } });

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({ ok: false, errorCode: 'agent_run_invalid' });
  });

  it('fails agent_run_invalid when the run agent does not match originPrincipalId', async () => {
    seedHappyRows({ run: { ...runRow(), agentId: 'agent-9' } });

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({ ok: false, errorCode: 'agent_run_invalid' });
  });

  it('fails agent_run_invalid on ownership mismatch (org agent of another org)', async () => {
    seedHappyRows({ agent: { ...agentRow, orgId: 'org-2', partnerId: null } });

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({ ok: false, errorCode: 'agent_run_invalid' });
  });

  it('fails agent_run_invalid for an intent that is not agent-originated', async () => {
    const result = await checkAgentReleaseAuthority(
      intentFixture({ requestingAgentRunId: null } as Partial<ActionIntent>),
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'agent_run_invalid' });
  });

  it('vetoes on a malformed policy snapshot (fail closed, policy: snapshot)', async () => {
    seedHappyRows({
      run: { ...runRow(), policySnapshot: { schemaVersion: 1, effective: null } },
    });

    const result = await checkAgentReleaseAuthority(intentFixture());

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'agent_policy_denied',
      details: { policy: 'snapshot' },
    });
  });
});
