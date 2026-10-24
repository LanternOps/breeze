/**
 * Wisp W05b Task 6 — `finalizeAssessment` applies an assessment run's
 * captured outcome-tool calls after the run (W05 plan Task 6 + Task 15 +
 * Review Focus 5). Every collaborator is mocked at its module boundary: the
 * concern store, the in-app delivery seam, the intent service, the grant
 * ceiling, the rollup and the readiness renderer. What is under test is the
 * finalizer's own ordering, refusals, caps and per-step isolation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, type AssessmentOutcome, type Concern } from '@breeze/shared';

const state = vi.hoisted(() => ({ runStatus: 'running' as string }));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const builder: Record<string, unknown> = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => Promise.resolve([{ status: state.runStatus }])),
      };
      return builder;
    }),
  },
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' })),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

const concerns = vi.hoisted(() => ({
  upsertConcern: vi.fn(),
  updateConcern: vi.fn(),
  resolveConcern: vi.fn(),
  recordNudge: vi.fn(),
  getConcernForCeiling: vi.fn(),
}));
vi.mock('../wisp/concerns', () => concerns);

const deliverInApp = vi.hoisted(() => vi.fn());
vi.mock('../wisp/deliver', () => ({ deliverInApp }));

const createActionIntent = vi.hoisted(() => vi.fn());
vi.mock('../actionIntents/intentService', () => ({ createActionIntent }));

const rollupPartnerPicture = vi.hoisted(() => vi.fn());
vi.mock('../wisp/assessment', () => ({ rollupPartnerPicture }));

const renderReadinessSummary = vi.hoisted(() => vi.fn());
vi.mock('../wisp/readiness', () => ({ renderReadinessSummary }));

const TIERS = vi.hoisted((): Record<string, number> => ({ query_devices: 1, manage_dns_policy: 2, run_script: 3 }));
vi.mock('../aiGuardrails', () => ({
  checkGuardrails: vi.fn((toolName: string) => ({ tier: TIERS[toolName] ?? 4, allowed: toolName in TIERS })),
}));

const resolveGrantCeiling = vi.hoisted(() => vi.fn());
vi.mock('../wisp/grantAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../wisp/grantAuthority')>()),
  resolveGrantCeiling,
}));

vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { finalizeAssessment } from './runFinalizers';
import { GrantInactiveError, type GrantCeiling } from '../wisp/grantAuthority';
import type { AssessmentRunContext, LoopResult, RunContext } from './runLoopTypes';

const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000a3';
const RUN_ID = '00000000-0000-4000-8000-0000000000a4';
const GRANT_ID = '00000000-0000-4000-8000-0000000000a5';
const REVISION_ID = '00000000-0000-4000-8000-0000000000a6';
const GRANTOR = '00000000-0000-4000-8000-0000000000a7';
const THREAD_ID = '00000000-0000-4000-8000-0000000000a8';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';
const TICKET_ID = '00000000-0000-4000-8000-0000000000d1';
const OTHER_PARTNER = '00000000-0000-4000-8000-0000000000b3';

function ceiling(o: Partial<GrantCeiling> = {}): GrantCeiling {
  return {
    grantId: GRANT_ID, revisionId: REVISION_ID, partnerId: PARTNER_ID,
    // Deliberately NOT the context's grantor: the nudge recipient is
    // `ctx.assessment.grantorUserId`, read once at context load.
    grantorUserId: '00000000-0000-4000-8000-0000000000ff',
    scopeOrgId: null, partnerWide: true, orgIds: new Set([ORG_ID, OTHER_ORG]), siteIds: null,
    permissionKeys: new Set(['*:*']), toolAllowlist: null, deniedTools: new Set(['manage_ai_agents']),
    orgTerms: new Map(), status: 'active', ...o,
  };
}

function concern(overrides: Partial<Concern> = {}): Concern {
  return {
    id: C1, partnerId: PARTNER_ID, orgId: ORG_ID,
    subject: { kind: 'ticket', id: TICKET_ID },
    summary: 'Printer ticket waiting on the customer for three days',
    severity: 'medium', status: 'open', evidence: { ticketNumber: 'T-1' }, outcome: null,
    signature: null, childConcernIds: [], approvalIntentId: null,
    createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z', resolvedAt: null,
    ...overrides,
  };
}

function assessmentCtx(overrides: Partial<AssessmentRunContext> = {}): AssessmentRunContext {
  return {
    grantId: GRANT_ID, grantRevisionId: REVISION_ID, grantorUserId: GRANTOR, threadId: THREAD_ID,
    threadSummary: '', openConcerns: [], changedSince: null,
    digest: { alerts: [], tickets: [], incidents: [], runs: [], intents: [] },
    watch: null, reason: { kind: 'tick' }, readiness: null, nudgeFeedback: [],
    ...overrides,
  };
}

function makeCtx(a: AssessmentRunContext | null = assessmentCtx(), profile = 'assessment'): RunContext {
  return {
    run: { id: RUN_ID, orgId: ORG_ID, agentId: 'agent-1', profile, grantId: GRANT_ID, grantRevisionId: REVISION_ID },
    orgPartnerId: PARTNER_ID,
    assessment: a,
  } as unknown as RunContext;
}

function calls(o: Partial<AssessmentOutcome> = {}): AssessmentOutcome {
  return { concernsRaised: [], concernsUpdated: [], nudges: [], proposedActions: [], specialistRequests: [], ...o };
}

function makeResult(assessment?: AssessmentOutcome): LoopResult {
  return {
    summary: '', costCents: 0, turnCount: 1, intentIds: [],
    outcome: { proposedActions: [], executedActions: [], deniedActions: [], toolExecutionCount: 0, ...(assessment ? { assessment } : {}) },
    agentAuth: { principal: { kind: 'ai_agent' } } as never,
  };
}

const RAISE = { subject: { kind: 'ticket' as const, id: TICKET_ID }, summary: 'Ticket waiting', severity: 'medium' as const };

beforeEach(() => {
  vi.clearAllMocks();
  state.runStatus = 'running';
  resolveGrantCeiling.mockResolvedValue(ceiling());
  concerns.upsertConcern.mockResolvedValue({ id: C1, created: true });
  concerns.updateConcern.mockResolvedValue(undefined);
  concerns.resolveConcern.mockResolvedValue(undefined);
  concerns.recordNudge.mockResolvedValue({ nudgeCount: 1, nextEligibleNudgeAt: new Date() });
  concerns.getConcernForCeiling.mockResolvedValue(concern());
  deliverInApp.mockResolvedValue({ created: true });
  createActionIntent.mockResolvedValue({ id: 'intent-1', status: 'pending_approval' });
  rollupPartnerPicture.mockResolvedValue('picture');
  renderReadinessSummary.mockReturnValue("I can watch tickets here. I can't watch backups (no backup integration configured).");
});

describe('finalizeAssessment (Wisp W05b)', () => {
  it('does nothing for a non-assessment run', async () => {
    expect(await finalizeAssessment(makeCtx(assessmentCtx(), 'triage'), makeResult(calls({ concernsRaised: [RAISE] })))).toBeNull();
    expect(concerns.upsertConcern).not.toHaveBeenCalled();
    expect(rollupPartnerPicture).not.toHaveBeenCalled();
  });

  it('writes nothing when the run left `running` before it could be finalized', async () => {
    state.runStatus = 'failed';
    expect(await finalizeAssessment(makeCtx(), makeResult(calls({ concernsRaised: [RAISE] })))).toBeNull();
    expect(concerns.upsertConcern).not.toHaveBeenCalled();
  });

  it('record_concern → upsertConcern pinned to the run org/partner with raisedByGrantId and lastAssessedRunId', async () => {
    const result = makeResult(calls({ concernsRaised: [{ ...RAISE, evidence: { a: 1, approvalIntentId: 'forged' } }] }));
    expect(await finalizeAssessment(makeCtx(), result)).toBeNull();
    expect(concerns.upsertConcern).toHaveBeenCalledWith({
      partnerId: PARTNER_ID, orgId: ORG_ID, subject: RAISE.subject, summary: RAISE.summary, severity: 'medium',
      // A model can never point a concern at an approval card it did not mint.
      evidence: { a: 1 },
      raisedByGrantId: GRANT_ID, lastAssessedRunId: RUN_ID,
    });
    expect(rollupPartnerPicture).toHaveBeenCalledWith(GRANT_ID);
  });

  it('11 raises → 10 upserts + raise_cap', async () => {
    const result = makeResult(calls({ concernsRaised: Array.from({ length: 11 }, () => RAISE) }));
    await finalizeAssessment(makeCtx(), result);
    expect(concerns.upsertConcern).toHaveBeenCalledTimes(10);
    expect(result.outcome.assessmentSkipped).toEqual(['raise_cap']);
  });

  it('refuses an org-subject raise naming another org', async () => {
    const result = makeResult(calls({ concernsRaised: [{ ...RAISE, subject: { kind: 'org', id: OTHER_ORG } }] }));
    await finalizeAssessment(makeCtx(), result);
    expect(concerns.upsertConcern).not.toHaveBeenCalled();
    expect(result.outcome.assessmentSkipped).toEqual(['raise_subject_not_in_org']);
  });

  it('update_concern on a concern in another org is refused with concern_not_in_org', async () => {
    concerns.getConcernForCeiling.mockResolvedValue(concern({ orgId: OTHER_ORG }));
    const result = makeResult(calls({ concernsUpdated: [{ concernId: C1, severity: 'high' }] }));
    await finalizeAssessment(makeCtx(), result);
    expect(concerns.updateConcern).not.toHaveBeenCalled();
    expect(concerns.resolveConcern).not.toHaveBeenCalled();
    expect(result.outcome.assessmentSkipped).toEqual(['concern_not_in_org']);
  });

  it('update_concern on an unknown (or invisible) concern is refused the same way', async () => {
    concerns.getConcernForCeiling.mockResolvedValue(null);
    const result = makeResult(calls({ concernsUpdated: [{ concernId: C1, severity: 'high' }] }));
    await finalizeAssessment(makeCtx(), result);
    expect(concerns.updateConcern).not.toHaveBeenCalled();
    expect(result.outcome.assessmentSkipped).toEqual(['concern_not_in_org']);
  });

  it('update_concern patches, keeps the concern\'s approval card, and resolves with the grant', async () => {
    concerns.getConcernForCeiling.mockResolvedValue(concern({ approvalIntentId: 'intent-old', evidence: { approvalIntentId: 'intent-old' } }));
    const result = makeResult(calls({
      concernsUpdated: [{ concernId: C1, severity: 'low', evidence: { x: 1, approvalIntentId: 'forged' }, status: 'resolved', outcome: 'customer replied' }],
    }));
    await finalizeAssessment(makeCtx(), result);
    expect(concerns.updateConcern).toHaveBeenCalledWith(C1, {
      severity: 'low', evidence: { x: 1, approvalIntentId: 'intent-old' }, lastAssessedRunId: RUN_ID,
    });
    expect(concerns.resolveConcern).toHaveBeenCalledWith(C1, { grantId: GRANT_ID }, 'customer replied');
  });

  describe('nudge', () => {
    const NUDGE = { concernId: C1, nextStep: 'Call the customer about the printer' };
    const recipient = (o: Partial<NonNullable<Concern['recipient']>> = {}): NonNullable<Concern['recipient']> => ({
      nudgeCount: 0, lastNudgedAt: null, nextEligibleNudgeAt: null, snoozedUntil: null, dismissedAt: null,
      answeredAt: null, digestOnly: false, feedback: null, ...o,
    });

    it('a fresh concern: deliverInApp to the grantor with the exact dedupeKey and link, then recordNudge', async () => {
      concerns.getConcernForCeiling.mockResolvedValue(concern({ severity: 'high', approvalIntentId: 'intent-9', recipient: recipient({ nudgeCount: 1 }) }));
      await finalizeAssessment(makeCtx(), makeResult(calls({ nudges: [NUDGE] })));
      expect(deliverInApp).toHaveBeenCalledTimes(1);
      expect(deliverInApp).toHaveBeenCalledWith({
        userId: GRANTOR,
        orgId: ORG_ID,
        title: `Wisp: ${concern().summary.slice(0, 80)}`,
        body: NUDGE.nextStep,
        link: `/ai/wisp/thread/${THREAD_ID}#concern=${C1}`,
        priority: 'high',
        concernId: C1,
        approvalIntentId: 'intent-9',
        threadId: THREAD_ID,
        grantId: GRANT_ID,
        dedupeKey: `wisp-nudge-${C1}-${GRANT_ID}-1`,
      });
      expect(concerns.recordNudge).toHaveBeenCalledWith(C1, GRANT_ID, expect.any(Date));
      expect(deliverInApp.mock.invocationCallOrder[0]!).toBeLessThan(concerns.recordNudge.mock.invocationCallOrder[0]!);
    });

    it('grantorUserId (from the assessment context) is the nudge recipient, never the model or the ceiling', async () => {
      await finalizeAssessment(makeCtx(), makeResult(calls({ nudges: [NUDGE] })));
      expect(deliverInApp.mock.calls[0]![0]).toMatchObject({ userId: GRANTOR, priority: 'normal', dedupeKey: `wisp-nudge-${C1}-${GRANT_ID}-0` });
    });

    it('nextEligibleNudgeAt in the future → no delivery, nudge_backoff', async () => {
      concerns.getConcernForCeiling.mockResolvedValue(concern({ recipient: recipient({ nudgeCount: 1, nextEligibleNudgeAt: new Date(Date.now() + 60_000).toISOString() }) }));
      const result = makeResult(calls({ nudges: [NUDGE] }));
      await finalizeAssessment(makeCtx(), result);
      expect(deliverInApp).not.toHaveBeenCalled();
      expect(concerns.recordNudge).not.toHaveBeenCalled();
      expect(result.outcome.assessmentSkipped).toEqual(['nudge_backoff']);
    });

    it('digest-only → no delivery, nudge_digest_only', async () => {
      concerns.getConcernForCeiling.mockResolvedValue(concern({ recipient: recipient({ nudgeCount: 2, digestOnly: true }) }));
      const result = makeResult(calls({ nudges: [NUDGE] }));
      await finalizeAssessment(makeCtx(), result);
      expect(deliverInApp).not.toHaveBeenCalled();
      expect(result.outcome.assessmentSkipped).toEqual(['nudge_digest_only']);
    });

    it('nudge respects snooze (Review Focus 5): no delivery before snoozed_until', async () => {
      concerns.getConcernForCeiling.mockResolvedValue(concern({
        status: 'snoozed', recipient: recipient({ snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() }),
      }));
      const result = makeResult(calls({ nudges: [NUDGE] }));
      await finalizeAssessment(makeCtx(), result);
      expect(deliverInApp).not.toHaveBeenCalled();
      expect(result.outcome.assessmentSkipped).toEqual(['nudge_snoozed']);
    });

    it('dismissed by this grant → nudge_dismissed', async () => {
      concerns.getConcernForCeiling.mockResolvedValue(concern({ recipient: recipient({ dismissedAt: '2026-10-21T10:00:00.000Z' }) }));
      const result = makeResult(calls({ nudges: [NUDGE] }));
      await finalizeAssessment(makeCtx(), result);
      expect(deliverInApp).not.toHaveBeenCalled();
      expect(result.outcome.assessmentSkipped).toEqual(['nudge_dismissed']);
    });

    it('a concern in another org → concern_not_in_org, no delivery', async () => {
      concerns.getConcernForCeiling.mockResolvedValue(concern({ orgId: OTHER_ORG }));
      const result = makeResult(calls({ nudges: [NUDGE] }));
      await finalizeAssessment(makeCtx(), result);
      expect(deliverInApp).not.toHaveBeenCalled();
      expect(result.outcome.assessmentSkipped).toEqual(['concern_not_in_org']);
    });

    it('a nudge in the same run as a propose_action carries the card that run just minted (spec §7.4)', async () => {
      const result = makeResult(calls({
        nudges: [{ ...NUDGE, approvalIntentId: 'intent-1' }],
        proposedActions: [{ toolName: 'run_script', input: { scriptId: 's-1' }, reason: 'clear the spooler', concernId: C1 }],
      }));
      await finalizeAssessment(makeCtx(), result);
      expect(createActionIntent.mock.invocationCallOrder[0]!).toBeLessThan(deliverInApp.mock.invocationCallOrder[0]!);
      expect(deliverInApp.mock.calls[0]![0]).toMatchObject({ approvalIntentId: 'intent-1' });
    });

    it('a model-supplied approvalIntentId the run did not mint is not trusted', async () => {
      await finalizeAssessment(makeCtx(), makeResult(calls({ nudges: [{ ...NUDGE, approvalIntentId: '00000000-0000-4000-8000-0000000000ee' }] })));
      expect(deliverInApp.mock.calls[0]![0]).toMatchObject({ approvalIntentId: null });
    });
  });

  describe('propose_action', () => {
    it('Tier 3 → createActionIntent once with source ai_agent, pending id pushed, concern stamped', async () => {
      const result = makeResult(calls({
        proposedActions: [{ toolName: 'run_script', input: { scriptId: 's-1' }, reason: 'clear the spooler', concernId: C1 }],
      }));
      expect(await finalizeAssessment(makeCtx(), result)).toBeNull();
      expect(createActionIntent).toHaveBeenCalledTimes(1);
      expect(createActionIntent).toHaveBeenCalledWith(result.agentAuth, {
        toolName: 'run_script', input: { scriptId: 's-1' }, source: 'ai_agent', orgId: ORG_ID,
        reason: `Proposed by Wisp assessment ${RUN_ID}: clear the spooler`,
      });
      expect(result.intentIds).toEqual(['intent-1']);
      // evidence is replaced by updateConcern, so the finalizer merges.
      expect(concerns.updateConcern).toHaveBeenCalledWith(C1, { evidence: { ticketNumber: 'T-1', approvalIntentId: 'intent-1' } });
    });

    it('Tier 1 → refused with propose_tier1_refused, no intent', async () => {
      const result = makeResult(calls({ proposedActions: [{ toolName: 'query_devices', input: {}, reason: 'look around' }] }));
      await finalizeAssessment(makeCtx(), result);
      expect(createActionIntent).not.toHaveBeenCalled();
      expect(result.outcome.assessmentSkipped).toEqual(['propose_tier1_refused']);
    });

    it('a never-delegable tool is refused before any intent is minted', async () => {
      TIERS.manage_ai_agents = 3;
      const result = makeResult(calls({ proposedActions: [{ toolName: 'manage_ai_agents', input: {}, reason: 'reconfigure' }] }));
      await finalizeAssessment(makeCtx(), result);
      delete TIERS.manage_ai_agents;
      expect(createActionIntent).not.toHaveBeenCalled();
      expect(result.outcome.assessmentSkipped).toEqual(['propose_outside_ceiling']);
    });

    it('Tier 4+ (blocked) → propose_tool_blocked, no intent', async () => {
      const result = makeResult(calls({ proposedActions: [{ toolName: 'wipe_everything', input: {}, reason: 'r' }] }));
      await finalizeAssessment(makeCtx(), result);
      expect(createActionIntent).not.toHaveBeenCalled();
      expect(result.outcome.assessmentSkipped).toEqual(['propose_tool_blocked']);
    });

    it('a tool outside a non-null ceiling toolAllowlist → propose_outside_ceiling', async () => {
      resolveGrantCeiling.mockResolvedValue(ceiling({ toolAllowlist: new Set(['manage_dns_policy']) }));
      const result = makeResult(calls({ proposedActions: [{ toolName: 'run_script', input: {}, reason: 'r' }] }));
      await finalizeAssessment(makeCtx(), result);
      expect(createActionIntent).not.toHaveBeenCalled();
      expect(result.outcome.assessmentSkipped).toEqual(['propose_outside_ceiling']);
    });

    it('an intent that comes back neither pending nor approved → propose_intent_not_pending, concern not stamped', async () => {
      createActionIntent.mockResolvedValue({ id: 'intent-2', status: 'denied' });
      const result = makeResult(calls({ proposedActions: [{ toolName: 'run_script', input: {}, reason: 'r', concernId: C1 }] }));
      expect(await finalizeAssessment(makeCtx(), result)).toBeNull();
      expect(createActionIntent).toHaveBeenCalledTimes(1);
      expect(result.intentIds).toEqual([]);
      expect(concerns.updateConcern).not.toHaveBeenCalledWith(C1, expect.objectContaining({ evidence: expect.anything() }));
      expect(result.outcome.assessmentSkipped).toEqual(['propose_intent_not_pending']);
    });

    it('caps intents at AI_AGENT_LIMIT_DEFAULTS.maxActionsPerRun', async () => {
      const n = AI_AGENT_LIMIT_DEFAULTS.maxActionsPerRun + 1;
      const result = makeResult(calls({
        proposedActions: Array.from({ length: n }, () => ({ toolName: 'run_script', input: {}, reason: 'again' })),
      }));
      await finalizeAssessment(makeCtx(), result);
      expect(createActionIntent).toHaveBeenCalledTimes(AI_AGENT_LIMIT_DEFAULTS.maxActionsPerRun);
      expect(result.outcome.assessmentSkipped).toEqual(['propose_cap']);
    });
  });

  it('request_specialist entries are left in the outcome untouched', async () => {
    const req = { kind: 'backup', params: { a: 1 }, reason: 'needs a backup specialist' };
    const result = makeResult(calls({ specialistRequests: [req] }));
    await finalizeAssessment(makeCtx(), result);
    expect(result.outcome.assessment!.specialistRequests).toEqual([req]);
    expect(result.outcome.assessmentSkipped).toBeUndefined();
  });

  it('a throwing upsertConcern does not prevent the nudge step from running', async () => {
    concerns.upsertConcern.mockRejectedValue(new Error('db down'));
    const result = makeResult(calls({ concernsRaised: [RAISE], nudges: [{ concernId: C1, nextStep: 'Call them' }] }));
    expect(await finalizeAssessment(makeCtx(), result)).toBe('assessment_partially_applied');
    expect(deliverInApp).toHaveBeenCalledTimes(1);
    expect(concerns.recordNudge).toHaveBeenCalledTimes(1);
    expect(rollupPartnerPicture).toHaveBeenCalledWith(GRANT_ID);
  });

  describe('the grant must still be usable for ANY write (model calls, readiness, touch)', () => {
    const readiness = {
      orgId: ORG_ID, orgName: 'Acme',
      checks: [{ watchKind: 'backup_health' as const, serviceable: false, reason: 'no backup integration configured' }],
      missingIntegrations: ['backup'],
    };
    const bookkeepingCtx = () => makeCtx(assessmentCtx({
      reason: { kind: 'onboarding' }, readiness, openConcerns: [concern({ id: C2 })],
    }));

    it('a grant that went inactive during the run applies no model call (grant_inactive), no readiness and no touch', async () => {
      resolveGrantCeiling.mockRejectedValue(new GrantInactiveError(GRANT_ID, 'paused'));
      const result = makeResult(calls({ concernsRaised: [RAISE], nudges: [{ concernId: C1, nextStep: 'x' }] }));
      expect(await finalizeAssessment(bookkeepingCtx(), result)).toBeNull();
      expect(concerns.upsertConcern).not.toHaveBeenCalled();
      expect(concerns.updateConcern).not.toHaveBeenCalled();
      expect(deliverInApp).not.toHaveBeenCalled();
      expect(result.outcome.assessmentSkipped).toEqual(['grant_inactive', 'grant_inactive']);
      // The rollup resolves its own ceiling and fails closed.
      expect(rollupPartnerPicture).toHaveBeenCalledWith(GRANT_ID);
    });

    it('resolves the ceiling even when the model called nothing: an inactive grant gets no readiness concern and no touch', async () => {
      resolveGrantCeiling.mockRejectedValue(new GrantInactiveError(GRANT_ID, 'revoked'));
      const result = makeResult();
      expect(await finalizeAssessment(bookkeepingCtx(), result)).toBeNull();
      expect(resolveGrantCeiling).toHaveBeenCalledWith(GRANT_ID, REVISION_ID);
      expect(concerns.upsertConcern).not.toHaveBeenCalled();
      expect(concerns.updateConcern).not.toHaveBeenCalled();
    });

    it.each([
      ['left the ceiling', ceiling({ orgIds: new Set([OTHER_ORG]) })],
      ['is reached only through a site restriction', ceiling({ siteIds: new Set(['site-1']) })],
    ])('an org that %s gets no model call (grant_org_out_of_ceiling), no readiness and no touch', async (_l, c) => {
      resolveGrantCeiling.mockResolvedValue(c);
      const result = makeResult(calls({ concernsRaised: [RAISE] }));
      expect(await finalizeAssessment(bookkeepingCtx(), result)).toBeNull();
      expect(concerns.upsertConcern).not.toHaveBeenCalled();
      expect(concerns.updateConcern).not.toHaveBeenCalled();
      expect(result.outcome.assessmentSkipped).toEqual(['grant_org_out_of_ceiling']);
    });

    it('a ceiling read that fails for another reason is ceiling_read_failed (not grant_inactive) and partially applied', async () => {
      resolveGrantCeiling.mockRejectedValue(new Error('db down'));
      const result = makeResult(calls({ concernsRaised: [RAISE], nudges: [{ concernId: C1, nextStep: 'x' }] }));
      expect(await finalizeAssessment(bookkeepingCtx(), result)).toBe('assessment_partially_applied');
      expect(concerns.upsertConcern).not.toHaveBeenCalled();
      expect(concerns.updateConcern).not.toHaveBeenCalled();
      expect(deliverInApp).not.toHaveBeenCalled();
      expect(result.outcome.assessmentSkipped).toEqual(['ceiling_read_failed', 'ceiling_read_failed']);
    });

    it('a failed ceiling read with no model calls is still recorded once and partially applied', async () => {
      resolveGrantCeiling.mockRejectedValue(new Error('db down'));
      const result = makeResult();
      expect(await finalizeAssessment(bookkeepingCtx(), result)).toBe('assessment_partially_applied');
      expect(result.outcome.assessmentSkipped).toEqual(['ceiling_read_failed']);
      expect(concerns.updateConcern).not.toHaveBeenCalled();
    });
  });

  describe('partner pin: a concern with the run org but ANOTHER partner is refused', () => {
    beforeEach(() => {
      concerns.getConcernForCeiling.mockResolvedValue(concern({ partnerId: OTHER_PARTNER }));
    });

    it('update_concern', async () => {
      const result = makeResult(calls({ concernsUpdated: [{ concernId: C1, severity: 'high' }] }));
      await finalizeAssessment(makeCtx(), result);
      expect(concerns.updateConcern).not.toHaveBeenCalled();
      expect(result.outcome.assessmentSkipped).toEqual(['concern_not_in_org']);
    });

    it('nudge', async () => {
      const result = makeResult(calls({ nudges: [{ concernId: C1, nextStep: 'Call them' }] }));
      await finalizeAssessment(makeCtx(), result);
      expect(deliverInApp).not.toHaveBeenCalled();
      expect(concerns.recordNudge).not.toHaveBeenCalled();
      expect(result.outcome.assessmentSkipped).toEqual(['concern_not_in_org']);
    });

    it('propose_action', async () => {
      const result = makeResult(calls({ proposedActions: [{ toolName: 'run_script', input: {}, reason: 'r', concernId: C1 }] }));
      await finalizeAssessment(makeCtx(), result);
      expect(createActionIntent).not.toHaveBeenCalled();
      expect(result.outcome.assessmentSkipped).toEqual(['concern_not_in_org']);
    });
  });

  describe('per-item isolation inside a step', () => {
    it('two raises where the first upsert rejects: both attempted, partially applied', async () => {
      concerns.upsertConcern.mockRejectedValueOnce(new Error('db blip'));
      const result = makeResult(calls({ concernsRaised: [RAISE, { ...RAISE, summary: 'second' }] }));
      expect(await finalizeAssessment(makeCtx(), result)).toBe('assessment_partially_applied');
      expect(concerns.upsertConcern).toHaveBeenCalledTimes(2);
      expect(concerns.upsertConcern.mock.calls[1]![0]).toMatchObject({ summary: 'second' });
    });

    it('two nudges where the first delivery throws: the second is still delivered and counted', async () => {
      deliverInApp.mockRejectedValueOnce(new Error('notify down'));
      concerns.getConcernForCeiling.mockImplementation(async (_c: unknown, id: string) => concern({ id }));
      const result = makeResult(calls({ nudges: [{ concernId: C1, nextStep: 'first' }, { concernId: C2, nextStep: 'second' }] }));
      expect(await finalizeAssessment(makeCtx(), result)).toBe('assessment_partially_applied');
      expect(deliverInApp).toHaveBeenCalledTimes(2);
      expect(deliverInApp.mock.calls[1]![0]).toMatchObject({ concernId: C2, body: 'second' });
      expect(concerns.recordNudge).toHaveBeenCalledTimes(1);
      expect(concerns.recordNudge).toHaveBeenCalledWith(C2, GRANT_ID, expect.any(Date));
    });
  });

  it('update_concern with status resolved but no outcome (schema-refused upstream): applies the patch, never resolves, records no skip', async () => {
    const result = makeResult(calls({ concernsUpdated: [{ concernId: C1, severity: 'low', status: 'resolved' }] }));
    expect(await finalizeAssessment(makeCtx(), result)).toBeNull();
    expect(concerns.updateConcern).toHaveBeenCalledWith(C1, { severity: 'low', lastAssessedRunId: RUN_ID });
    expect(concerns.resolveConcern).not.toHaveBeenCalled();
    expect(result.outcome.assessmentSkipped).toBeUndefined();
  });

  it('the touch skips a concern an update already stamped, and a concern of another org', async () => {
    const ctx = makeCtx(assessmentCtx({
      openConcerns: [concern({ id: C1 }), concern({ id: C2 }), concern({ id: '00000000-0000-4000-8000-0000000000c3', orgId: OTHER_ORG })],
    }));
    await finalizeAssessment(ctx, makeResult(calls({ concernsUpdated: [{ concernId: C1, severity: 'high' }] })));
    expect(concerns.updateConcern.mock.calls.map((c) => c[0])).toEqual([C1, C2]);
    expect(concerns.updateConcern).toHaveBeenNthCalledWith(1, C1, { severity: 'high', lastAssessedRunId: RUN_ID });
    expect(concerns.updateConcern).toHaveBeenNthCalledWith(2, C2, { lastAssessedRunId: RUN_ID });
  });

  it('touches last_assessed_run_id on every open concern and calls the rollup best-effort', async () => {
    rollupPartnerPicture.mockRejectedValue(new Error('rollup failed'));
    const ctx = makeCtx(assessmentCtx({ openConcerns: [concern({ id: C1 }), concern({ id: C2 })] }));
    expect(await finalizeAssessment(ctx, makeResult())).toBeNull();
    expect(concerns.updateConcern).toHaveBeenCalledWith(C1, { lastAssessedRunId: RUN_ID });
    expect(concerns.updateConcern).toHaveBeenCalledWith(C2, { lastAssessedRunId: RUN_ID });
    expect(rollupPartnerPicture).toHaveBeenCalledWith(GRANT_ID);
  });

  describe('onboarding readiness concern (Task 15, w00 A33)', () => {
    const readiness = {
      orgId: ORG_ID, orgName: 'Acme',
      checks: [
        { watchKind: 'ticket_waiting' as const, serviceable: true, reason: null },
        { watchKind: 'backup_health' as const, serviceable: false, reason: 'no backup integration configured' },
      ],
      missingIntegrations: ['backup'],
    };
    const onboarding = () => makeCtx(assessmentCtx({ reason: { kind: 'onboarding' }, readiness }));

    it('the first onboarding run creates one org-subject info concern keyed readiness:<org>', async () => {
      await finalizeAssessment(onboarding(), makeResult());
      expect(renderReadinessSummary).toHaveBeenCalledWith(readiness);
      expect(concerns.upsertConcern).toHaveBeenCalledTimes(1);
      expect(concerns.upsertConcern).toHaveBeenCalledWith(expect.objectContaining({
        partnerId: PARTNER_ID, orgId: ORG_ID, subject: { kind: 'org', id: ORG_ID }, severity: 'info',
        signature: `readiness:${ORG_ID}`,
        summary: "I can watch tickets here. I can't watch backups (no backup integration configured).",
        evidence: { readiness: { checks: readiness.checks, missingIntegrations: ['backup'] } },
      }));
      expect(concerns.updateConcern).not.toHaveBeenCalled();
    });

    it('a second onboarding run updates the live readiness concern instead of duplicating it', async () => {
      concerns.upsertConcern.mockResolvedValue({ id: C2, created: false });
      await finalizeAssessment(onboarding(), makeResult());
      expect(concerns.upsertConcern).toHaveBeenCalledTimes(1);
      expect(concerns.updateConcern).toHaveBeenCalledWith(C2, {
        summary: "I can watch tickets here. I can't watch backups (no backup integration configured).",
        evidence: { readiness: { checks: readiness.checks, missingIntegrations: ['backup'] } },
        lastAssessedRunId: RUN_ID,
      });
    });

    it('writes nothing when every check is serviceable, or the run is not an onboarding one', async () => {
      const allGood = { ...readiness, checks: [readiness.checks[0]!], missingIntegrations: [] };
      await finalizeAssessment(makeCtx(assessmentCtx({ reason: { kind: 'onboarding' }, readiness: allGood })), makeResult());
      await finalizeAssessment(makeCtx(assessmentCtx({ reason: { kind: 'tick' }, readiness })), makeResult());
      expect(concerns.upsertConcern).not.toHaveBeenCalled();
    });
  });
});
