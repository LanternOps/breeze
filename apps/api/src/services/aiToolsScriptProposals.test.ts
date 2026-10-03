import { beforeEach, describe, expect, it, vi } from 'vitest';

const { flagMock, createMock, enqueueMock, waitMock, getMock, verifyDeviceAccessMock, executionsMock } = vi.hoisted(() => ({
  executionsMock: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  verifyDeviceAccessMock: vi.fn(
    async (id: string): Promise<{ device: { id: string; orgId: string } } | { error: string }> =>
      ({ device: { id, orgId: 'org-dev' } }),
  ),
  flagMock: vi.fn(() => true),
  createMock: vi.fn(async () => ({
    proposal: { id: 'p1', status: 'proposed', orgId: 'org-dev' },
    scan: { scannerVersion: '2026-09-11.1', basicHits: [], strictHits: [], touchClasses: ['services'], touchedNames: { services: ['Spooler'], paths: [], registryKeys: [] } },
  })),
  enqueueMock: vi.fn(async () => undefined),
  waitMock: vi.fn(async () => null),
  getMock: vi.fn(async () => null),
}));

/**
 * A small model of `db/index.ts`'s AsyncLocalStorage contexts (#7128), enough
 * to tell a transaction the handler OPENED (and therefore committed before it
 * moved on) from one it merely JOINED. `current` is the context `db` would
 * route to; `runOutsideDbContext` hides it for the callback's lifetime, and
 * `withDbAccessContext` joins a held context exactly like the real helper.
 */
const dbState = vi.hoisted(() => ({
  current: undefined as undefined | { label: string },
  events: [] as string[],
}));
const AUTH_CTX = vi.hoisted(() => ({ label: 'from-auth' }));
const { captureExceptionMock, dbAccessContextFromAuthMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  dbAccessContextFromAuthMock: vi.fn(() => AUTH_CTX),
}));

vi.mock('../db', () => ({
  hasDbAccessContext: () => dbState.current !== undefined,
  getCurrentDbAccessContext: () => dbState.current,
  runOutsideDbContext: (fn: () => unknown) => {
    const saved = dbState.current;
    dbState.current = undefined;
    return Promise.resolve()
      .then(fn)
      .finally(() => { dbState.current = saved; });
  },
  withDbAccessContext: async (ctx: { label: string }, fn: () => Promise<unknown>) => {
    if (dbState.current) return fn(); // joins, exactly like the real helper
    dbState.current = ctx;
    dbState.events.push(`open:${ctx.label}`);
    try {
      const out = await fn();
      dbState.events.push(`commit:${ctx.label}`);
      return out;
    } finally {
      dbState.current = undefined;
    }
  },
}));
vi.mock('../middleware/auth', () => ({ dbAccessContextFromAuth: dbAccessContextFromAuthMock }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('../config/env', () => ({ aiScriptAuthoringEnabled: flagMock }));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: verifyDeviceAccessMock }));
vi.mock('./scriptProposals', () => ({
  createScriptProposal: createMock, enqueueScriptReview: enqueueMock,
  waitForReviewCompletion: waitMock, getScriptProposalForPrincipal: getMock,
  selectProposalExecutions: executionsMock,
}));

import { registerScriptProposalTools } from './aiToolsScriptProposals';
import type { AiTool } from './aiTools';

const tools = new Map<string, AiTool>();
registerScriptProposalTools(tools);
const auth = {
  orgId: 'org-1', scope: 'organization', accessibleOrgIds: ['org-1'],
  canAccessOrg: (id: string) => id === 'org-1',
  user: { id: 'u1' }, principal: { kind: 'user_session' },
} as never;
/** Partner-scope token (#5682): `orgId` is null; the org comes from the device. */
const partnerAuth = {
  orgId: null, scope: 'partner', accessibleOrgIds: ['org-dev'],
  canAccessOrg: (id: string) => id === 'org-dev',
  user: { id: 'u1' }, principal: { kind: 'user_session' },
} as never;
const input = {
  language: 'powershell', content: 'Restart-Service -Name Spooler', goal: 'g', expectedEffect: 'e',
  verification: { kind: 'service_running', name: 'Spooler' },
  deviceIds: ['11111111-1111-4111-8111-111111111111'],
};

const held = (): string => (dbState.current ? `held:${dbState.current.label}` : 'none');

beforeEach(() => {
  enqueueMock.mockClear(); waitMock.mockClear(); createMock.mockClear(); getMock.mockClear();
  dbState.current = undefined;
  dbState.events.length = 0;
  captureExceptionMock.mockClear();
  dbAccessContextFromAuthMock.mockClear();
  enqueueMock.mockImplementation(async () => { dbState.events.push(`enqueue:${held()}`); });
  waitMock.mockImplementation(async () => { dbState.events.push(`wait:${held()}`); return null; });
  createMock.mockImplementation(async () => {
    dbState.events.push(`insert:${held()}`);
    return {
      proposal: { id: 'p1', status: 'proposed', orgId: 'org-dev' },
      scan: { scannerVersion: '2026-09-11.1', basicHits: [], strictHits: [], touchClasses: ['services'], touchedNames: { services: ['Spooler'], paths: [], registryKeys: [] } },
    };
  });
  flagMock.mockReturnValue(true);
  verifyDeviceAccessMock.mockReset();
  verifyDeviceAccessMock.mockImplementation(async (id: string) => ({ device: { id, orgId: 'org-dev' } }));
});

describe('propose_script', () => {
  it('is registered at tier 1 alongside get_script_proposal', () => {
    expect(tools.get('propose_script')?.tier).toBe(1);
    expect(tools.get('get_script_proposal')?.tier).toBe(1);
  });

  it('gates every supplied device id through deviceArgs', () => {
    expect(tools.get('propose_script')?.deviceArgs).toEqual(['deviceIds']);
  });

  it('returns feature_disabled and writes nothing when the flag is off', async () => {
    flagMock.mockReturnValue(false);
    const out = JSON.parse(await tools.get('propose_script')!.handler(input, auth));
    expect(out.error).toContain('feature_disabled');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('returns the static scan and does NOT enqueue a review on a BASIC hit', async () => {
    createMock.mockResolvedValueOnce({
      proposal: { id: 'p2', status: 'scan_rejected', orgId: 'org-dev' },
      scan: { scannerVersion: '2026-09-11.1', basicHits: ['PowerShell volume format'], strictHits: [], touchClasses: ['disk'], touchedNames: { services: [], paths: [], registryKeys: [] } },
    } as never);
    const out = JSON.parse(await tools.get('propose_script')!.handler(
      { ...input, content: 'Format-Volume -DriveLetter D' }, auth));
    expect(out.status).toBe('scan_rejected');
    expect(out.staticScan.basicHits).toEqual(['PowerShell volume format']);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(waitMock).not.toHaveBeenCalled();
  });

  it('enqueues a review and waits at most 45 seconds on a clean scan', async () => {
    const out = JSON.parse(await tools.get('propose_script')!.handler(input, auth));
    expect(enqueueMock).toHaveBeenCalledWith({ proposalId: 'p1', orgId: 'org-dev', attempt: 1 });
    expect(waitMock).toHaveBeenCalledWith('p1', 45_000);
    expect(out.review).toEqual({
      status: 'pending',
      nextStep: 'Review is still in progress. Poll get_script_proposal with this proposalId until '
        + 'its status is no longer pending, then call run_script.',
    });
    expect(out.proposalId).toBe('p1');
  });

  // #7128: the chat wrapper used to hold ONE transaction around the whole
  // handler, so the review job was enqueued before the proposal committed and
  // the worker (system context, ~2 ms later) found it 'missing'.
  it('declares a self-managed DB context so the SDK wrapper opens no transaction around it (#7128)', () => {
    expect(tools.get('propose_script')?.selfManagedDbContext).toBe(true);
    expect(tools.get('get_script_proposal')?.selfManagedDbContext).toBeUndefined();
  });

  it('commits the proposal in its own caller-scoped transaction BEFORE enqueueing, and waits holding no context (#7128)', async () => {
    const out = JSON.parse(await tools.get('propose_script')!.handler(input, auth));

    expect(dbState.events).toEqual([
      'open:from-auth', 'insert:held:from-auth', 'commit:from-auth',
      'enqueue:none', 'wait:none',
    ]);
    // The write runs under the CALLER's RLS context (built from auth), never
    // system scope and never the bare pool.
    expect(dbAccessContextFromAuthMock).toHaveBeenCalledWith(auth);
    expect(out.proposalId).toBe('p1');
  });

  it('under a caller-held transaction (MCP request path) commits in a FRESH transaction with the caller\'s own context, and skips the inline wait (#7128)', async () => {
    const ambient = { label: 'mcp-request' };
    dbState.current = ambient;

    const out = JSON.parse(await tools.get('propose_script')!.handler(input, auth));

    // 'open' proves it did not silently join the request transaction (whose
    // commit would come only after the response); the label proves it kept the
    // caller's exact access context rather than rebuilding or widening it.
    expect(dbState.events).toEqual([
      'open:mcp-request', 'insert:held:mcp-request', 'commit:mcp-request', 'enqueue:held:mcp-request',
    ]);
    expect(dbAccessContextFromAuthMock).not.toHaveBeenCalled();
    // Polling for 45 s here would pin the request's pooled connection
    // idle-in-transaction: answer `pending` instead.
    expect(waitMock).not.toHaveBeenCalled();
    expect(out.review).toEqual({
      status: 'pending',
      nextStep: 'Review is still in progress. Poll get_script_proposal with this proposalId until '
        + 'its status is no longer pending, then call run_script.',
    });
    expect(out.status).toBe('proposed');
    expect(dbState.current).toBe(ambient);
  });

  it('reports a review that could not be queued instead of throwing, and says the proposal was saved (#7128)', async () => {
    enqueueMock.mockRejectedValueOnce(new Error('redis down'));

    const out = JSON.parse(await tools.get('propose_script')!.handler(input, auth));

    expect(out.error).toMatch(/^review_unavailable:/);
    expect(out.proposalId).toBe('p1');
    expect(waitMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('records the agent run as the author for an ai_agent principal', async () => {
    const agentAuth = { orgId: 'org-1', user: { id: 'a1' }, principal: { kind: 'ai_agent', agentId: 'ag1', runId: 'run-1' } } as never;
    await tools.get('propose_script')!.handler(input, agentAuth);
    expect(createMock).toHaveBeenLastCalledWith(
      agentAuth, expect.anything(), { kind: 'agent_run', agentRunId: 'run-1' }, 'org-dev');
  });

  it('takes the org from the TARGET DEVICE, not the token, for a partner-scope author (#5682)', async () => {
    const out = JSON.parse(await tools.get('propose_script')!.handler(input, partnerAuth));
    expect(createMock).toHaveBeenLastCalledWith(
      partnerAuth, expect.anything(), { kind: 'chat_session', sessionId: null }, 'org-dev');
    expect(enqueueMock).toHaveBeenCalledWith({ proposalId: 'p1', orgId: 'org-dev', attempt: 1 });
    expect(out.proposalId).toBe('p1');
  });

  it('refuses to author one proposal across two organizations', async () => {
    verifyDeviceAccessMock.mockImplementation(async (id: string) => ({
      device: { id, orgId: id.startsWith('1') ? 'org-dev' : 'org-other' },
    }));
    const out = JSON.parse(await tools.get('propose_script')!.handler(
      { ...input, deviceIds: [...input.deviceIds, '22222222-2222-4222-8222-222222222222'] }, partnerAuth));
    expect(out.error).toContain('invalid_input');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses when a target device cannot be resolved', async () => {
    verifyDeviceAccessMock.mockImplementation(async () => ({ error: 'Device not found or access denied' }));
    const out = JSON.parse(await tools.get('propose_script')!.handler(input, partnerAuth));
    expect(out.error).toContain('Device not found');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('rejects malformed input with a validation error rather than throwing', async () => {
    const out = JSON.parse(await tools.get('propose_script')!.handler({ language: 'klingon' }, auth));
    expect(out.error).toBeDefined();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('get_script_proposal', () => {
  const PROPOSAL_ROW = {
    id: 'p7', status: 'verified', riskTier: 'low', goal: 'g', expectedEffect: 'e', language: 'powershell',
    runAs: 'system', timeoutSeconds: 300, targetDeviceIds: ['d1', 'd2'], scopedDeviceIds: null,
    basicHits: [], strictHits: [], touchClasses: [], scannerVersion: 'v', decidedBy: null, decidedAt: null,
    decisionNote: null, intentId: 'i1', verifiedAt: null, verificationResult: null, expiresAt: new Date(0),
  };
  const STARTED = new Date('2026-10-03T12:00:00Z');
  const RUNS = [
    { id: 'e1', deviceId: 'd1', hostname: 'KIT', status: 'completed', exitCode: 0, startedAt: STARTED, completedAt: STARTED },
    { id: 'e2', deviceId: 'd2', hostname: 'LAB', status: 'running', exitCode: null, startedAt: STARTED, completedAt: null },
  ];

  // #7918: a run that outlived its tool call still completed; the model needs
  // its execution id to read the output, and the human needs the page that
  // offers "Save to library".
  it('returns each run\'s execution id so the model can read it with get_script_execution (#7918)', async () => {
    getMock.mockResolvedValueOnce(PROPOSAL_ROW as never);
    executionsMock.mockResolvedValueOnce(RUNS);

    const out = JSON.parse(await tools.get('get_script_proposal')!.handler({ proposalId: 'p7' }, auth));

    expect(executionsMock).toHaveBeenCalledWith('p7');
    expect(out.executions).toEqual([
      { executionId: 'e1', deviceId: 'd1', hostname: 'KIT', status: 'completed', exitCode: 0,
        startedAt: STARTED.toISOString(), completedAt: STARTED.toISOString() },
      { executionId: 'e2', deviceId: 'd2', hostname: 'LAB', status: 'running', exitCode: null,
        startedAt: STARTED.toISOString(), completedAt: null },
    ]);
    expect(out.nextStep).toContain('get_script_execution');
    expect(out.approvalsPath).toBe('/approvals#proposal-p7');
  });

  it('narrows the runs to the devices the caller may see (#7918)', async () => {
    getMock.mockResolvedValueOnce({ ...PROPOSAL_ROW, scopedDeviceIds: ['d1'] } as never);
    executionsMock.mockResolvedValueOnce(RUNS);

    const out = JSON.parse(await tools.get('get_script_proposal')!.handler({ proposalId: 'p7' }, auth));

    expect(out.executions.map((e: { executionId: string }) => e.executionId)).toEqual(['e1']);
  });

  it('a proposal that never ran has no executions and no read-the-run hint (#7918)', async () => {
    getMock.mockResolvedValueOnce({ ...PROPOSAL_ROW, status: 'reviewed', intentId: null } as never);
    executionsMock.mockResolvedValueOnce([]);

    const out = JSON.parse(await tools.get('get_script_proposal')!.handler({ proposalId: 'p7' }, auth));

    expect(out.executions).toEqual([]);
    expect(out.nextStep).toBeUndefined();
  });

  it('reports not found for a proposal outside the caller org', async () => {
    const out = JSON.parse(await tools.get('get_script_proposal')!.handler({ proposalId: 'p9' }, auth));
    expect(out.error).toContain('not_found');
  });

  it('returns feature_disabled when the flag is off', async () => {
    flagMock.mockReturnValue(false);
    const out = JSON.parse(await tools.get('get_script_proposal')!.handler({ proposalId: 'p9' }, auth));
    expect(out.error).toContain('feature_disabled');
    expect(getMock).not.toHaveBeenCalled();
  });
});
