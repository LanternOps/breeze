import { beforeEach, describe, expect, it, vi } from 'vitest';

const { flagMock, createMock, enqueueMock, waitMock, getMock } = vi.hoisted(() => ({
  flagMock: vi.fn(() => true),
  createMock: vi.fn(async () => ({
    proposal: { id: 'p1', status: 'proposed' },
    scan: { scannerVersion: '2026-09-11.1', basicHits: [], strictHits: [], touchClasses: ['services'], touchedNames: { services: ['Spooler'], paths: [], registryKeys: [] } },
  })),
  enqueueMock: vi.fn(async () => undefined),
  waitMock: vi.fn(async () => null),
  getMock: vi.fn(async () => null),
}));

vi.mock('../config/env', () => ({ aiScriptAuthoringEnabled: flagMock }));
vi.mock('./scriptProposals', () => ({
  createScriptProposal: createMock, enqueueScriptReview: enqueueMock,
  waitForReviewCompletion: waitMock, getScriptProposalForPrincipal: getMock,
}));

import { registerScriptProposalTools } from './aiToolsScriptProposals';
import type { AiTool } from './aiTools';

const tools = new Map<string, AiTool>();
registerScriptProposalTools(tools);
const auth = { orgId: 'org-1', user: { id: 'u1' }, principal: { kind: 'user_session' } } as never;
const input = {
  language: 'powershell', content: 'Restart-Service -Name Spooler', goal: 'g', expectedEffect: 'e',
  verification: { kind: 'service_running', name: 'Spooler' },
  deviceIds: ['11111111-1111-4111-8111-111111111111'],
};

beforeEach(() => {
  enqueueMock.mockClear(); waitMock.mockClear(); createMock.mockClear(); getMock.mockClear();
  flagMock.mockReturnValue(true);
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
      proposal: { id: 'p2', status: 'scan_rejected' },
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
    expect(enqueueMock).toHaveBeenCalledWith({ proposalId: 'p1', orgId: 'org-1', attempt: 1 });
    expect(waitMock).toHaveBeenCalledWith('p1', 45_000);
    expect(out.review).toEqual({ status: 'pending' });
    expect(out.proposalId).toBe('p1');
  });

  it('records the agent run as the author for an ai_agent principal', async () => {
    const agentAuth = { orgId: 'org-1', user: { id: 'a1' }, principal: { kind: 'ai_agent', agentId: 'ag1', runId: 'run-1' } } as never;
    await tools.get('propose_script')!.handler(input, agentAuth);
    expect(createMock).toHaveBeenLastCalledWith(agentAuth, expect.anything(), { kind: 'agent_run', agentRunId: 'run-1' });
  });

  it('rejects malformed input with a validation error rather than throwing', async () => {
    const out = JSON.parse(await tools.get('propose_script')!.handler({ language: 'klingon' }, auth));
    expect(out.error).toBeDefined();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('get_script_proposal', () => {
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
