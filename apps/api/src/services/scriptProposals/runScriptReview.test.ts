// apps/api/src/services/scriptProposals/runScriptReview.test.ts
//
// `runScriptReview` end to end against a queued Drizzle mock: the order of
// SELECTs / INSERT…RETURNINGs below is the order the implementation makes
// them, so a reordering in reviewer.ts is a deliberate change here too.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG_ID = '00000000-0000-4000-8000-0000000000c1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000c2';
const PROPOSAL_ID = '00000000-0000-4000-8000-0000000000c3';
const REVIEW_ROW_ID = '00000000-0000-4000-8000-0000000000c4';
const RESERVATION_ID = '00000000-0000-4000-8000-0000000000c5';

const shared = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  insertReturningQueue: [] as unknown[][],
  fromCalls: [] as string[],
  insertValues: [] as Record<string, unknown>[],
  transitionProposalMock: vi.fn(),
  reserveAiBudgetMock: vi.fn(),
  releaseMock: vi.fn(async () => undefined),
  checkBudgetDetailedMock: vi.fn(async () => null as unknown),
  resolveModelMock: vi.fn(),
  readOrgPartnerIdMock: vi.fn(),
  anthropicClientForMock: vi.fn(),
  settleInvocationMock: vi.fn(async () => ({ costCents: 1, invocationIds: [], deferred: false })),
  messagesCreateMock: vi.fn(),
  createAuditLogAsyncMock: vi.fn(async () => undefined),
  captureExceptionMock: vi.fn(),
  systemContextDepth: 0,
  maxSystemContextDepth: 0,
  modelCallSystemContextDepth: -1,
}));

function resetDbState(): void {
  shared.selectQueue = [];
  shared.insertReturningQueue = [];
  shared.fromCalls = [];
  shared.insertValues = [];
  shared.systemContextDepth = 0;
  shared.maxSystemContextDepth = 0;
  shared.modelCallSystemContextDepth = -1;
}

vi.mock('../../db', () => {
  function tableName(table: unknown): string {
    const t = table as { _?: { name?: string }; [key: symbol]: unknown };
    if (t?._?.name) return t._.name;
    const sym = Object.getOwnPropertySymbols(t ?? {}).find((s) => s.description === 'drizzle:Name');
    return sym ? String(t[sym]) : String(table);
  }
  function selectBuilder() {
    const builder: Record<string, unknown> = {
      from: vi.fn((table: unknown) => {
        shared.fromCalls.push(tableName(table));
        return builder;
      }),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            if (shared.selectQueue.length === 0) throw new Error(`no queued select rows (from=${shared.fromCalls.at(-1)})`);
            return shared.selectQueue.shift();
          })
          .then(resolve, reject),
    };
    return builder;
  }
  function insertBuilder() {
    const builder: Record<string, unknown> = {
      values: vi.fn((values: Record<string, unknown>) => {
        shared.insertValues.push(values);
        return builder;
      }),
      returning: vi.fn(() => ({
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(shared.insertReturningQueue.shift() ?? []).then(resolve, reject),
      })),
    };
    return builder;
  }
  const dbMock = {
    select: vi.fn(() => selectBuilder()),
    insert: vi.fn(() => insertBuilder()),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbMock)),
  };
  return {
    db: dbMock,
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => {
      shared.systemContextDepth++;
      shared.maxSystemContextDepth = Math.max(shared.maxSystemContextDepth, shared.systemContextDepth);
      try {
        return await fn();
      } finally {
        shared.systemContextDepth--;
      }
    }),
  };
});

vi.mock('../aiBudgetReservations', () => ({
  reserveAiBudget: shared.reserveAiBudgetMock,
  releaseUnusedAiBudgetReservation: shared.releaseMock,
}));
vi.mock('../aiCostTracker', () => ({ checkBudgetDetailed: shared.checkBudgetDetailedMock }));
vi.mock('../aiModels/resolveModel', () => ({ resolveModel: shared.resolveModelMock }));
vi.mock('../aiModels/candidateLoader', () => ({ readOrgPartnerId: shared.readOrgPartnerIdMock }));
// The real createMessage (dispatch shape) over a fake client; only the client
// factory is replaced.
vi.mock('../aiModels/connectionFactory', async (importActual) => ({
  ...(await importActual<typeof import('../aiModels/connectionFactory')>()),
  anthropicClientFor: shared.anthropicClientForMock,
}));
vi.mock('../aiModels/settleInvocation', () => ({ settleInvocation: shared.settleInvocationMock }));
// W09: the cooldown write a provider failure makes (Redis; fails open).
vi.mock('../aiModels/offeringHealth', () => ({ noteProviderFailure: vi.fn(async () => undefined) }));
vi.mock('../auditService', () => ({ createAuditLogAsync: shared.createAuditLogAsyncMock }));
vi.mock('../sentry', () => ({ captureException: shared.captureExceptionMock }));
vi.mock('./proposals', () => ({ transitionProposal: shared.transitionProposalMock }));
// W04 (#5612): the effective lane policy is read by its own module (its two
// SELECTs would otherwise consume this file's queued select rows). The
// reviewer only reads the advisory `maxUnattendedRiskTier` ceiling from it
// (its model is the `script_reviewer` assignment).
vi.mock('./policy', () => ({
  resolveEffectiveScriptPolicy: vi.fn(async () => ({
    proposingEnabled: true, unattendedEnabled: false, maxUnattendedRiskTier: 'low',
    unattendedAllowedClasses: [], maxUnattendedPerHour: 10,
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    source: { partnerRowId: null, orgRowId: null },
  })),
}));

import { APIUserAbortError } from '@anthropic-ai/sdk';
import { makeResolvedModel } from '../aiModels/__fixtures__/resolvedModel';
import { turnBindingFrom } from '../aiModels/turnBinding';
import { ProposalNotReviewableError, runScriptReview, REVIEWER_PROMPT_VERSION, SCRIPT_REVIEW_MAX_OUTPUT_TOKENS } from './reviewer';

const MODEL = 'claude-sonnet-5-5';
const resolvedOk = () => makeResolvedModel('platform', { surface: 'script_reviewer', partnerId: PARTNER_ID, orgId: ORG_ID });

/** Defaults every test starts from: a platform-funded script_reviewer model. */
function primeResolver(): void {
  shared.readOrgPartnerIdMock.mockResolvedValue(PARTNER_ID);
  shared.resolveModelMock.mockResolvedValue(resolvedOk());
  shared.checkBudgetDetailedMock.mockResolvedValue(null);
  shared.anthropicClientForMock.mockImplementation(() => ({ messages: { create: shared.messagesCreateMock } }));
}

/** The one settlement a review makes, against the reservation. */
function expectSettledOnce(inputTokens: number, outputTokens: number): void {
  expect(shared.settleInvocationMock).toHaveBeenCalledTimes(1);
  expect(shared.settleInvocationMock).toHaveBeenCalledWith(expect.objectContaining({
    orgId: ORG_ID, userId: null, sessionId: null, agentRunId: null,
    sourceRef: `script-review:${PROPOSAL_ID}`, reservationId: RESERVATION_ID,
    usage: [expect.objectContaining({ model: MODEL, tokens: expect.objectContaining({ input: inputTokens, output: outputTokens }) })],
  }));
}

/** A reservation settled with no usage (provider outcome unknown / nothing returned). */
function expectSettledAtZero(): void {
  expect(shared.settleInvocationMock).toHaveBeenCalledTimes(1);
  expect(shared.settleInvocationMock).toHaveBeenCalledWith(expect.objectContaining({ reservationId: RESERVATION_ID, usage: [] }));
}

const PROPOSAL_ROW = {
  id: PROPOSAL_ID,
  orgId: ORG_ID,
  status: 'proposed',
  content: 'Restart-Service -Name Spooler',
  language: 'powershell',
  runAs: 'system',
  timeoutSeconds: 120,
  goal: 'Fix the print queue.',
  expectedEffect: 'Spooler restarts.',
  rollbackNote: null,
  verification: { kind: 'service_running', name: 'Spooler' },
  targetDeviceIds: ['00000000-0000-4000-8000-0000000000c9'],
  scannerVersion: '2026-09-11.1',
  basicHits: [],
  strictHits: [],
  touchClasses: ['services'],
  sessionId: '00000000-0000-4000-8000-00000000dead',
  agentRunId: null,
  authorKind: 'chat_session',
};

const VALID_VERDICT = {
  summary: 'Restarts the print spooler service on one workstation.',
  goalMatch: 'yes',
  riskTier: 'low',
  blastRadius: [],
  reversible: true,
  verificationAdequate: true,
  findings: [],
  recommendedAction: 'approve',
};

const RESERVED = {
  kind: 'reserved' as const,
  reservationId: RESERVATION_ID,
  reservedCostCents: 100,
  dailyPeriodKey: '2026-09-11',
  monthlyPeriodKey: '2026-09',
  status: 'active' as const,
};

/** Queue the reads a review makes up to the model call: proposal, existing
 *  static-scan row (none), device facts (the partner id is a mocked loader read). */
function queueReadsThroughModelCall(proposal: Record<string, unknown> = PROPOSAL_ROW, deviceRows: unknown[] = []) {
  shared.selectQueue.push([proposal]);
  shared.selectQueue.push([]); // no existing static_scan row
  shared.selectQueue.push(deviceRows);
}

describe('runScriptReview — happy path', () => {
  beforeEach(() => {
    resetDbState();
    vi.clearAllMocks();
    shared.reserveAiBudgetMock.mockResolvedValue(RESERVED);
    shared.transitionProposalMock.mockResolvedValue(true);
    primeResolver();
    shared.messagesCreateMock.mockImplementation(async () => {
      shared.modelCallSystemContextDepth = shared.systemContextDepth;
      return {
        usage: { input_tokens: 500, output_tokens: 80 },
        content: [{ type: 'text', text: JSON.stringify(VALID_VERDICT) }],
      };
    });
  });

  it('reviews a clean proposal end to end', async () => {
    queueReadsThroughModelCall(PROPOSAL_ROW, [
      { id: PROPOSAL_ROW.targetDeviceIds[0], hostname: 'FIN-WKS-014', osType: 'windows', osVersion: '11 23H2', tags: ['finance'] },
    ]);
    // Inserts: static_scan row, then model review row.
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: REVIEW_ROW_ID, reviewerKind: 'model', status: 'completed', riskTier: 'low' }]);

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ id: REVIEW_ROW_ID, reviewerKind: 'model', status: 'completed' });

    // Static-scan row first, unconditionally, so the chain is complete.
    expect(shared.insertValues[0]).toMatchObject({
      orgId: ORG_ID, proposalId: PROPOSAL_ID, reviewerKind: 'static_scan', status: 'completed', model: null,
    });

    // Budget reserved under the spec's idempotency key, BEFORE the model call.
    expect(shared.reserveAiBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID, idempotencyKey: `script-review:${PROPOSAL_ID}:1`, billingSource: 'platform',
        binding: turnBindingFrom(resolvedOk()),
      }),
    );
    expect(shared.reserveAiBudgetMock.mock.invocationCallOrder[0]!).toBeLessThan(
      shared.messagesCreateMock.mock.invocationCallOrder[0]!,
    );

    // BYOK + egress-audit parity: through the factory, under the new surface.
    expect(shared.anthropicClientForMock).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, surface: 'script_reviewer' }), { surface: 'script_review_verdict', orgId: ORG_ID },
    );

    // The model call: capped output, no tools, a system + single user turn,
    // content delimited, device facts present, nothing session-shaped.
    expect(shared.messagesCreateMock).toHaveBeenCalledTimes(1);
    const [createArgs, createOpts] = shared.messagesCreateMock.mock.calls[0]! as [Record<string, unknown>, Record<string, unknown>];
    expect(createArgs).toMatchObject({ model: MODEL, max_tokens: SCRIPT_REVIEW_MAX_OUTPUT_TOKENS });
    // Thinking/effort come from the resolved wire params, never per-model-id literals.
    expect(createArgs).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
    expect(createArgs).not.toHaveProperty('tools');
    expect(createArgs.messages).toHaveLength(1);
    const userText = (createArgs.messages as Array<{ role: string; content: string }>)[0]!.content;
    expect(userText).toContain('<<<SCRIPT_CONTENT_START>>>');
    expect(userText).toContain('FIN-WKS-014');
    expect(`${createArgs.system}\n${userText}`).not.toContain(PROPOSAL_ROW.sessionId);
    expect(`${createArgs.system}\n${userText}`).not.toMatch(/ai_messages|transcript/i);
    expect(createOpts).toMatchObject({ maxRetries: 0 });
    expect(createOpts.signal).toBeInstanceOf(AbortSignal);
    // Never inside a held DB transaction/context while the model call runs.
    expect(shared.modelCallSystemContextDepth).toBe(0);
    // No transcript table was ever read.
    expect(shared.fromCalls.join(',')).not.toMatch(/ai_messages|ai_sessions|ai_agent_runs/);

    // Model row persisted with the floored verdict + prompt version + reservation.
    expect(shared.insertValues[1]).toMatchObject({
      orgId: ORG_ID, proposalId: PROPOSAL_ID, reviewerKind: 'model', status: 'completed',
      model: MODEL, reviewerPromptVersion: REVIEWER_PROMPT_VERSION,
      riskTier: 'low', goalMatch: 'yes', recommendedAction: 'approve',
      inputTokens: 500, outputTokens: 80, budgetReservationId: RESERVATION_ID,
    });

    expect(shared.transitionProposalMock).toHaveBeenCalledWith(
      expect.anything(), PROPOSAL_ID, ['proposed'], 'reviewed', expect.objectContaining({ riskTier: 'low' }),
    );
    // Settled exactly once, at the real token counts, against the reservation.
    expectSettledOnce(500, 80);
    expect(shared.createAuditLogAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID, action: 'script.proposal.reviewed', resourceType: 'script_proposal',
        resourceId: PROPOSAL_ID, result: 'success',
      }),
    );
  });

  it('applies floors to a verdict the model under-scored (from the classifier, not the model)', async () => {
    queueReadsThroughModelCall({ ...PROPOSAL_ROW, strictHits: ['obfuscated invoke'], touchClasses: ['credentials'] });
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: REVIEW_ROW_ID, reviewerKind: 'model', status: 'completed', riskTier: 'high' }]);
    shared.messagesCreateMock.mockResolvedValueOnce({
      usage: { input_tokens: 400, output_tokens: 60 },
      content: [{ type: 'text', text: JSON.stringify({ ...VALID_VERDICT, riskTier: 'low' }) }],
    });

    await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    const [, , , , patch] = shared.transitionProposalMock.mock.calls[0]!;
    expect(patch).toMatchObject({ riskTier: 'high' });
    expect(shared.insertValues[1]).toMatchObject({ riskTier: 'high' });
  });

  it('treats an `unlimited` reservation like a reserved one (still settled by id)', async () => {
    shared.reserveAiBudgetMock.mockResolvedValueOnce({
      kind: 'unlimited', reservationId: RESERVATION_ID, dailyPeriodKey: 'k', monthlyPeriodKey: 'k', status: 'active',
    });
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: REVIEW_ROW_ID, reviewerKind: 'model', status: 'completed' }]);

    await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expectSettledOnce(500, 80);
  });

  it('tolerates a JSON verdict wrapped in a markdown code fence', async () => {
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: REVIEW_ROW_ID, reviewerKind: 'model', status: 'completed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce({
      usage: { input_tokens: 400, output_tokens: 60 },
      content: [{ type: 'text', text: '```json\n' + JSON.stringify(VALID_VERDICT) + '\n```' }],
    });

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });
    expect(result).toMatchObject({ status: 'completed' });
    expect(shared.transitionProposalMock).toHaveBeenCalledWith(
      expect.anything(), PROPOSAL_ID, ['proposed'], 'reviewed', expect.anything(),
    );
  });

  it('does not insert a second static-scan row when a prior attempt already wrote one', async () => {
    shared.selectQueue.push([PROPOSAL_ROW]);
    shared.selectQueue.push([{ id: 'existing-static-scan' }]); // already present
    shared.selectQueue.push([]);
    shared.insertReturningQueue.push([{ id: REVIEW_ROW_ID, reviewerKind: 'model', status: 'completed' }]);

    await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(shared.insertValues).toHaveLength(1);
    expect(shared.insertValues[0]).toMatchObject({ reviewerKind: 'model' });
  });
});

describe('runScriptReview — failure paths (D7: fail closed)', () => {
  beforeEach(() => {
    resetDbState();
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    shared.transitionProposalMock.mockResolvedValue(true);
    primeResolver();
  });

  function expectFailedClosed(status: 'failed' | 'timeout') {
    // Failure row is a `model` row so the chain reads static_scan → model(failed).
    expect(shared.insertValues.at(-1)).toMatchObject({ reviewerKind: 'model', status });
    expect(shared.transitionProposalMock).toHaveBeenCalledWith(
      expect.anything(), PROPOSAL_ID, ['proposed'], 'review_failed', expect.objectContaining({ decisionNote: expect.any(String) }),
    );
    expect(shared.transitionProposalMock).not.toHaveBeenCalledWith(
      expect.anything(), PROPOSAL_ID, expect.anything(), 'reviewed', expect.anything(),
    );
    expect(shared.createAuditLogAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'script.proposal.review_failed', result: 'failure' }),
    );
  }

  it('budget denied ⇒ review_failed, no model call, nothing to settle (nothing was reserved)', async () => {
    shared.selectQueue.push([PROPOSAL_ROW]);
    shared.selectQueue.push([]); // no static_scan row yet
    shared.reserveAiBudgetMock.mockResolvedValueOnce({ kind: 'denied', reason: 'daily_budget', message: 'Daily AI budget exhausted ($5.00)' });
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-1', reviewerKind: 'model', status: 'failed' }]);

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.anthropicClientForMock).not.toHaveBeenCalled();
    expect(shared.messagesCreateMock).not.toHaveBeenCalled();
    expect(shared.settleInvocationMock).not.toHaveBeenCalled();
    expect(shared.releaseMock).not.toHaveBeenCalled();
    expect(shared.insertValues.at(-1)).toMatchObject({ budgetReservationId: null, model: null, summary: expect.stringContaining('daily_budget') });
    expectFailedClosed('failed');
  });

  it('provider client unavailable ⇒ review_failed, nothing dispatched so the reservation is released', async () => {
    queueReadsThroughModelCall();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.anthropicClientForMock.mockImplementationOnce(() => { throw new Error('egress blocked'); });
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-2', reviewerKind: 'model', status: 'failed' }]);

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.messagesCreateMock).not.toHaveBeenCalled();
    expect(shared.settleInvocationMock).not.toHaveBeenCalled();
    expect(shared.releaseMock).toHaveBeenCalledWith({ orgId: ORG_ID, reservationId: RESERVATION_ID });
    expectFailedClosed('failed');
  });

  it('provider error before any response ⇒ review_failed, reservation settled at zero', async () => {
    queueReadsThroughModelCall();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-3', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock.mockRejectedValueOnce(new Error('connection reset'));

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expectSettledAtZero();
    expect(shared.insertValues.at(-1)).toMatchObject({ budgetReservationId: RESERVATION_ID, model: MODEL });
    expectFailedClosed('failed');
  });

  it('timeout ⇒ review_failed with a timeout-classified review row, reservation settled at zero', async () => {
    queueReadsThroughModelCall();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-4', reviewerKind: 'model', status: 'timeout' }]);
    const abortError = new Error('The operation was aborted due to timeout');
    abortError.name = 'TimeoutError';
    shared.messagesCreateMock.mockRejectedValueOnce(abortError);

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'timeout' });
    expectSettledAtZero();
    expectFailedClosed('timeout');
  });

  it('truncated non-JSON ⇒ review_failed, reservation settled at the REAL (nonzero) token counts already spent', async () => {
    queueReadsThroughModelCall();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-5', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce({ usage: { input_tokens: 300, output_tokens: 40 }, stop_reason: 'max_tokens', content: [{ type: 'text', text: 'not json at all' }] });

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expectSettledOnce(300, 40);
    expect(shared.insertValues.at(-1)).toMatchObject({ inputTokens: 300, outputTokens: 40 });
    expectFailedClosed('failed');
  });

  it('schema-invalid JSON (missing required field) ⇒ review_failed', async () => {
    queueReadsThroughModelCall();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-6', reviewerKind: 'model', status: 'failed' }]);
    const { findings: _findings, ...withoutFindings } = VALID_VERDICT as Record<string, unknown>;
    shared.messagesCreateMock.mockResolvedValueOnce({ usage: { input_tokens: 300, output_tokens: 40 }, content: [{ type: 'text', text: JSON.stringify(withoutFindings) }] });

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.insertValues.at(-1)).toMatchObject({ summary: expect.stringContaining('findings') });
    expectFailedClosed('failed');
    // #10954: a structural schema failure is not retried.
    expect(shared.messagesCreateMock).toHaveBeenCalledTimes(1);
    expect(shared.reserveAiBudgetMock).toHaveBeenCalledTimes(1);
  });

  it('no text block at all (e.g. max_tokens hit mid-thought) ⇒ review_failed', async () => {
    queueReadsThroughModelCall();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-7', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce({ usage: { input_tokens: 300, output_tokens: 2000 }, stop_reason: 'max_tokens', content: [] });

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expectSettledOnce(300, 2000);
    expectFailedClosed('failed');
  });

  it('idempotent under retry: a proposal already past "proposed" short-circuits with no second model call or reservation', async () => {
    shared.selectQueue.push([{ ...PROPOSAL_ROW, status: 'reviewed' }]);
    shared.selectQueue.push([{ id: REVIEW_ROW_ID, reviewerKind: 'model', status: 'completed', riskTier: 'low' }]);

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ id: REVIEW_ROW_ID });
    expect(shared.reserveAiBudgetMock).not.toHaveBeenCalled();
    expect(shared.messagesCreateMock).not.toHaveBeenCalled();
    expect(shared.settleInvocationMock).not.toHaveBeenCalled();
    expect(shared.insertValues).toHaveLength(0);
  });

  it('a proposal that left "proposed" with no model review (superseded/expired) is not reviewable — no retry, no spend', async () => {
    shared.selectQueue.push([{ ...PROPOSAL_ROW, status: 'superseded' }]);
    shared.selectQueue.push([]);

    await expect(runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 })).rejects.toBeInstanceOf(ProposalNotReviewableError);
    expect(shared.reserveAiBudgetMock).not.toHaveBeenCalled();
    expect(shared.insertValues).toHaveLength(0);
  });

  it('a proposal missing from the org (cross-org id) is not reviewable', async () => {
    shared.selectQueue.push([]);

    await expect(runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 })).rejects.toBeInstanceOf(ProposalNotReviewableError);
  });

  it('lost CAS race: a concurrent attempt already transitioned the proposal ⇒ settles its own spend once and returns the winner', async () => {
    queueReadsThroughModelCall();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'loser-row', reviewerKind: 'model', status: 'completed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce({ usage: { input_tokens: 500, output_tokens: 80 }, content: [{ type: 'text', text: JSON.stringify(VALID_VERDICT) }] });
    shared.transitionProposalMock.mockResolvedValueOnce(false);
    shared.selectQueue.push([{ id: 'winner-row', reviewerKind: 'model', status: 'completed' }]);

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ id: 'winner-row' });
    expectSettledOnce(500, 80);
    // Not fail-closed: the winner's completed review stands.
    expect(shared.transitionProposalMock).not.toHaveBeenCalledWith(expect.anything(), PROPOSAL_ID, expect.anything(), 'review_failed', expect.anything());
  });
});

describe('runScriptReview — review-round fixes (#5636)', () => {
  beforeEach(() => {
    resetDbState();
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    shared.transitionProposalMock.mockResolvedValue(true);
    primeResolver();
  });

  it('a lost CAS while recording a FAILURE rolls the failure row back and returns the winner (no spurious failed row, no review_failed audit)', async () => {
    queueReadsThroughModelCall();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'loser-fail-row', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock.mockRejectedValueOnce(new Error('connection reset'));
    shared.transitionProposalMock.mockResolvedValueOnce(false); // review_failed CAS loses
    shared.selectQueue.push([{ id: 'winner-row', reviewerKind: 'model', status: 'completed' }]);

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ id: 'winner-row', status: 'completed' });
    // The reservation was still settled (at zero) exactly once.
    expectSettledAtZero();
    expect(shared.createAuditLogAsyncMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'script.proposal.review_failed' }),
    );
  });

  it('an org that vanished (no partner) fails closed before any reservation', async () => {
    shared.selectQueue.push([PROPOSAL_ROW]);
    shared.selectQueue.push([]); // no static_scan row
    shared.readOrgPartnerIdMock.mockResolvedValueOnce(null);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-org', reviewerKind: 'model', status: 'failed' }]);

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.resolveModelMock).not.toHaveBeenCalled();
    expect(shared.reserveAiBudgetMock).not.toHaveBeenCalled();
    expect(shared.transitionProposalMock).toHaveBeenCalledWith(expect.anything(), PROPOSAL_ID, ['proposed'], 'review_failed', expect.anything());
  });

  it('a device-facts query error after the reservation fails closed and settles at zero', async () => {
    shared.selectQueue.push([PROPOSAL_ROW]);
    shared.selectQueue.push([]);
    // loadDeviceFacts: nothing queued ⇒ the mock throws "no queued select rows".
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-dev', reviewerKind: 'model', status: 'failed' }]);

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.messagesCreateMock).not.toHaveBeenCalled();
    expect(shared.settleInvocationMock).not.toHaveBeenCalled();
    expect(shared.releaseMock).toHaveBeenCalledWith({ orgId: ORG_ID, reservationId: RESERVATION_ID });
  });

  it("the SDK's own abort/timeout error classes are classified as timeout (not just the DOM TimeoutError name)", async () => {
    queueReadsThroughModelCall();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-sdk', reviewerKind: 'model', status: 'timeout' }]);
    shared.messagesCreateMock.mockRejectedValueOnce(new APIUserAbortError());

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'timeout' });
    expect(shared.insertValues.at(-1)).toMatchObject({ status: 'timeout' });
  });

  it('a settlement error AFTER the review committed does not fail the job: the review is returned, the audit row is written, Sentry is told', async () => {
    queueReadsThroughModelCall();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: REVIEW_ROW_ID, reviewerKind: 'model', status: 'completed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce({ usage: { input_tokens: 500, output_tokens: 80 }, content: [{ type: 'text', text: JSON.stringify(VALID_VERDICT) }] });
    shared.settleInvocationMock.mockRejectedValueOnce(new Error('ledger write failed'));

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ id: REVIEW_ROW_ID, status: 'completed' });
    expect(shared.captureExceptionMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'ledger write failed' }), undefined, expect.objectContaining({ service: 'scriptReview' }));
    expect(shared.createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'script.proposal.reviewed' }));
  });

  it('an unparseable verdict keeps the raw model text on the failure row for diagnosis, and reaches Sentry', async () => {
    queueReadsThroughModelCall();
    // #10954: two reservations and two answers, because a parse failure gets one retry.
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED).mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-raw', reviewerKind: 'model', status: 'failed' }]);
    const prose = { usage: { input_tokens: 300, output_tokens: 40 }, content: [{ type: 'text', text: 'Sure! Here is my review in prose…' }] };
    shared.messagesCreateMock.mockResolvedValueOnce(prose).mockResolvedValueOnce(prose);

    await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(shared.insertValues.at(-1)).toMatchObject({ verdict: { rawText: 'Sure! Here is my review in prose…' } });
    expect(shared.captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ service: 'scriptReview', reviewStatus: 'failed' }));
  });

  // #10971 — US prod 2026-11-04: adaptive thinking ate the whole output cap
  // and the cut-off verdict was reported as "no parseable JSON verdict".
  it('a verdict cut off by max_tokens fails with an output-budget reason, settles the real spend, and keeps the raw text', async () => {
    queueReadsThroughModelCall();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-cap', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce({
      usage: { input_tokens: 3200, output_tokens: SCRIPT_REVIEW_MAX_OUTPUT_TOKENS },
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"summary": "The script blocks audit (SACL) inheri' }],
    });

    await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    const row = shared.insertValues.at(-1) as { status: string; summary: string; verdict: { rawText: string } };
    expect(row.status).toBe('failed');
    expect(row.summary).toMatch(/output budget/i);
    expect(row.summary).not.toMatch(/parseable/i);
    expect(row.verdict.rawText).toContain('The script blocks audit');
    expectSettledOnce(3200, SCRIPT_REVIEW_MAX_OUTPUT_TOKENS);
    // #10954: a retry would hit the same cap and pay for it twice.
    expect(shared.messagesCreateMock).toHaveBeenCalledTimes(1);
    expect(shared.reserveAiBudgetMock).toHaveBeenCalledTimes(1);
  });
});

// #10954: a wordy summary must not sink a verdict, and one unparseable response
// gets exactly one more try, each try reserved and settled on its own.
describe('runScriptReview — summary clamp and parse retry (#10954)', () => {
  const RETRY_RESERVATION_ID = '00000000-0000-4000-8000-0000000000c6';
  const unparseable = (input: number, output: number) => ({
    usage: { input_tokens: input, output_tokens: output },
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Sure! Here is my review in prose' }],
  });
  const settledCalls = () => (shared.settleInvocationMock.mock.calls as unknown as Array<[Record<string, unknown>]>).map(([arg]) => arg);

  beforeEach(() => {
    resetDbState();
    vi.clearAllMocks();
    shared.messagesCreateMock.mockReset();
    shared.reserveAiBudgetMock.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    shared.transitionProposalMock.mockResolvedValue(true);
    primeResolver();
    shared.reserveAiBudgetMock
      .mockResolvedValueOnce(RESERVED)
      .mockResolvedValueOnce({ ...RESERVED, reservationId: RETRY_RESERVATION_ID });
  });

  it('a 900-character summary is accepted, clamped, and costs no retry', async () => {
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: REVIEW_ROW_ID, reviewerKind: 'model', status: 'completed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce({
      usage: { input_tokens: 500, output_tokens: 80 },
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ ...VALID_VERDICT, summary: 'z'.repeat(900) }) }],
    });

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'completed' });
    const row = shared.insertValues.at(-1) as { status: string; summary: string; verdict: { summary: string } };
    expect(row.status).toBe('completed');
    expect(Array.from(row.summary)).toHaveLength(600);
    expect(row.summary.endsWith('…')).toBe(true);
    expect(row.verdict.summary).toBe(row.summary);
    expect(shared.messagesCreateMock).toHaveBeenCalledTimes(1);
    expectSettledOnce(500, 80);
  });

  it('unparseable then valid: one retry, success, and both attempts settled on their own reservations', async () => {
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: REVIEW_ROW_ID, reviewerKind: 'model', status: 'completed' }]);
    shared.messagesCreateMock
      .mockResolvedValueOnce(unparseable(300, 40))
      .mockResolvedValueOnce({
        usage: { input_tokens: 500, output_tokens: 80 },
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(VALID_VERDICT) }],
      });

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'completed' });
    expect(shared.messagesCreateMock).toHaveBeenCalledTimes(2);
    expect(shared.reserveAiBudgetMock).toHaveBeenCalledTimes(2);
    expect(shared.reserveAiBudgetMock.mock.calls.map(([arg]) => (arg as { idempotencyKey: string }).idempotencyKey)).toEqual([
      `script-review:${PROPOSAL_ID}:1`,
      `script-review:${PROPOSAL_ID}:1:parse-retry`,
    ]);
    expect(settledCalls().map((c) => c.reservationId)).toEqual([RESERVATION_ID, RETRY_RESERVATION_ID]);
    expect(settledCalls().map((c) => (c.usage as Array<{ tokens: { input: number; output: number } }>)[0]!.tokens)).toEqual([
      expect.objectContaining({ input: 300, output: 40 }),
      expect.objectContaining({ input: 500, output: 80 }),
    ]);
    // The review row counts every token this review spent and points at the
    // reservation of the attempt that produced its verdict.
    expect(shared.insertValues.at(-1)).toMatchObject({
      status: 'completed', inputTokens: 800, outputTokens: 120, budgetReservationId: RETRY_RESERVATION_ID,
    });
    expect(shared.transitionProposalMock).toHaveBeenCalledWith(expect.anything(), PROPOSAL_ID, ['proposed'], 'reviewed', expect.anything());
  });

  it('unparseable twice: review_failed with the parse reason, two attempts settled, no third call', async () => {
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce(unparseable(300, 40)).mockResolvedValueOnce(unparseable(310, 45));

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.messagesCreateMock).toHaveBeenCalledTimes(2);
    expect(settledCalls().map((c) => c.reservationId)).toEqual([RESERVATION_ID, RETRY_RESERVATION_ID]);
    expect(shared.insertValues.at(-1)).toMatchObject({
      status: 'failed', summary: 'Reviewer returned no parseable JSON verdict', inputTokens: 610, outputTokens: 85,
      budgetReservationId: RETRY_RESERVATION_ID,
    });
    expect(shared.transitionProposalMock).toHaveBeenCalledWith(
      expect.anything(), PROPOSAL_ID, ['proposed'], 'review_failed',
      expect.objectContaining({ decisionNote: 'Reviewer returned no parseable JSON verdict' }),
    );
  });

  it('retry refused by the budget: fails with the parse reason, nothing dispatched or settled twice', async () => {
    shared.reserveAiBudgetMock.mockReset();
    shared.reserveAiBudgetMock
      .mockResolvedValueOnce(RESERVED)
      .mockResolvedValueOnce({ kind: 'denied', reason: 'daily_cap', message: 'cap reached' });
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce(unparseable(300, 40));

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.messagesCreateMock).toHaveBeenCalledTimes(1);
    expectSettledOnce(300, 40);
    // The reason says the retry never happened, so a budget problem is not read as the reviewer's.
    expect(shared.insertValues.at(-1)).toMatchObject({
      summary: 'Reviewer returned no parseable JSON verdict (the one retry was not attempted: budget not admitted)',
      inputTokens: 300, outputTokens: 40,
    });
  });

  it('a retry reservation that throws still fails closed with the parse reason, and is reported', async () => {
    shared.reserveAiBudgetMock.mockReset();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED).mockRejectedValueOnce(new Error('pool exhausted'));
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce(unparseable(300, 40));

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expectSettledOnce(300, 40);
    expect(shared.insertValues.at(-1)).toMatchObject({
      summary: 'Reviewer returned no parseable JSON verdict (the one retry was not attempted: reservation failed)',
    });
    expect(shared.captureExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'pool exhausted' }), undefined, expect.objectContaining({ area: 'script_review_parse_retry' }),
    );
  });

  it('a reply with no stop reason and no text is retried too', async () => {
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: REVIEW_ROW_ID, reviewerKind: 'model', status: 'completed' }]);
    shared.messagesCreateMock
      .mockResolvedValueOnce({ usage: { input_tokens: 300, output_tokens: 40 }, content: [] })
      .mockResolvedValueOnce({
        usage: { input_tokens: 500, output_tokens: 80 },
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(VALID_VERDICT) }],
      });

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'completed' });
    expect(shared.messagesCreateMock).toHaveBeenCalledTimes(2);
  });

  it('a provider error on the retry fails the review, settles both, and keeps the first attempt\'s tokens on the row', async () => {
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce(unparseable(300, 40)).mockRejectedValueOnce(new Error('connection reset'));

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(settledCalls().map((c) => c.reservationId)).toEqual([RESERVATION_ID, RETRY_RESERVATION_ID]);
    expect(settledCalls()[1]).toMatchObject({ usage: [] });
    expect(shared.insertValues.at(-1)).toMatchObject({ inputTokens: 300, outputTokens: 40, budgetReservationId: RETRY_RESERVATION_ID });
    // Both facts: why a retry was needed, and what happened to it.
    expect((shared.insertValues.at(-1) as { summary: string }).summary)
      .toBe('Reviewer returned no parseable JSON verdict; the one retry failed: Reviewer model call failed: connection reset');
    expect(shared.transitionProposalMock).toHaveBeenCalledWith(expect.anything(), PROPOSAL_ID, ['proposed'], 'review_failed', expect.anything());
  });

  // CI, PR #10985: a call that answers with nothing threw out of runScriptReview
  // while reading its usage, leaving the proposal `proposed` and a reservation open.
  it('a retry that answers with nothing fails closed with the parse reason, and both attempts are settled', async () => {
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce(unparseable(300, 40)).mockResolvedValueOnce(undefined);

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(settledCalls().map((c) => c.reservationId)).toEqual([RESERVATION_ID, RETRY_RESERVATION_ID]);
    expect(settledCalls()[1]).toMatchObject({ usage: [] });
    expect(shared.insertValues.at(-1)).toMatchObject({ status: 'failed', inputTokens: 300, outputTokens: 40, budgetReservationId: RETRY_RESERVATION_ID });
    expect((shared.insertValues.at(-1) as { summary: string }).summary).toMatch(/^Reviewer returned no parseable JSON verdict; the one retry failed: /);
    expect(shared.transitionProposalMock).toHaveBeenCalledWith(expect.anything(), PROPOSAL_ID, ['proposed'], 'review_failed', expect.anything());
  });

  it('a response with no usage on the retry fails closed the same way', async () => {
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock
      .mockResolvedValueOnce(unparseable(300, 40))
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(VALID_VERDICT) }] });

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(settledCalls().map((c) => c.reservationId)).toEqual([RESERVATION_ID, RETRY_RESERVATION_ID]);
  });

  it('a first call that answers with nothing fails closed too: no retry, its reservation settled', async () => {
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce(undefined);

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.messagesCreateMock).toHaveBeenCalledTimes(1);
    expectSettledAtZero();
    expect((shared.insertValues.at(-1) as { summary: string }).summary).toMatch(/^Reviewer model call failed: /);
  });

  it('a refusal on the retry fails with the refusal, and both attempts are settled', async () => {
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock
      .mockResolvedValueOnce(unparseable(300, 40))
      .mockResolvedValueOnce({ usage: { input_tokens: 200, output_tokens: 5 }, stop_reason: 'refusal', content: [] });

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.messagesCreateMock).toHaveBeenCalledTimes(2);
    expect(settledCalls().map((c) => c.reservationId)).toEqual([RESERVATION_ID, RETRY_RESERVATION_ID]);
    expect((shared.insertValues.at(-1) as { summary: string }).summary).not.toMatch(/parseable/);
    expect(shared.insertValues.at(-1)).toMatchObject({ inputTokens: 500, outputTokens: 45 });
  });
});

describe('runScriptReview — registry resolution (W03 Task 11)', () => {
  const JOB = { proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 };

  beforeEach(() => {
    resetDbState();
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    primeResolver();
    shared.reserveAiBudgetMock.mockResolvedValue(RESERVED);
    shared.transitionProposalMock.mockResolvedValue(true);
    shared.messagesCreateMock.mockImplementation(async () => ({
      usage: { input_tokens: 500, output_tokens: 80 },
      content: [{ type: 'text', text: JSON.stringify(VALID_VERDICT) }],
    }));
  });

  function queueHappy(): void {
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: REVIEW_ROW_ID, reviewerKind: 'model', status: 'completed' }]);
  }

  function queueFailedBeforeDispatch(): void {
    shared.selectQueue.push([PROPOSAL_ROW], []);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row', reviewerKind: 'model', status: 'failed' }]);
  }

  it('resolves the script_reviewer assignment BEFORE reserving, and reserves with its funding + binding', async () => {
    const model = makeResolvedModel('anthropic_byok', { surface: 'script_reviewer' });
    shared.resolveModelMock.mockResolvedValue(model);
    queueHappy();
    await runScriptReview(JOB);
    expect(shared.resolveModelMock).toHaveBeenCalledWith({
      partnerId: PARTNER_ID, orgId: ORG_ID, surface: 'script_reviewer', maxTokens: SCRIPT_REVIEW_MAX_OUTPUT_TOKENS,
    });
    // A system call: no userId, so no per-user permission gate.
    expect(shared.resolveModelMock.mock.calls[0]![0]).not.toHaveProperty('userId');
    expect(shared.resolveModelMock.mock.invocationCallOrder[0]!).toBeLessThan(shared.reserveAiBudgetMock.mock.invocationCallOrder[0]!);
    expect(shared.checkBudgetDetailedMock).toHaveBeenCalledWith(ORG_ID, 'partner_key');
    expect(shared.reserveAiBudgetMock).toHaveBeenCalledWith(expect.objectContaining({
      billingSource: 'partner_key', binding: turnBindingFrom(model),
      // Stable key: a retry of the same attempt re-binds its unsettled reservation.
      idempotencyKey: `script-review:${PROPOSAL_ID}:1`,
    }));
    expect(shared.settleInvocationMock).toHaveBeenCalledWith(expect.objectContaining({
      binding: turnBindingFrom(model), sourceRef: `script-review:${PROPOSAL_ID}`, userId: null,
    }));
  });

  it('an ineligible reviewer model fails the review with the resolver message and takes no reservation', async () => {
    shared.resolveModelMock.mockResolvedValue({
      ok: false, reason: 'unpriced', recoverable: true, offeringId: 'o', message: 'This AI model has no price set and cannot be used yet.',
    });
    queueFailedBeforeDispatch();
    await runScriptReview(JOB);
    expect(shared.reserveAiBudgetMock).not.toHaveBeenCalled();
    expect(shared.checkBudgetDetailedMock).not.toHaveBeenCalled();
    expect(shared.messagesCreateMock).not.toHaveBeenCalled();
    expect(shared.insertValues.at(-1)).toMatchObject({
      status: 'failed', budgetReservationId: null, summary: expect.stringContaining('no price set'),
    });
  });

  it('exhausted platform credits fail the review before any reservation or provider call', async () => {
    shared.checkBudgetDetailedMock.mockResolvedValue({ message: 'You are out of AI credits.', reason: 'credits_exhausted', permanent: false });
    queueFailedBeforeDispatch();
    await runScriptReview(JOB);
    expect(shared.reserveAiBudgetMock).not.toHaveBeenCalled();
    expect(shared.messagesCreateMock).not.toHaveBeenCalled();
    expect(shared.insertValues.at(-1)).toMatchObject({ status: 'failed', summary: 'You are out of AI credits.' });
  });

  it('a stored reviewer_model is ignored at runtime (the assignment is authoritative)', async () => {
    const { resolveEffectiveScriptPolicy } = await import('./policy');
    vi.mocked(resolveEffectiveScriptPolicy).mockResolvedValueOnce({ reviewerModel: 'claude-opus-4-8', maxUnattendedRiskTier: 'low' } as never);
    queueHappy();
    await runScriptReview(JOB);
    expect(shared.messagesCreateMock.mock.calls[0]![0]).toMatchObject({ model: MODEL });
    expect(shared.resolveModelMock.mock.calls[0]![0]).not.toHaveProperty('requested');
  });

  it('the dispatch keeps its hard wall clock and never retries inside the SDK', async () => {
    queueHappy();
    await runScriptReview(JOB);
    const [, opts] = shared.messagesCreateMock.mock.calls[0]! as [unknown, Record<string, unknown>];
    expect(opts).toMatchObject({ maxRetries: 0 });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('a refusal fails the review with the category, and the spend is still settled', async () => {
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-refusal', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce({
      usage: { input_tokens: 300, output_tokens: 5 }, content: [],
      stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' },
    });
    await runScriptReview(JOB);
    expectSettledOnce(300, 5);
    expect(shared.insertValues.at(-1)).toMatchObject({
      status: 'failed', summary: expect.stringContaining('The model declined this request (category: cyber).'),
    });
    expect(shared.transitionProposalMock).toHaveBeenCalledWith(expect.anything(), PROPOSAL_ID, ['proposed'], 'review_failed', expect.anything());
  });

  it('settles through the single billing path only, exactly once', async () => {
    queueHappy();
    await runScriptReview(JOB);
    expect(shared.settleInvocationMock).toHaveBeenCalledTimes(1);
  });
});

describe('runScriptReview — W09 failover (#7607)', () => {
  const JOB = { proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 };
  const HOP1_RESERVATION = '00000000-0000-4000-8000-0000000000d1';
  const overloaded = () => Object.assign(new Error('Overloaded'), {
    status: 529, error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  });
  const primary = () => makeResolvedModel('platform', {
    surface: 'script_reviewer', partnerId: PARTNER_ID, orgId: ORG_ID, offering: { id: 'p', displayName: 'P' }, failoverRemaining: ['k'],
  });
  const backup = () => makeResolvedModel('anthropic_byok', {
    surface: 'script_reviewer', partnerId: PARTNER_ID, orgId: ORG_ID, offering: { id: 'k', displayName: 'K' },
    wireModel: 'claude-backup-wire', failover: { fromOfferingId: 'p', hop: 1, cause: 'overloaded' }, failoverRemaining: [],
  });
  const settles = () => shared.settleInvocationMock.mock.calls.map((c) => (c as unknown as [{
    binding: { offeringId: string }; usage: unknown[]; reservationId: string;
  }])[0]);

  beforeEach(() => {
    resetDbState();
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    primeResolver();
    shared.transitionProposalMock.mockResolvedValue(true);
    // mockClear keeps queued *Once values: reset so one case's script never leaks into the next.
    shared.messagesCreateMock.mockReset();
    shared.checkBudgetDetailedMock.mockReset();
    shared.checkBudgetDetailedMock.mockResolvedValue(null);
    shared.reserveAiBudgetMock.mockReset();
    shared.reserveAiBudgetMock
      .mockResolvedValueOnce(RESERVED)
      .mockResolvedValueOnce({ ...RESERVED, reservationId: HOP1_RESERVATION, reservedCostCents: 40 });
  });

  it('a 529 on the reviewer model fails over to the assignment fallback; each hop is admitted, reserved and settled on its own', async () => {
    shared.resolveModelMock.mockReset();
    shared.resolveModelMock.mockResolvedValueOnce(primary()).mockResolvedValueOnce(backup());
    shared.messagesCreateMock
      .mockRejectedValueOnce(overloaded())
      .mockResolvedValueOnce({ usage: { input_tokens: 500, output_tokens: 80 }, content: [{ type: 'text', text: JSON.stringify(VALID_VERDICT) }] });
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: REVIEW_ROW_ID, reviewerKind: 'model', status: 'completed' }]);

    const result = await runScriptReview(JOB);

    expect(result).toMatchObject({ id: REVIEW_ROW_ID, status: 'completed' });
    expect(shared.resolveModelMock).toHaveBeenLastCalledWith(expect.objectContaining({
      surface: 'script_reviewer', excludeOfferingIds: ['p'], failoverCause: 'overloaded',
      failoverOrigin: { offeringId: 'p', funding: 'platform', connectionId: null },
    }));
    expect(shared.checkBudgetDetailedMock).toHaveBeenLastCalledWith(ORG_ID, 'partner_key');
    expect(shared.reserveAiBudgetMock).toHaveBeenLastCalledWith(expect.objectContaining({
      idempotencyKey: `script-review:${PROPOSAL_ID}:1:hop:1`, billingSource: 'partner_key',
      binding: turnBindingFrom(backup()),
    }));
    expect(settles().map((s) => [s.binding.offeringId, s.usage.length, s.reservationId])).toEqual([
      ['p', 0, RESERVATION_ID],
      ['k', 1, HOP1_RESERVATION],
    ]);
    // The backup's own client, and the review row names what SERVED.
    expect(shared.anthropicClientForMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ offering: { id: 'k', displayName: 'K' } }), { surface: 'script_review_verdict', orgId: ORG_ID },
    );
    expect(shared.messagesCreateMock.mock.calls[1]![0]).toMatchObject({ model: 'claude-backup-wire' });
    expect(shared.insertValues.at(-1)).toMatchObject({
      reviewerKind: 'model', status: 'completed', model: 'claude-backup-wire', budgetReservationId: HOP1_RESERVATION,
    });
  });

  it('no fallback configured: a 529 keeps W03 behaviour (one reservation, settled at zero, review failed)', async () => {
    shared.resolveModelMock.mockReset();
    shared.resolveModelMock.mockResolvedValue({ ...primary(), failoverRemaining: [] });
    shared.messagesCreateMock.mockRejectedValueOnce(overloaded());
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row', reviewerKind: 'model', status: 'failed' }]);

    const result = await runScriptReview(JOB);

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.resolveModelMock).toHaveBeenCalledTimes(1);
    expect(shared.reserveAiBudgetMock).toHaveBeenCalledTimes(1);
    expect(settles().map((s) => [s.reservationId, s.usage.length])).toEqual([[RESERVATION_ID, 0]]);
  });

  it('every configured model fails: the review fails, each hop settled exactly once, nothing settled twice', async () => {
    shared.resolveModelMock.mockReset();
    shared.resolveModelMock.mockResolvedValueOnce(primary()).mockResolvedValueOnce(backup());
    shared.messagesCreateMock.mockRejectedValueOnce(overloaded()).mockRejectedValueOnce(overloaded());
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row', reviewerKind: 'model', status: 'failed' }]);

    const result = await runScriptReview(JOB);

    expect(result).toMatchObject({ status: 'failed' });
    // hop 1 has no failoverRemaining: the original error comes back unsettled and the reviewer settles it once.
    expect(settles().map((s) => [s.binding.offeringId, s.reservationId])).toEqual([
      ['p', RESERVATION_ID],
      ['k', HOP1_RESERVATION],
    ]);
    expect(shared.insertValues.at(-1)).toMatchObject({ status: 'failed', budgetReservationId: HOP1_RESERVATION });
  });

  it('the backup hop is not admitted (out of credits): the review fails, nothing more is reserved', async () => {
    shared.resolveModelMock.mockReset();
    shared.resolveModelMock.mockResolvedValueOnce(primary()).mockResolvedValueOnce(
      makeResolvedModel('platform', { surface: 'script_reviewer', offering: { id: 'p2', displayName: 'P2' }, failover: { fromOfferingId: 'p', hop: 1, cause: 'overloaded' }, failoverRemaining: [] }),
    );
    shared.checkBudgetDetailedMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ message: 'You are out of AI credits.', reason: 'credits_exhausted', permanent: false });
    shared.messagesCreateMock.mockRejectedValueOnce(overloaded());
    queueReadsThroughModelCall();
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row', reviewerKind: 'model', status: 'failed' }]);

    const result = await runScriptReview(JOB);

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.reserveAiBudgetMock).toHaveBeenCalledTimes(1);
    expect(settles().map((s) => s.reservationId)).toEqual([RESERVATION_ID]);
    expect(shared.insertValues.at(-1)).toMatchObject({ summary: expect.stringContaining('out of AI credits') });
  });
});
