import { describe, expect, it } from 'vitest';
import { proposalDetailRows, findingLines, approveBlockedReason } from './scriptProposalCopy';
import { extractProposalId, resolveApprovalFlowType } from './approvalFlow';

const dto = (over: Record<string, unknown> = {}) => ({
  proposal: {
    id: 'p1', status: 'reviewed', language: 'powershell', content: 'Restart-Service spooler',
    goal: 'Restart the print spooler', expectedEffect: 'Spooler returns to Running',
    rollbackNote: null, verification: { kind: 'service_running', name: 'spooler' },
    runAs: 'system', timeoutSeconds: 300, strictHits: [], touchClasses: ['services'],
    riskTier: 'medium', expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...(over.proposal as object ?? {}),
  },
  review: { summary: 'Targets one service', riskTier: 'medium', findings: [{ severity: 'warning', text: 'Loose match' }], blastRadius: [] },
  devices: [{ id: 'd1', hostname: 'HOST-1', osType: 'windows', status: 'online' }],
  viewer: { canDecide: true, canAcknowledge: true, canPromote: false },
  ...over,
}) as never;

describe('resolveApprovalFlowType', () => {
  it('routes a run_script approval carrying a proposalId to script_proposal', () => {
    expect(resolveApprovalFlowType({ actionToolName: 'run_script', actionArguments: { proposalId: 'p1' } })).toBe('script_proposal');
  });
  it('leaves a library run_script on the standard renderer', () => {
    expect(resolveApprovalFlowType({ actionToolName: 'run_script', actionArguments: { scriptId: 's1' } })).toBe('standard');
  });
  it('still routes uac_intercept first', () => {
    expect(resolveApprovalFlowType({ actionToolName: 'uac_intercept', actionArguments: {} })).toBe('uac_intercept');
  });
});

describe('extractProposalId', () => {
  it('reads a string proposalId and rejects anything else', () => {
    expect(extractProposalId({ proposalId: 'p1' })).toBe('p1');
    expect(extractProposalId({ proposalId: 42 })).toBeNull();
    expect(extractProposalId({})).toBeNull();
  });
});

describe('proposalDetailRows', () => {
  it('names the goal, expected effect, verification, device and run context', () => {
    expect(proposalDetailRows(dto()).map((r) => r.label))
      .toEqual(['GOAL', 'EXPECTED EFFECT', 'VERIFICATION', 'DEVICE', 'RUNS AS', 'TOUCHES']);
  });
  it('adds a rollback row only when one exists', () => {
    expect(proposalDetailRows(dto({ proposal: { rollbackNote: 'Stop it again' } })).some((r) => r.label === 'ROLLBACK')).toBe(true);
  });
});

describe('findingLines', () => {
  it('prefixes each finding with its severity', () => {
    expect(findingLines(dto())).toEqual(['[warning] Loose match']);
  });
  it('is empty, never undefined, with no review', () => {
    expect(findingLines(dto({ review: null }))).toEqual([]);
  });
});

describe('approveBlockedReason', () => {
  it('is null when there are no strict hits', () => {
    expect(approveBlockedReason(dto(), [])).toBeNull();
  });
  it('asks for acknowledgement while any strict hit is unticked', () => {
    expect(approveBlockedReason(dto({ proposal: { strictHits: ['A', 'B'] } }), ['A'])).toBe('acknowledge');
  });
  it('reports the permission requirement ahead of the acknowledgement one', () => {
    expect(approveBlockedReason(
      dto({ proposal: { strictHits: ['A'] }, viewer: { canDecide: true, canAcknowledge: false, canPromote: false } }), ['A'],
    )).toBe('permission');
  });
  it('is null once every strict hit is ticked by a permitted approver', () => {
    expect(approveBlockedReason(dto({ proposal: { strictHits: ['A'] } }), ['A'])).toBeNull();
  });
});
