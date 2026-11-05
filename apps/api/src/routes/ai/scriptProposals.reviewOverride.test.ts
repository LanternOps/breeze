import { describe, expect, it, vi, beforeEach } from 'vitest';

// #10954: the human override for a `review_failed` proposal. The route, its
// middleware and reviewOverride.ts are REAL; only what they call out to varies.
const m = vi.hoisted(() => ({
  loadScriptProposalDetail: vi.fn(),
  loadProposalRow: vi.fn(),
  loadLatestReview: vi.fn(),
  loadProposalRequesterUserId: vi.fn(),
  promoteProposalToLibrary: vi.fn(),
  transitionProposal: vi.fn(),
  dispatchScriptToDevice: vi.fn(),
  deliverDeferredDispatch: vi.fn(),
  writeAuditEventAsync: vi.fn(),
  writeAuditEventStrict: vi.fn(),
  resolveIntentApprovers: vi.fn(),
  assertApprovalAssurance: vi.fn(),
  resolveDevicePolicyForGate: vi.fn(),
  captureException: vi.fn(),
  deviceRows: [] as unknown[],
  principal: { kind: 'user_session' } as Record<string, unknown>,
  grants: [] as Array<{ resource: string; action: string }>,
  mfa: true,
}));

vi.mock('../../services/scriptProposals/detail', () => ({ loadScriptProposalDetail: m.loadScriptProposalDetail }));
vi.mock('../../services/scriptProposals/queries', () => ({
  loadProposalRow: m.loadProposalRow,
  loadLatestReview: m.loadLatestReview,
  loadProposalRequesterUserId: m.loadProposalRequesterUserId,
}));
vi.mock('../../services/scriptProposals/promote', () => ({ promoteProposalToLibrary: m.promoteProposalToLibrary }));
vi.mock('../../services/scriptProposals/proposals', () => ({ transitionProposal: m.transitionProposal }));
vi.mock('../../services/scriptProposals', () => ({ transitionProposal: m.transitionProposal, denyIntentForProposal: vi.fn() }));
vi.mock('../../services/scriptProposals/authorNotify', () => ({ postProposalOutcomeToAuthor: vi.fn() }));
// The reviewer's pure floor is what the override reads; the rest of the module
// (provider clients, budget) is not reached.
vi.mock('../../services/scriptProposals/reviewer', async (importOriginal) => importOriginal());
vi.mock('../../services/scriptDispatch', () => ({ dispatchScriptToDevice: m.dispatchScriptToDevice }));
vi.mock('../../services/scriptDeferredDelivery', () => ({ deliverDeferredDispatch: m.deliverDeferredDispatch }));
vi.mock('../../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/auditEvents')>()),
  writeAuditEventAsync: m.writeAuditEventAsync,
  writeAuditEventStrict: m.writeAuditEventStrict,
}));
vi.mock('../../services/actionIntents/intentApprovers', () => ({ resolveIntentApprovers: m.resolveIntentApprovers }));
vi.mock('../../services/authenticatorAssurance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/authenticatorAssurance')>()),
  assertApprovalAssurance: m.assertApprovalAssurance,
}));
vi.mock('../../services/aiDevicePathPolicy', () => ({ resolveDevicePolicyForGate: m.resolveDevicePolicyForGate }));
vi.mock('../../services/sentry', () => ({ captureException: m.captureException }));
vi.mock('../../config/env', async (o) => ({ ...(await o<Record<string, unknown>>()), aiScriptAuthoringEnabled: () => true }));
vi.mock('../../db', async (importOriginal) => {
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(m.deviceRows),
  };
  return {
    ...(await importOriginal<typeof import('../../db')>()),
    db: { select: () => chain, transaction: (fn: (tx: unknown) => unknown) => fn({ __tx: true }) },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('../../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
      scope: 'organization', orgId: '11111111-1111-4111-8111-111111111111', permissions: m.grants,
    })),
  };
});
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    withAuthDbAccessContext: (_auth: unknown, fn: () => unknown) => fn(),
    authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', {
        principal: m.principal,
        user: { id: USER, email: 'tech@example.com' }, scope: 'organization',
        orgId: ORG, partnerId: null,
        accessibleOrgIds: [ORG], token: { mfa: m.mfa },
        canAccessOrg: () => true,
      });
      await next();
    },
  };
});

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER_USER = '33333333-3333-4333-8333-333333333333';
const ID = '44444444-4444-4444-8444-444444444444';
const D1 = '55555555-5555-4555-8555-555555555551';
const D2 = '55555555-5555-4555-8555-555555555552';

import { aiScriptProposalRoutes } from './scriptProposals';
import { StepUpRequiredError } from '../../services/authenticatorAssurance';
import { PERMISSIONS } from '../../services/permissions';

const EXECUTE = { resource: PERMISSIONS.SCRIPTS_EXECUTE.resource, action: PERMISSIONS.SCRIPTS_EXECUTE.action };
const WRITE = { resource: PERMISSIONS.SCRIPTS_WRITE.resource, action: PERMISSIONS.SCRIPTS_WRITE.action };
const FAILURE = 'Reviewer returned no parseable JSON verdict';

const proposalRow = (over: Record<string, unknown> = {}) => ({
  id: ID, orgId: ORG, status: 'review_failed', content: 'Restart-Service spooler', contentDigest: 'a'.repeat(64),
  language: 'powershell', runAs: 'system', timeoutSeconds: 300, goal: 'Restart the spooler',
  targetDeviceIds: [D1], basicHits: [], strictHits: [], touchClasses: ['services'],
  acknowledgedPatterns: [], decidedBy: null, decidedAt: null, decisionNote: FAILURE, intentId: null, sessionId: null,
  riskTier: null, expiresAt: new Date(Date.now() + 3_600_000),
  ...over,
});

const detail = (viewer: Record<string, unknown> = {}) => ({
  ok: true,
  dto: { proposal: { id: ID }, viewer: { canDecide: true, canPromote: false, canOverrideRun: true, canOverrideSave: true, ...viewer } },
});

const postRun = (body: unknown = { confirmNoPassingReview: true }) =>
  aiScriptProposalRoutes.request(`/${ID}/override-run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
const postSave = (body: unknown = { confirmNoPassingReview: true, name: 'Restart spooler', ownerScope: 'organization' }) =>
  aiScriptProposalRoutes.request(`/${ID}/override-promote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

const overrideAudit = expect.objectContaining({
  action: 'script.proposal.review_override',
  orgId: ORG,
  actorType: 'user',
  actorId: USER,
  resourceType: 'script_proposal',
  resourceId: ID,
  details: expect.objectContaining({ override: 'approved_without_passing_ai_review', reviewFailure: FAILURE }),
});

beforeEach(() => {
  vi.clearAllMocks();
  m.mfa = true;
  m.principal = { kind: 'user_session' };
  m.grants = [EXECUTE, WRITE];
  m.deviceRows = [{ id: D1, orgId: ORG, hostname: 'HOST-1', status: 'online' }];
  m.loadScriptProposalDetail.mockResolvedValue(detail());
  // First read is the handler's; the reload after the claim sees `approved`.
  m.loadProposalRow.mockReset();
  m.loadProposalRow
    .mockResolvedValueOnce(proposalRow())
    .mockResolvedValue(proposalRow({ status: 'approved', decidedBy: USER }));
  m.loadLatestReview.mockResolvedValue({ id: 'r1', status: 'failed', summary: FAILURE });
  m.loadProposalRequesterUserId.mockResolvedValue(null);
  m.transitionProposal.mockResolvedValue(true);
  m.promoteProposalToLibrary.mockResolvedValue({ ok: true, scriptId: 's1', versionId: 'v1' });
  m.dispatchScriptToDevice.mockResolvedValue({ ok: true, executionId: 'e1', commandId: 'c1' });
  m.deliverDeferredDispatch.mockImplementation(async (dispatch: unknown) => dispatch);
  m.writeAuditEventStrict.mockResolvedValue(undefined);
  m.writeAuditEventAsync.mockResolvedValue(undefined);
  m.assertApprovalAssurance.mockResolvedValue({});
  m.resolveIntentApprovers.mockResolvedValue([OTHER_USER, USER]);
  m.resolveDevicePolicyForGate.mockResolvedValue({ deviceFileReadLevel: 'any_with_approval', source: { deviceFileReadLevel: 'default' } });
});

function expectNothingHappened() {
  expect(m.transitionProposal).not.toHaveBeenCalled();
  expect(m.dispatchScriptToDevice).not.toHaveBeenCalled();
  expect(m.promoteProposalToLibrary).not.toHaveBeenCalled();
  expect(m.writeAuditEventStrict).not.toHaveBeenCalled();
}

describe('POST /:id/override-run', () => {
  it('a human with run permission runs a review_failed proposal: 200, signed, audited with the marker', async () => {
    const res = await postRun();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'executed', results: [{ deviceId: D1, ok: true, executionId: 'e1' }] });
    expect(m.transitionProposal).toHaveBeenCalledWith(
      expect.anything(), ID, ['review_failed'], 'approved',
      expect.objectContaining({ decidedBy: USER, decisionNote: expect.stringContaining(FAILURE) }),
    );
    expect(m.writeAuditEventStrict).toHaveBeenCalledWith(expect.anything(), overrideAudit);
    expect(m.dispatchScriptToDevice).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ kind: 'proposal' }),
      triggeredBy: USER,
      createdBy: USER,
      offlinePolicy: { kind: 'reject' },
      provenance: expect.objectContaining({
        approvedBy: USER,
        approvalMethod: 'direct_ui',
        reviewRiskTier: null,
        reviewSummary: expect.stringContaining('without a passing AI review'),
      }),
    }));
    // A human's run is not an AI dispatch: no AI origin to attribute it to.
    expect(m.dispatchScriptToDevice.mock.calls[0]![0]).not.toHaveProperty('aiOrigin');
    expect(m.transitionProposal).toHaveBeenCalledWith(expect.anything(), ID, ['approved'], 'executed', {});
  });

  it('never invents a risk tier or marks the proposal reviewed', async () => {
    await postRun();
    for (const call of m.transitionProposal.mock.calls) {
      expect(call[3]).not.toBe('reviewed');
      expect(call[4]).not.toHaveProperty('riskTier');
    }
  });

  it('writes the audit row before anything is dispatched', async () => {
    await postRun();
    expect(m.writeAuditEventStrict.mock.invocationCallOrder[0]!).toBeLessThan(m.dispatchScriptToDevice.mock.invocationCallOrder[0]!);
  });

  it('an audit write that fails runs nothing and puts the proposal back', async () => {
    m.writeAuditEventStrict.mockRejectedValueOnce(new Error('audit down'));

    const res = await postRun();

    expect(res.status).toBe(500);
    expect(m.dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(m.transitionProposal).toHaveBeenCalledWith(
      expect.anything(), ID, ['approved'], 'review_failed',
      expect.objectContaining({ decidedBy: null, decidedAt: null, decisionNote: FAILURE, acknowledgedPatterns: [] }),
    );
  });

  it('without scripts:execute: 403 and nothing happens', async () => {
    m.grants = [WRITE];
    const res = await postRun();
    expect(res.status).toBe(403);
    expectNothingHappened();
  });

  it('without the org-level override grant (no approvals:decide, or a target out of scope): 403', async () => {
    m.loadScriptProposalDetail.mockResolvedValue(detail({ canOverrideRun: false }));
    const res = await postRun();
    expect(res.status).toBe(403);
    expectNothingHappened();
  });

  it('without MFA: 403 and nothing happens', async () => {
    m.mfa = false;
    const res = await postRun();
    expect(res.status).toBe(403);
    expectNothingHappened();
  });

  it.each([
    [{ kind: 'api_key', apiKeyId: 'k1' }],
    [{ kind: 'api_key', partnerServicePrincipalId: 'sp1' }],
    [{ kind: 'oauth_grant', grantId: 'g1' }],
    [{ kind: 'agent', deviceId: D1 }],
    [{ kind: 'helper', deviceId: D1 }],
    [{ kind: 'ai_agent', agentId: 'a1', runId: 'r1' }],
    [{ kind: 'flow', flowId: 'f1', runId: 'r1' }],
    [{ kind: 'system', reason: 'test' }],
    [{ kind: 'unknown' }],
    [{ kind: 'client_user' }],
  ])('refuses the non-human principal %j before any lookup, even holding every permission', async (principal) => {
    m.principal = principal;
    const res = await postRun();
    expect(res.status).toBe(403);
    expect(m.loadScriptProposalDetail).not.toHaveBeenCalled();
    expectNothingHappened();
  });

  it.each([
    'proposed', 'scan_rejected', 'reviewed', 'approved', 'rejected', 'changes_requested',
    'expired', 'superseded', 'executed', 'verified', 'verification_failed', 'promoted',
  ])('leaves a proposal in `%s` alone: 409', async (status) => {
    m.loadProposalRow.mockReset();
    m.loadProposalRow.mockResolvedValue(proposalRow({ status }));
    const res = await postRun();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'proposal_not_review_failed' });
    expectNothingHappened();
  });

  it('requires the explicit sign-off in the body', async () => {
    const res = await postRun({});
    expect(res.status).toBe(400);
    expectNothingHappened();
  });

  it('refuses an expired proposal', async () => {
    m.loadProposalRow.mockReset();
    m.loadProposalRow.mockResolvedValue(proposalRow({ expiresAt: new Date(Date.now() - 1000) }));
    const res = await postRun();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'proposal_expired' });
    expectNothingHappened();
  });

  it('a lost CAS (someone else already moved it) runs nothing: 409', async () => {
    m.transitionProposal.mockResolvedValueOnce(false);
    const res = await postRun();
    expect(res.status).toBe(409);
    expect(m.dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(m.writeAuditEventStrict).not.toHaveBeenCalled();
  });

  describe('STRICT acknowledgements', () => {
    const STRICT = 'PowerShell HKLM write';
    beforeEach(() => {
      m.loadProposalRow.mockReset();
      m.loadProposalRow
        .mockResolvedValueOnce(proposalRow({ strictHits: [STRICT] }))
        .mockResolvedValue(proposalRow({ status: 'approved', strictHits: [STRICT], acknowledgedPatterns: [STRICT] }));
    });

    it('an unacknowledged hit: 422, nothing runs', async () => {
      const res = await postRun();
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: 'strict_acknowledgement_incomplete', missing: [STRICT] });
      expectNothingHappened();
    });

    it('without scripts:write the acknowledgement is not permitted: 422', async () => {
      m.grants = [EXECUTE];
      const res = await postRun({ confirmNoPassingReview: true, acknowledgedPatterns: [STRICT] });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: 'strict_acknowledgement_not_permitted', requirement: 'scripts:write' });
      expectNothingHappened();
    });

    it('fully acknowledged: stored on the proposal and carried to the dispatch', async () => {
      const res = await postRun({ confirmNoPassingReview: true, acknowledgedPatterns: [STRICT] });
      expect(res.status).toBe(200);
      expect(m.transitionProposal).toHaveBeenCalledWith(
        expect.anything(), ID, ['review_failed'], 'approved', expect.objectContaining({ acknowledgedPatterns: [STRICT] }),
      );
      expect(m.dispatchScriptToDevice.mock.calls[0]![0].source.proposal.acknowledgedPatterns).toEqual([STRICT]);
    });
  });

  describe('four-eyes on the deterministic floor', () => {
    const highFloor = (over: Record<string, unknown> = {}) => {
      m.loadProposalRow.mockReset();
      m.loadProposalRow
        .mockResolvedValueOnce(proposalRow({ touchClasses: ['credentials'], ...over }))
        .mockResolvedValue(proposalRow({ status: 'approved', touchClasses: ['credentials'], ...over }));
    };

    it('the requester of a high-floor proposal cannot sign it while another approver exists', async () => {
      highFloor();
      m.loadProposalRequesterUserId.mockResolvedValue(USER);
      const res = await postRun();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'not_sole_approver' });
      expectNothingHappened();
    });

    it('the requester may sign as the genuine sole approver', async () => {
      highFloor();
      m.loadProposalRequesterUserId.mockResolvedValue(USER);
      m.resolveIntentApprovers.mockResolvedValue([USER]);
      expect((await postRun()).status).toBe(200);
    });

    it('an empty approver resolution refuses rather than admits', async () => {
      highFloor();
      m.loadProposalRequesterUserId.mockResolvedValue(USER);
      m.resolveIntentApprovers.mockResolvedValue([]);
      expect((await postRun()).status).toBe(403);
    });

    it('a second person may sign a high-floor proposal', async () => {
      highFloor();
      m.loadProposalRequesterUserId.mockResolvedValue(OTHER_USER);
      expect((await postRun()).status).toBe(200);
      expect(m.resolveIntentApprovers).not.toHaveBeenCalled();
    });

    it('the requester may sign below the high floor', async () => {
      m.loadProposalRequesterUserId.mockResolvedValue(USER);
      expect((await postRun()).status).toBe(200);
      expect(m.resolveIntentApprovers).not.toHaveBeenCalled();
    });
  });

  it('an enforcing partner floor refuses instead of being skipped', async () => {
    m.assertApprovalAssurance.mockRejectedValueOnce(new StepUpRequiredError(2, 1));
    const res = await postRun();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'step_up_required', requiredLevel: 2 });
    expectNothingHappened();
  });

  it('checks that floor at medium at the least: an unknown tier is never low', async () => {
    await postRun();
    expect(m.assertApprovalAssurance).toHaveBeenCalledWith(expect.objectContaining({ riskTier: 'medium', proof: null, decision: 'approved' }));
  });

  it('the AI data policy on user-profile paths still refuses', async () => {
    m.loadProposalRow.mockReset();
    m.loadProposalRow.mockResolvedValue(proposalRow({ content: 'Get-Content C:\\Users\\alice\\secrets.txt' }));
    m.resolveDevicePolicyForGate.mockResolvedValue({ deviceFileReadLevel: 'no_user_profiles', source: { deviceFileReadLevel: 'org' } });
    const res = await postRun();
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'policy_denied' });
    expectNothingHappened();
  });

  it('some devices refusing still counts as a run, and says which', async () => {
    m.loadProposalRow.mockReset();
    m.loadProposalRow
      .mockResolvedValueOnce(proposalRow({ targetDeviceIds: [D1, D2] }))
      .mockResolvedValue(proposalRow({ status: 'approved', targetDeviceIds: [D1, D2] }));
    m.deviceRows = [{ id: D1, orgId: ORG }, { id: D2, orgId: ORG }];
    m.dispatchScriptToDevice
      .mockResolvedValueOnce({ ok: false, code: 'device_offline', error: 'Device is offline' })
      .mockResolvedValueOnce({ ok: true, executionId: 'e2', commandId: 'c2' });

    const res = await postRun();

    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([
      { deviceId: D1, ok: false, error: 'Device is offline' },
      { deviceId: D2, ok: true, executionId: 'e2', commandId: 'c2' },
    ]);
    expect(m.transitionProposal).toHaveBeenCalledWith(expect.anything(), ID, ['approved'], 'executed', {});
  });

  it('never dispatches to a target that is not in the proposal\'s org', async () => {
    m.deviceRows = [];
    const res = await postRun();
    expect(res.status).toBe(409);
    expect(m.dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it('no device accepting it puts the proposal back, so the human can retry, and audits the failure', async () => {
    m.dispatchScriptToDevice.mockResolvedValue({ ok: false, code: 'device_offline', error: 'Device is offline' });

    const res = await postRun();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no_device_dispatched', results: [{ deviceId: D1, ok: false }] });
    expect(m.transitionProposal).toHaveBeenCalledWith(
      expect.anything(), ID, ['approved'], 'review_failed', expect.objectContaining({ decidedBy: null, decisionNote: FAILURE }),
    );
    expect(m.transitionProposal).not.toHaveBeenCalledWith(expect.anything(), ID, ['approved'], 'executed', expect.anything());
    expect(m.writeAuditEventAsync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'script.proposal.review_override', result: 'failure',
      details: expect.objectContaining({ override: 'approved_without_passing_ai_review' }),
    }));
  });
});

// Review round (PR #10985): no exit after the claim may strand the proposal in
// `approved` with nothing run, and nothing that already ran may be reported as
// not run (the UI would then invite a second run).
describe('POST /:id/override-run — after the claim', () => {
  type Call = [unknown, string, string[], string, Record<string, unknown>];
  const transitions = () => m.transitionProposal.mock.calls as unknown as Call[];
  const restoredCalls = () => transitions().filter((c) => c[2][0] === 'approved' && c[3] === 'review_failed');
  const onTransition = (to: string, impl: () => Promise<boolean>) => {
    m.transitionProposal.mockImplementation(async (...args: unknown[]) => ((args as Call)[3] === to ? impl() : true));
  };

  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined));

  it('a delivered run whose `executed` mark throws is still a run: 200, ok, never restored', async () => {
    onTransition('executed', async () => { throw new Error('pool exhausted'); });

    const res = await postRun();

    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([{ deviceId: D1, ok: true, executionId: 'e1', commandId: 'c1' }]);
    expect(restoredCalls()).toHaveLength(0);
    expect(m.captureException).toHaveBeenCalled();
  });

  it('a failed `executed` mark is retried on the next delivered device', async () => {
    m.loadProposalRow.mockReset();
    m.loadProposalRow
      .mockResolvedValueOnce(proposalRow({ targetDeviceIds: [D1, D2] }))
      .mockResolvedValue(proposalRow({ status: 'approved', targetDeviceIds: [D1, D2] }));
    m.deviceRows = [{ id: D1, orgId: ORG }, { id: D2, orgId: ORG }];
    let executedCalls = 0;
    onTransition('executed', async () => {
      executedCalls++;
      if (executedCalls === 1) throw new Error('blip');
      return true;
    });

    expect((await postRun()).status).toBe(200);
    expect(executedCalls).toBe(2);
  });

  it('an `executed` mark that loses its CAS (the proposal moved under the run) is reported, not hidden', async () => {
    onTransition('executed', async () => false);

    expect((await postRun()).status).toBe(200);
    expect(m.captureException).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({
      area: 'script_proposal_review_override_state',
    }));
  });

  it('a throw between the claim and the first delivery puts the proposal back and fails loudly', async () => {
    m.loadProposalRow.mockReset();
    m.loadProposalRow.mockResolvedValueOnce(proposalRow()).mockRejectedValueOnce(new Error('db blip'));

    const res = await postRun();

    expect(res.status).toBe(500);
    expect(m.dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(restoredCalls()).toHaveLength(1);
  });

  it('a restore that throws after the audit write failed still surfaces the AUDIT error, and is reported', async () => {
    m.writeAuditEventStrict.mockRejectedValueOnce(new Error('audit down'));
    onTransition('review_failed', async () => { throw new Error('restore down'); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await postRun();

    expect(res.status).toBe(500);
    expect(m.dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(m.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'restore down' }), undefined, expect.objectContaining({
      area: 'script_proposal_review_override_restore',
    }));
    // The route's own error handler logs what reached it: the audit failure.
    expect(errors.mock.calls.flat().some((a) => a instanceof Error && a.message === 'audit down')).toBe(true);
  });

  it('no device took it and the restore failed: the failure is still audited, and says the proposal is stuck', async () => {
    m.dispatchScriptToDevice.mockResolvedValue({ ok: false, code: 'device_offline', error: 'Device is offline' });
    onTransition('review_failed', async () => false);

    const res = await postRun();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no_device_dispatched', restored: false });
    expect(m.writeAuditEventAsync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      result: 'failure', details: expect.objectContaining({ restored: false }),
    }));
  });
});

describe('POST /:id/override-promote', () => {
  it('a human with run and write permission saves a review_failed proposal: 200, human-signed, audited with the marker', async () => {
    const res = await postSave();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scriptId: 's1', versionId: 'v1' });
    expect(m.promoteProposalToLibrary).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ name: 'Restart spooler', ownerScope: 'organization' }),
      override: expect.objectContaining({ acknowledgedPatterns: [], decisionNote: expect.stringContaining(FAILURE) }),
    }));
    expect(m.writeAuditEventStrict).toHaveBeenCalledWith(expect.anything(), overrideAudit);
    expect(m.writeAuditEventStrict.mock.calls[0]![1].details).toMatchObject({ decision: 'save_to_library', scriptId: 's1', versionId: 'v1' });
    expect(m.dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it.each([
    ['scripts:execute', [WRITE]],
    ['scripts:write', [EXECUTE]],
  ])('without %s: 403 and nothing happens', async (_name, grants) => {
    m.grants = grants;
    const res = await postSave();
    expect(res.status).toBe(403);
    expectNothingHappened();
  });

  it('without the org-level override grant: 403', async () => {
    m.loadScriptProposalDetail.mockResolvedValue(detail({ canOverrideSave: false }));
    const res = await postSave();
    expect(res.status).toBe(403);
    expectNothingHappened();
  });

  it('without MFA: 403', async () => {
    m.mfa = false;
    expect((await postSave()).status).toBe(403);
    expectNothingHappened();
  });

  it.each([
    [{ kind: 'api_key', apiKeyId: 'k1' }],
    [{ kind: 'oauth_grant', grantId: 'g1' }],
    [{ kind: 'ai_agent', agentId: 'a1', runId: 'r1' }],
    [{ kind: 'flow', flowId: 'f1', runId: 'r1' }],
    [{ kind: 'agent', deviceId: D1 }],
  ])('refuses the non-human principal %j before any lookup', async (principal) => {
    m.principal = principal;
    expect((await postSave()).status).toBe(403);
    expect(m.loadScriptProposalDetail).not.toHaveBeenCalled();
    expectNothingHappened();
  });

  it.each(['reviewed', 'verified', 'scan_rejected', 'promoted'])('leaves a proposal in `%s` alone: 409', async (status) => {
    m.loadProposalRow.mockReset();
    m.loadProposalRow.mockResolvedValue(proposalRow({ status }));
    const res = await postSave();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'proposal_not_review_failed' });
    expectNothingHappened();
  });

  it('requires the explicit sign-off', async () => {
    expect((await postSave({ name: 'x', ownerScope: 'organization' })).status).toBe(400);
    expectNothingHappened();
  });

  it('an unacknowledged STRICT hit: 422', async () => {
    m.loadProposalRow.mockReset();
    m.loadProposalRow.mockResolvedValue(proposalRow({ strictHits: ['PowerShell HKLM write'] }));
    const res = await postSave();
    expect(res.status).toBe(422);
    expectNothingHappened();
  });

  it('an audit write that fails after the commit falls back to the retry queue and is not reported as a failed save', async () => {
    m.writeAuditEventStrict.mockRejectedValueOnce(new Error('audit down'));
    const res = await postSave();
    expect(res.status).toBe(200);
    expect(m.writeAuditEventAsync).toHaveBeenCalledWith(expect.anything(), overrideAudit);
  });

  it('a refused promotion writes no override audit', async () => {
    m.promoteProposalToLibrary.mockResolvedValueOnce({ ok: false, status: 409, error: 'proposal_not_review_failed' });
    const res = await postSave();
    expect(res.status).toBe(409);
    expect(m.writeAuditEventStrict).not.toHaveBeenCalled();
  });
});

describe('the normal /promote path', () => {
  it('still refuses a review_failed proposal: canPromote stays false', async () => {
    const res = await aiScriptProposalRoutes.request(`/${ID}/promote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', ownerScope: 'organization' }),
    });
    expect(res.status).toBe(403);
    expectNothingHappened();
  });
});
