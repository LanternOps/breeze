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
  recordUsageMock: vi.fn(async () => undefined),
  getLlmBillingSourceForOrgMock: vi.fn(async () => 'platform' as const),
  getAnthropicClientForPartnerMock: vi.fn(),
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
}));
vi.mock('../aiCostTracker', () => ({ recordUsage: shared.recordUsageMock }));
vi.mock('../llm/llmConfigResolver', () => ({
  getLlmBillingSourceForOrg: shared.getLlmBillingSourceForOrgMock,
  getAnthropicClientForPartner: shared.getAnthropicClientForPartnerMock,
  resolveWireModel: vi.fn((_resolved: unknown, model: string) => ({ model })),
}));
vi.mock('../auditService', () => ({ createAuditLogAsync: shared.createAuditLogAsyncMock }));
vi.mock('../sentry', () => ({ captureException: shared.captureExceptionMock }));
vi.mock('./proposals', () => ({ transitionProposal: shared.transitionProposalMock }));
vi.mock('../../config/env', () => ({ AI_SCRIPT_REVIEWER_MODEL: 'claude-sonnet-4-6' }));

import { APIUserAbortError } from '@anthropic-ai/sdk';
import { ProposalNotReviewableError, runScriptReview, REVIEWER_PROMPT_VERSION } from './reviewer';

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
 *  static-scan row (none), org partner id, device facts. */
function queueReadsThroughModelCall(proposal: Record<string, unknown> = PROPOSAL_ROW, deviceRows: unknown[] = []) {
  shared.selectQueue.push([proposal]);
  shared.selectQueue.push([]); // no existing static_scan row
  shared.selectQueue.push([{ partnerId: PARTNER_ID }]);
  shared.selectQueue.push(deviceRows);
}

describe('runScriptReview — happy path', () => {
  beforeEach(() => {
    resetDbState();
    vi.clearAllMocks();
    shared.reserveAiBudgetMock.mockResolvedValue(RESERVED);
    shared.transitionProposalMock.mockResolvedValue(true);
    shared.getAnthropicClientForPartnerMock.mockImplementation(async () => ({
      client: { messages: { create: shared.messagesCreateMock } },
      resolved: { source: 'platform' },
    }));
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
      expect.objectContaining({ orgId: ORG_ID, idempotencyKey: `script-review:${PROPOSAL_ID}:1`, billingSource: 'platform' }),
    );
    expect(shared.reserveAiBudgetMock.mock.invocationCallOrder[0]!).toBeLessThan(
      shared.messagesCreateMock.mock.invocationCallOrder[0]!,
    );

    // BYOK + egress-audit parity: through the partner client, under the new surface.
    expect(shared.getAnthropicClientForPartnerMock).toHaveBeenCalledWith(
      PARTNER_ID, { surface: 'script_review_verdict', orgId: ORG_ID },
    );

    // The model call: capped output, no tools, a system + single user turn,
    // content delimited, device facts present, nothing session-shaped.
    expect(shared.messagesCreateMock).toHaveBeenCalledTimes(1);
    const [createArgs, createOpts] = shared.messagesCreateMock.mock.calls[0]! as [Record<string, unknown>, Record<string, unknown>];
    expect(createArgs).toMatchObject({ model: 'claude-sonnet-4-6', max_tokens: 2_000 });
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
      model: 'claude-sonnet-4-6', reviewerPromptVersion: REVIEWER_PROMPT_VERSION,
      riskTier: 'low', goalMatch: 'yes', recommendedAction: 'approve',
      inputTokens: 500, outputTokens: 80, budgetReservationId: RESERVATION_ID,
    });

    expect(shared.transitionProposalMock).toHaveBeenCalledWith(
      expect.anything(), PROPOSAL_ID, ['proposed'], 'reviewed', expect.objectContaining({ riskTier: 'low' }),
    );
    // Settled exactly once, at the real token counts, against the reservation.
    expect(shared.recordUsageMock).toHaveBeenCalledTimes(1);
    expect(shared.recordUsageMock).toHaveBeenCalledWith(
      null, ORG_ID, 'claude-sonnet-4-6', 500, 80, false, 'platform', undefined, RESERVATION_ID,
    );
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

    expect(shared.recordUsageMock).toHaveBeenCalledWith(
      null, ORG_ID, 'claude-sonnet-4-6', 500, 80, false, 'platform', undefined, RESERVATION_ID,
    );
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
    shared.selectQueue.push([{ partnerId: PARTNER_ID }]);
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
    shared.getAnthropicClientForPartnerMock.mockImplementation(async () => ({
      client: { messages: { create: shared.messagesCreateMock } },
      resolved: { source: 'platform' },
    }));
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
    expect(shared.getAnthropicClientForPartnerMock).not.toHaveBeenCalled();
    expect(shared.messagesCreateMock).not.toHaveBeenCalled();
    expect(shared.recordUsageMock).not.toHaveBeenCalled();
    expect(shared.insertValues.at(-1)).toMatchObject({ budgetReservationId: null, model: null, summary: expect.stringContaining('daily_budget') });
    expectFailedClosed('failed');
  });

  it('provider client unavailable ⇒ review_failed, reservation settled at zero', async () => {
    queueReadsThroughModelCall();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.getAnthropicClientForPartnerMock.mockRejectedValueOnce(new Error('egress blocked'));
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-2', reviewerKind: 'model', status: 'failed' }]);

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.messagesCreateMock).not.toHaveBeenCalled();
    expect(shared.recordUsageMock).toHaveBeenCalledTimes(1);
    expect(shared.recordUsageMock).toHaveBeenCalledWith(null, ORG_ID, 'claude-sonnet-4-6', 0, 0, false, 'platform', undefined, RESERVATION_ID);
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
    expect(shared.recordUsageMock).toHaveBeenCalledTimes(1);
    expect(shared.recordUsageMock).toHaveBeenCalledWith(null, ORG_ID, 'claude-sonnet-4-6', 0, 0, false, 'platform', undefined, RESERVATION_ID);
    expect(shared.insertValues.at(-1)).toMatchObject({ budgetReservationId: RESERVATION_ID, model: 'claude-sonnet-4-6' });
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
    expect(shared.recordUsageMock).toHaveBeenCalledWith(null, ORG_ID, 'claude-sonnet-4-6', 0, 0, false, 'platform', undefined, RESERVATION_ID);
    expectFailedClosed('timeout');
  });

  it('malformed JSON ⇒ review_failed, reservation settled at the REAL (nonzero) token counts already spent', async () => {
    queueReadsThroughModelCall();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-5', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce({ usage: { input_tokens: 300, output_tokens: 40 }, content: [{ type: 'text', text: 'not json at all' }] });

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.recordUsageMock).toHaveBeenCalledTimes(1);
    expect(shared.recordUsageMock).toHaveBeenCalledWith(null, ORG_ID, 'claude-sonnet-4-6', 300, 40, false, 'platform', undefined, RESERVATION_ID);
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
  });

  it('no text block at all (e.g. max_tokens hit mid-thought) ⇒ review_failed', async () => {
    queueReadsThroughModelCall();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-7', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce({ usage: { input_tokens: 300, output_tokens: 2000 }, content: [] });

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.recordUsageMock).toHaveBeenCalledWith(null, ORG_ID, 'claude-sonnet-4-6', 300, 2000, false, 'platform', undefined, RESERVATION_ID);
    expectFailedClosed('failed');
  });

  it('idempotent under retry: a proposal already past "proposed" short-circuits with no second model call or reservation', async () => {
    shared.selectQueue.push([{ ...PROPOSAL_ROW, status: 'reviewed' }]);
    shared.selectQueue.push([{ id: REVIEW_ROW_ID, reviewerKind: 'model', status: 'completed', riskTier: 'low' }]);

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ id: REVIEW_ROW_ID });
    expect(shared.reserveAiBudgetMock).not.toHaveBeenCalled();
    expect(shared.messagesCreateMock).not.toHaveBeenCalled();
    expect(shared.recordUsageMock).not.toHaveBeenCalled();
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
    expect(shared.recordUsageMock).toHaveBeenCalledTimes(1);
    expect(shared.recordUsageMock).toHaveBeenCalledWith(null, ORG_ID, 'claude-sonnet-4-6', 500, 80, false, 'platform', undefined, RESERVATION_ID);
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
    shared.getAnthropicClientForPartnerMock.mockImplementation(async () => ({
      client: { messages: { create: shared.messagesCreateMock } },
      resolved: { source: 'platform' },
    }));
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
    expect(shared.recordUsageMock).toHaveBeenCalledTimes(1);
    expect(shared.createAuditLogAsyncMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'script.proposal.review_failed' }),
    );
  });

  it('an org that vanished after the reservation (partner-id read throws) fails closed and settles at zero', async () => {
    shared.selectQueue.push([PROPOSAL_ROW]);
    shared.selectQueue.push([]); // no static_scan row
    // readOrgPartnerId: no org row ⇒ throws inside the system context.
    shared.selectQueue.push([]);
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-org', reviewerKind: 'model', status: 'failed' }]);

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.getAnthropicClientForPartnerMock).not.toHaveBeenCalled();
    expect(shared.recordUsageMock).toHaveBeenCalledTimes(1);
    expect(shared.recordUsageMock).toHaveBeenCalledWith(null, ORG_ID, 'claude-sonnet-4-6', 0, 0, false, 'platform', undefined, RESERVATION_ID);
    expect(shared.transitionProposalMock).toHaveBeenCalledWith(expect.anything(), PROPOSAL_ID, ['proposed'], 'review_failed', expect.anything());
    expect(shared.insertValues.at(-1)).toMatchObject({ summary: expect.stringContaining('Review inputs unavailable') });
  });

  it('a device-facts query error after the reservation fails closed and settles at zero', async () => {
    shared.selectQueue.push([PROPOSAL_ROW]);
    shared.selectQueue.push([]);
    shared.selectQueue.push([{ partnerId: PARTNER_ID }]);
    // loadDeviceFacts: nothing queued ⇒ the mock throws "no queued select rows".
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-dev', reviewerKind: 'model', status: 'failed' }]);

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed' });
    expect(shared.messagesCreateMock).not.toHaveBeenCalled();
    expect(shared.recordUsageMock).toHaveBeenCalledWith(null, ORG_ID, 'claude-sonnet-4-6', 0, 0, false, 'platform', undefined, RESERVATION_ID);
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
    shared.recordUsageMock.mockRejectedValueOnce(new Error('ledger write failed'));

    const result = await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(result).toMatchObject({ id: REVIEW_ROW_ID, status: 'completed' });
    expect(shared.captureExceptionMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'ledger write failed' }), undefined, expect.objectContaining({ service: 'scriptReview' }));
    expect(shared.createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'script.proposal.reviewed' }));
  });

  it('an unparseable verdict keeps the raw model text on the failure row for diagnosis, and reaches Sentry', async () => {
    queueReadsThroughModelCall();
    shared.reserveAiBudgetMock.mockResolvedValueOnce(RESERVED);
    shared.insertReturningQueue.push([{ id: 'static-scan-row' }]);
    shared.insertReturningQueue.push([{ id: 'fail-row-raw', reviewerKind: 'model', status: 'failed' }]);
    shared.messagesCreateMock.mockResolvedValueOnce({ usage: { input_tokens: 300, output_tokens: 40 }, content: [{ type: 'text', text: 'Sure! Here is my review in prose…' }] });

    await runScriptReview({ proposalId: PROPOSAL_ID, orgId: ORG_ID, attempt: 1 });

    expect(shared.insertValues.at(-1)).toMatchObject({ verdict: { rawText: 'Sure! Here is my review in prose…' } });
    expect(shared.captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ service: 'scriptReview', reviewStatus: 'failed' }));
  });
});
