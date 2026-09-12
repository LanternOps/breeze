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
vi.mock('./proposals', () => ({ transitionProposal: shared.transitionProposalMock }));
vi.mock('../../config/env', () => ({ AI_SCRIPT_REVIEWER_MODEL: 'claude-sonnet-4-6' }));

import { runScriptReview, REVIEWER_PROMPT_VERSION } from './reviewer';

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
