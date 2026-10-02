import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionAiError, type ExtensionAiInvokeInput } from '@breeze/extension-sdk';

const {
  anthropicClientFor,
  captureException,
  captureMessage,
  checkAiRateLimit,
  checkBudgetDetailed,
  checkSystemAiRateLimit,
  create,
  ensurePartnerCutover,
  findOfferingIdByModel,
  isPlatformLlmConfigured,
  markPartnerLlmError,
  markAiBudgetReservationIndeterminate,
  readOrgPartnerId,
  releaseUnusedAiBudgetReservation,
  reportPlatformKeyMissing,
  reserveAiBudget,
  resolveModel,
  settleInvocation,
} = vi.hoisted(() => ({
  anthropicClientFor: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  checkAiRateLimit: vi.fn<() => Promise<string | null>>(),
  checkBudgetDetailed: vi.fn<() => Promise<{
    message: string; reason: string; permanent: boolean;
  } | null>>(),
  checkSystemAiRateLimit: vi.fn<() => Promise<string | null>>(),
  create: vi.fn(),
  ensurePartnerCutover: vi.fn<() => Promise<boolean>>(),
  findOfferingIdByModel: vi.fn<() => Promise<string | null>>(),
  isPlatformLlmConfigured: vi.fn<() => boolean>(),
  markPartnerLlmError: vi.fn<() => Promise<boolean>>(),
  markAiBudgetReservationIndeterminate: vi.fn(),
  readOrgPartnerId: vi.fn<() => Promise<string | null>>(),
  releaseUnusedAiBudgetReservation: vi.fn(),
  reportPlatformKeyMissing: vi.fn(),
  reserveAiBudget: vi.fn(),
  resolveModel: vi.fn(),
  settleInvocation: vi.fn(),
}));

vi.mock('./aiCostTracker', () => ({
  checkAiRateLimit,
  checkBudgetDetailed,
  checkSystemAiRateLimit,
}));

vi.mock('./sentry', () => ({ captureException, captureMessage }));

vi.mock('./aiBudgetReservations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiBudgetReservations')>()),
  markAiBudgetReservationIndeterminate,
  releaseUnusedAiBudgetReservation,
  reserveAiBudget,
}));

vi.mock('./llm/llmConfigResolver', () => ({ markPartnerLlmError }));
// Partial: the SDK-child env builder (via connectionFactory) reads the real credential key list.
vi.mock('./llm/llmAvailability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./llm/llmAvailability')>()),
  isPlatformLlmConfigured,
}));
vi.mock('./llm/platformKeyAlert', () => ({ reportPlatformKeyMissing }));
vi.mock('./aiModels/resolveModel', () => ({ resolveModel }));
vi.mock('./aiModels/candidateLoader', () => ({ readOrgPartnerId, findOfferingIdByModel }));
vi.mock('./aiModels/registryCutover', () => ({ ensurePartnerCutover }));
// Real createMessage over the fake client; only the client factory is replaced.
vi.mock('./aiModels/connectionFactory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiModels/connectionFactory')>()),
  anthropicClientFor,
}));
// Real pricing (costEstimator); only settlement is mocked.
vi.mock('./aiModels/settleInvocation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiModels/settleInvocation')>()),
  settleInvocation,
}));
// W09 failover cools a failed offering down in Redis: never touched here.
vi.mock('./aiModels/offeringHealth', () => ({ noteProviderFailure: vi.fn(async () => undefined) }));

import { buildExtensionAiContext } from './extensionAi';
import { LlmUnavailableError } from './llm/llmUnavailableError';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { turnBindingFrom } from './aiModels/turnBinding';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const RESERVATION_ID = '44444444-4444-4444-8444-444444444444';
const OFFERING_ID = '77777777-7777-4777-8777-777777777777';

const byok = () => makeResolvedModel('anthropic_byok', {
  surface: 'extension_content', wireModel: 'claude-haiku-4-5', logicalModel: 'claude-haiku-4-5',
});
const platform = () => makeResolvedModel('platform', {
  surface: 'extension_content', wireModel: 'claude-haiku-4-5', logicalModel: 'claude-haiku-4-5',
});
/** Free input, 0.01 cent per output token: output tokens price as n / 100 cents. */
const outputOnlyPricing = () => makeResolvedModel('anthropic_byok', {
  surface: 'extension_content', wireModel: 'claude-haiku-4-5',
  rateSnapshot: { source: 'linked_platform', standard: { inputCentsPerM: 0, outputCentsPerM: 10_000, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 } },
});

const input: ExtensionAiInvokeInput = {
  orgId: ORG_ID,
  surface: 'workspace_enrichment',
  principal: { type: 'user', id: USER_ID },
  system: 'Return concise prose.',
  messages: [{ role: 'user', content: 'Summarize this workspace.' }],
  maxTokens: 512,
};

const systemInput: ExtensionAiInvokeInput = {
  ...input,
  principal: { type: 'system', id: null },
};

function response(text = 'workspace summary') {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text, citations: null }],
    usage: { input_tokens: 17, output_tokens: 9 },
  };
}

/** An Anthropic APIError-shaped rejection (only `status` matters here). */
function apiError(status: number, message = `HTTP ${status}`) {
  return Object.assign(new Error(message), { status });
}

beforeEach(() => {
  vi.clearAllMocks();
  readOrgPartnerId.mockResolvedValue(PARTNER_ID);
  ensurePartnerCutover.mockResolvedValue(true);
  findOfferingIdByModel.mockResolvedValue(OFFERING_ID);
  isPlatformLlmConfigured.mockReturnValue(true);
  resolveModel.mockResolvedValue(byok());
  anthropicClientFor.mockReturnValue({ messages: { create } });
  checkAiRateLimit.mockResolvedValue(null);
  checkSystemAiRateLimit.mockResolvedValue(null);
  checkBudgetDetailed.mockResolvedValue(null);
  create.mockResolvedValue(response());
  settleInvocation.mockResolvedValue({ costCents: 0, invocationIds: [], deferred: false });
  markPartnerLlmError.mockResolvedValue(true);
  reserveAiBudget.mockResolvedValue({
    kind: 'unlimited',
    reservationId: RESERVATION_ID,
    dailyPeriodKey: '2026-09-06',
    monthlyPeriodKey: '2026-09-01',
    status: 'active',
  });
  markAiBudgetReservationIndeterminate.mockResolvedValue({ kind: 'indeterminate', reservationId: RESERVATION_ID });
  releaseUnusedAiBudgetReservation.mockResolvedValue({ kind: 'released', reservationId: RESERVATION_ID });
});

describe('buildExtensionAiContext', () => {
  it('caps a finite reservation before provider dispatch', async () => {
    resolveModel.mockResolvedValue(outputOnlyPricing());
    reserveAiBudget.mockResolvedValueOnce({
      kind: 'reserved',
      reservationId: RESERVATION_ID,
      reservedCostCents: 2,
      dailyPeriodKey: '2026-09-06',
      monthlyPeriodKey: '2026-09-01',
      status: 'active',
    });

    await buildExtensionAiContext().invoke(input);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 200 }));
  });

  it('uses the extension_content assignment and returns the SERVED model', async () => {
    resolveModel.mockResolvedValue(platform());

    const out = await buildExtensionAiContext().invoke(input);

    expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({
      surface: 'extension_content', orgId: ORG_ID, partnerId: PARTNER_ID, userId: USER_ID,
    }));
    expect(resolveModel.mock.calls[0]![0]).not.toHaveProperty('requested');
    expect(out).toMatchObject({ model: 'claude-haiku-4-5', billingSource: 'platform' });
    expect(settleInvocation).toHaveBeenCalledWith(expect.objectContaining({ sourceRef: 'extension:workspace_enrichment' }));
  });

  it('settles from the bound registry rate with the funding it admitted under (BYOK: partner_key, no SDK cost field)', async () => {
    const model = byok();
    resolveModel.mockResolvedValue(model);

    const result = await buildExtensionAiContext().invoke(input);

    expect(result).toEqual({
      text: 'workspace summary',
      model: 'claude-haiku-4-5',
      billingSource: 'partner_key',
      usage: { inputTokens: 17, outputTokens: 9 },
    });
    expect(checkAiRateLimit).toHaveBeenCalledWith(USER_ID, ORG_ID);
    expect(checkBudgetDetailed).toHaveBeenCalledWith(ORG_ID, 'partner_key');
    expect(reserveAiBudget).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID, billingSource: 'partner_key', binding: turnBindingFrom(model as never),
    }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      system: 'Return concise prose.',
      messages: [{ role: 'user', content: 'Summarize this workspace.' }],
    }));
    expect(settleInvocation).toHaveBeenCalledTimes(1);
    const settled = settleInvocation.mock.calls[0]![0] as Record<string, any>;
    expect(settled).toMatchObject({
      orgId: ORG_ID, userId: USER_ID, sessionId: null, agentRunId: null,
      sourceRef: 'extension:workspace_enrichment', reservationId: RESERVATION_ID,
    });
    expect(settled).not.toHaveProperty('costUsd');
  });

  it('a system principal settles with no user', async () => {
    await buildExtensionAiContext().invoke(systemInput);
    expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));
    expect((settleInvocation.mock.calls[0]![0] as { userId: unknown }).userId).toBeNull();
  });

  it('uses the catalog wire model for dispatch and the bound revision snapshot for settlement', async () => {
    resolveModel.mockResolvedValue(makeResolvedModel('catalog', { surface: 'extension_content' }));

    await buildExtensionAiContext().invoke(input);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'anthropic/claude-sonnet-5.5' }));
    const settled = settleInvocation.mock.calls[0]![0] as { binding: { rateSnapshot: { source: string } } };
    expect(settled.binding.rateSnapshot.source).toBe('catalog');
  });

  it('a catalog partner is now served (legacy refused catalog endpoints)', async () => {
    resolveModel.mockResolvedValue(makeResolvedModel('catalog', { surface: 'extension_content' }));
    await expect(buildExtensionAiContext().invoke(input)).resolves.toMatchObject({ billingSource: 'partner_key' });
  });

  describe('explicit input.model', () => {
    it('maps to a policy-origin request for the partner offering', async () => {
      await buildExtensionAiContext().invoke({ ...input, model: 'claude-haiku-4-5' });

      expect(findOfferingIdByModel).toHaveBeenCalledWith({
        partnerId: PARTNER_ID, orgId: ORG_ID, surface: 'extension_content', modelId: 'claude-haiku-4-5',
      });
      expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({
        requested: { offeringId: OFFERING_ID, origin: 'policy' },
      }));
    });

    it('must map to a permitted offering, else permanent ai_unavailable (before limits, resolve or dispatch)', async () => {
      findOfferingIdByModel.mockResolvedValue(null);

      const error = await buildExtensionAiContext()
        .invoke({ ...input, model: 'claude-nope-1' })
        .catch((caught) => caught);

      expect(error).toMatchObject({ name: 'ExtensionAiError', code: 'ai_unavailable', permanent: true });
      expect(resolveModel).not.toHaveBeenCalled();
      expect(checkAiRateLimit).not.toHaveBeenCalled();
      expect(checkBudgetDetailed).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(settleInvocation).not.toHaveBeenCalled();
    });

    it('is a TRANSIENT ai_unavailable while the partner is not yet cut over to the registry', async () => {
      ensurePartnerCutover.mockResolvedValue(false);

      const error = await buildExtensionAiContext()
        .invoke({ ...input, model: 'claude-haiku-4-5' })
        .catch((caught) => caught);

      expect(error).toMatchObject({ code: 'ai_unavailable', permanent: false });
      expect(findOfferingIdByModel).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });
  });

  it('does not dispatch when durable admission denies the request', async () => {
    reserveAiBudget.mockResolvedValueOnce({
      kind: 'denied', reason: 'daily_budget', message: 'Daily AI budget exhausted ($1.00)',
    });

    await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
      code: 'budget_exceeded',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('retains an indeterminate reservation when provider outcome is unknown', async () => {
    create.mockRejectedValueOnce(new Error('socket reset'));

    await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
      code: 'ai_unavailable',
    });
    expect(markAiBudgetReservationIndeterminate).toHaveBeenCalledWith({
      orgId: ORG_ID,
      reservationId: RESERVATION_ID,
    });
    expect(settleInvocation).not.toHaveBeenCalled();
  });

  it('a refused attempt whose client-side fallback then throws is settled (billed) as an error, not left indeterminate', async () => {
    const base = makeResolvedModel('catalog', { surface: 'extension_content' });
    resolveModel.mockResolvedValue(makeResolvedModel('catalog', {
      surface: 'extension_content',
      refusalFallback: {
        offeringId: 'fb', displayName: 'Haiku', wireModel: 'anthropic/claude-haiku-4.5',
        wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: base.rateSnapshot,
      } as never,
    }));
    create
      .mockResolvedValueOnce({ ...response(''), model: 'anthropic/claude-sonnet-5.5', stop_reason: 'refusal', stop_details: { category: 'cyber' } })
      .mockRejectedValueOnce(apiError(503, 'overloaded'));

    await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
      name: 'ExtensionAiError', code: 'ai_unavailable', message: 'overloaded',
    });
    expect(markAiBudgetReservationIndeterminate).not.toHaveBeenCalled();
    expect(settleInvocation).toHaveBeenCalledTimes(1);
    expect(settleInvocation).toHaveBeenCalledWith(expect.objectContaining({
      reservationId: RESERVATION_ID, sourceRef: 'extension:workspace_enrichment',
      usage: [expect.objectContaining({ model: 'anthropic/claude-sonnet-5.5', tokens: expect.objectContaining({ input: 17, output: 9 }) })],
      outcome: expect.objectContaining({ stopReason: 'error' }),
    }));
  });

  it('does not resolve until settlement has completed', async () => {
    // Discriminating by construction: settleInvocation is held open on a deferred, so
    // `void settleInvocation(...)` (accounting skipped) resolves invoke early and fails.
    let releaseSettle!: () => void;
    settleInvocation.mockReturnValueOnce(new Promise((resolve) => {
      releaseSettle = () => resolve({ costCents: 0, invocationIds: [], deferred: false });
    }));

    let settled = false;
    const invocation = buildExtensionAiContext().invoke(input).then((value) => {
      settled = true;
      return value;
    });

    // Drain the microtask queue well past every internal await.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(settled).toBe(false);

    releaseSettle();
    await expect(invocation).resolves.toMatchObject({ billingSource: 'partner_key' });
  });

  it('a failed settlement marks the reservation indeterminate and throws a classified, scrubbed ExtensionAiError (review S8)', async () => {
    settleInvocation.mockRejectedValueOnce(Object.assign(new Error('Failed query: insert … params: sk-ant-secret'), { params: ['sk-ant-secret'] }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const thrown = await buildExtensionAiContext().invoke(input).catch((e: unknown) => e);
    const logged = JSON.stringify(error.mock.calls);
    error.mockRestore();

    expect(thrown).toBeInstanceOf(ExtensionAiError);
    expect(thrown).toMatchObject({ code: 'ai_unavailable', permanent: false });
    expect(String((thrown as Error).message)).not.toContain('sk-ant-secret');
    expect(markAiBudgetReservationIndeterminate).toHaveBeenCalledWith({ orgId: ORG_ID, reservationId: RESERVATION_ID });
    expect(logged).not.toContain('sk-ant-secret');
    const messages = captureException.mock.calls.map(([e]) => String((e as Error).message));
    expect(messages.some((m) => /extension AI settlement failed/.test(m))).toBe(true);
    expect(messages.join(' ')).not.toContain('sk-ant-secret');
  });

  it('an UNRECORDED settlement keeps the reservation indeterminate (review S1)', async () => {
    settleInvocation.mockResolvedValueOnce({ costCents: 1, invocationIds: [], deferred: true, unrecorded: true });
    await expect(buildExtensionAiContext().invoke(input)).resolves.toMatchObject({ text: 'workspace summary' });
    expect(markAiBudgetReservationIndeterminate).toHaveBeenCalledWith({ orgId: ORG_ID, reservationId: RESERVATION_ID });
  });

  it('a failing release cannot replace the budget_exceeded error (review S8)', async () => {
    reserveAiBudget.mockResolvedValueOnce({
      kind: 'reserved', reservedCostCents: 0, reservationId: RESERVATION_ID,
      dailyPeriodKey: '2026-09-06', monthlyPeriodKey: '2026-09-01', status: 'active',
    });
    releaseUnusedAiBudgetReservation.mockRejectedValueOnce(new Error('Failed query: update … params: x'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({ name: 'ExtensionAiError', code: 'budget_exceeded' });
    error.mockRestore();
    expect(create).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalled();
  });

  it('attributes platform usage to the platform funding (credits are drawn down by settlement)', async () => {
    resolveModel.mockResolvedValue(platform());

    const result = await buildExtensionAiContext().invoke(input);

    expect(result.billingSource).toBe('platform');
    expect(checkBudgetDetailed).toHaveBeenCalledWith(ORG_ID, 'platform');
    expect(reserveAiBudget).toHaveBeenCalledWith(expect.objectContaining({ billingSource: 'platform' }));
  });

  it('rejects an unresolvable organization instead of billing the platform key', async () => {
    readOrgPartnerId.mockResolvedValueOnce(null);

    await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
      name: 'ExtensionAiError',
      code: 'ai_unavailable',
    });
    expect(resolveModel).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(settleInvocation).not.toHaveBeenCalled();
  });

  it('maps a broken partner connection to a loud, transient ai_unavailable before calling the client', async () => {
    resolveModel.mockResolvedValueOnce({
      ok: false, reason: 'connection_unavailable', recoverable: true, offeringId: OFFERING_ID, message: 'Connection unavailable.',
    });

    const error = await buildExtensionAiContext().invoke(input).catch((caught) => caught);

    expect(error).toMatchObject({ name: 'ExtensionAiError', code: 'ai_unavailable', permanent: false });
    expect(create).not.toHaveBeenCalled();
    expect(reportPlatformKeyMissing).not.toHaveBeenCalled();
  });

  it('reports a deployment with no platform key as not_configured (permanent) and raises the platform-key alert', async () => {
    isPlatformLlmConfigured.mockReturnValue(false);
    resolveModel.mockResolvedValueOnce({
      ok: false, reason: 'connection_unavailable', recoverable: true, offeringId: null, message: 'Connection unavailable.',
    });

    const error = await buildExtensionAiContext().invoke(input).catch((caught) => caught);

    expect(error).toMatchObject({ name: 'ExtensionAiError', code: 'not_configured', permanent: true });
    expect(reportPlatformKeyMissing).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['not_permitted', true],
    ['model_unavailable', true],
    ['unpriced', true],
    ['registry_unavailable', false],
  ] as const)('maps an unresolved %s to ai_unavailable (permanent: %s)', async (reason, permanent) => {
    resolveModel.mockResolvedValueOnce({ ok: false, reason, recoverable: true, offeringId: null, message: 'nope' });

    const error = await buildExtensionAiContext().invoke(input).catch((caught) => caught);

    expect(error).toMatchObject({ code: 'ai_unavailable', permanent, message: 'nope' });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an exceeded budget before calling the client', async () => {
    checkBudgetDetailed.mockResolvedValueOnce({
      message: 'Monthly AI budget exceeded',
      reason: 'monthly_budget',
      permanent: false,
    });

    await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
      name: 'ExtensionAiError',
      code: 'budget_exceeded',
      message: 'Monthly AI budget exceeded',
      // A spend cap rolls over — the caller may retry after the period key does.
      permanent: false,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a rate-limited invocation before checking budget or calling the client', async () => {
    checkAiRateLimit.mockResolvedValueOnce('Rate limit exceeded');

    await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
      name: 'ExtensionAiError',
      code: 'rate_limited',
      message: 'Rate limit exceeded',
    });
    expect(checkBudgetDetailed).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('concatenates all text blocks in order and skips non-text blocks', async () => {
    create.mockResolvedValueOnce({
      ...response(),
      content: [
        { type: 'text', text: 'foo', citations: null },
        { type: 'tool_use', id: 'tool-1', name: 'ignored', input: {} },
        { type: 'text', text: 'bar', citations: null },
      ],
    });

    const result = await buildExtensionAiContext().invoke(input);

    expect(result.text).toBe('foobar');
  });

  describe('provider failure classification', () => {
    it('treats a 429 as a provider-level ExtensionAiError', async () => {
      create.mockRejectedValueOnce(apiError(429, 'slow down'));

      await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
        name: 'ExtensionAiError',
        code: 'rate_limited',
      });
      expect(settleInvocation).not.toHaveBeenCalled();
      expect(markPartnerLlmError).not.toHaveBeenCalled();
    });

    it('treats a 500 as a provider-level ExtensionAiError', async () => {
      create.mockRejectedValueOnce(apiError(503, 'overloaded'));

      await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
        name: 'ExtensionAiError',
        code: 'ai_unavailable',
      });
      expect(markPartnerLlmError).not.toHaveBeenCalled();
    });

    it('treats a network error (no status) as a provider-level ExtensionAiError', async () => {
      create.mockRejectedValueOnce(new Error('socket hang up'));

      await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
        name: 'ExtensionAiError',
        code: 'ai_unavailable',
        message: 'socket hang up',
      });
    });

    it('records a rejected partner credential and raises ai_unavailable on 401', async () => {
      create.mockRejectedValueOnce(apiError(401, 'invalid x-api-key'));

      await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
        name: 'ExtensionAiError',
        code: 'ai_unavailable',
      });
      // The config identity comes from the resolved connection (conn-1 / v2 in the fixture).
      expect(markPartnerLlmError).toHaveBeenCalledWith({
        configId: 'conn-1',
        configVersion: 2,
        reason: 'auth_rejected',
      });
    });

    it('does not mark a partner config when the platform key is rejected', async () => {
      resolveModel.mockResolvedValueOnce(platform());
      create.mockRejectedValueOnce(apiError(403, 'forbidden'));

      await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
        name: 'ExtensionAiError',
        code: 'ai_unavailable',
      });
      expect(markPartnerLlmError).not.toHaveBeenCalled();
    });

    it('W06: a gateway 401 (expired or invalid grant) raises ai_unavailable and NEVER marks the connection broken', async () => {
      resolveModel.mockResolvedValueOnce(makeResolvedModel('openai_compatible', { surface: 'extension_content' }));
      create.mockRejectedValueOnce(apiError(401, 'Invalid or expired gateway grant.'));

      await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
        name: 'ExtensionAiError',
        code: 'ai_unavailable',
      });
      expect(markPartnerLlmError).not.toHaveBeenCalled();
    });

    it('W06: a gateway 403 (model not bound to the grant) raises ai_unavailable without a stamp', async () => {
      resolveModel.mockResolvedValueOnce(makeResolvedModel('openai_compatible', { surface: 'extension_content' }));
      create.mockRejectedValueOnce(apiError(403, 'This connection is not authorised for the requested model.'));

      await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
        name: 'ExtensionAiError',
        code: 'ai_unavailable',
      });
      expect(markPartnerLlmError).not.toHaveBeenCalled();
    });

    it('W06: a gateway connection is dispatched and settled like any other partner_key connection', async () => {
      resolveModel.mockResolvedValueOnce(makeResolvedModel('openai_compatible', { surface: 'extension_content' }));

      const result = await buildExtensionAiContext().invoke(input);

      expect(result.billingSource).toBe('partner_key');
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'qwen2.5-coder:7b' }));
      expect(settleInvocation).toHaveBeenCalledWith(expect.objectContaining({ reservationId: RESERVATION_ID }));
    });

    it('a client that cannot be built is refused BEFORE any reservation is taken (no leaked hold)', async () => {
      anthropicClientFor.mockImplementationOnce(() => {
        throw new LlmUnavailableError('This AI model needs an organization context on this surface.');
      });

      await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
        name: 'ExtensionAiError',
        code: 'ai_unavailable',
      });
      expect(reserveAiBudget).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it('rethrows a permanent per-request 4xx unchanged so the caller can fail soft', async () => {
      const rejection = apiError(400, 'prompt too long');
      create.mockRejectedValueOnce(rejection);

      const error = await buildExtensionAiContext().invoke(input).catch((caught) => caught);

      expect(error).toBe(rejection);
      expect(error).not.toBeInstanceOf(ExtensionAiError);
      expect(settleInvocation).not.toHaveBeenCalled();
      expect(markPartnerLlmError).not.toHaveBeenCalled();
    });
  });

  /**
   * PERMANENT vs TRANSIENT.
   *
   * The `code` alone never answered "can retrying help?", and the workspace
   * ingest job treated every ExtensionAiError as retryable. A requested model
   * the partner has not enabled, or a tenant who simply switched AI off,
   * therefore burned all `max_attempts`, failed the job, and had a fresh job
   * repeat it forever — crosswalk never ran. Each of these pins which side of
   * that line one failure falls on.
   */
  describe('permanent-vs-transient classification', () => {
    it('propagates a PERMANENT budget denial (org has AI switched off)', async () => {
      checkBudgetDetailed.mockResolvedValueOnce({
        message: 'AI features are disabled for this organization',
        reason: 'ai_disabled',
        permanent: true,
      });

      const error = await buildExtensionAiContext().invoke(input).catch((caught) => caught);

      expect(error).toMatchObject({ code: 'budget_exceeded', permanent: true });
      expect(create).not.toHaveBeenCalled();
    });

    it('propagates a PERMANENT budget denial (partner plan has no AI)', async () => {
      checkBudgetDetailed.mockResolvedValueOnce({
        message: 'AI assistant requires the Community plan.',
        reason: 'plan_gate',
        permanent: true,
      });

      const error = await buildExtensionAiContext().invoke(input).catch((caught) => caught);

      expect(error).toMatchObject({ code: 'budget_exceeded', permanent: true });
    });

    it('propagates a TRANSIENT budget denial (exhausted prepaid credits)', async () => {
      checkBudgetDetailed.mockResolvedValueOnce({
        message: 'You are out of AI credits. Purchase more credits to continue.',
        reason: 'credits_exhausted',
        permanent: false,
      });

      const error = await buildExtensionAiContext().invoke(input).catch((caught) => caught);

      expect(error).toMatchObject({ code: 'budget_exceeded', permanent: false });
    });

    it('keeps rate_limited TRANSIENT', async () => {
      checkAiRateLimit.mockResolvedValueOnce('Rate limit exceeded');

      const error = await buildExtensionAiContext().invoke(input).catch((caught) => caught);

      expect(error).toMatchObject({ code: 'rate_limited', permanent: false });
    });

    it.each([429, 503])('keeps a provider-side %i TRANSIENT', async (status) => {
      create.mockRejectedValueOnce(apiError(status));

      const error = await buildExtensionAiContext().invoke(input).catch((caught) => caught);

      expect(error).toMatchObject({ permanent: false });
    });

    it('keeps an unresolvable organization TRANSIENT', async () => {
      // A missing/unreadable organization row can be an RLS-context fault, not
      // a settled configuration state — degrading a feature over it would hide
      // a real bug.
      readOrgPartnerId.mockResolvedValueOnce(null);

      const error = await buildExtensionAiContext().invoke(input).catch((caught) => caught);

      expect(error).toMatchObject({ code: 'ai_unavailable', permanent: false });
    });
  });

  describe('partner credential rejection stamping', () => {
    it('reports a stamping THROW to Sentry without masking the original 401', async () => {
      create.mockRejectedValueOnce(apiError(401, 'invalid x-api-key'));
      markPartnerLlmError.mockRejectedValueOnce(new Error('db down'));

      await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
        name: 'ExtensionAiError',
        code: 'ai_unavailable',
        message: 'invalid x-api-key',
      });
      expect(captureException).toHaveBeenCalled();
    });

    it('reports a LOST stamp (config version moved) instead of treating it as stamped', async () => {
      // markPartnerLlmError resolves false when the row id/version no longer
      // match — the partner rotated the key mid-flight. Nothing was written, so
      // their AI settings still advertise a key Anthropic is rejecting.
      create.mockRejectedValueOnce(apiError(401, 'invalid x-api-key'));
      markPartnerLlmError.mockResolvedValueOnce(false);

      await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
        code: 'ai_unavailable',
      });
      expect(captureMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ eventCode: 'ai_partner_key_error_stamp_stale' }),
      );
    });

    it('says nothing when the stamp lands', async () => {
      create.mockRejectedValueOnce(apiError(401, 'invalid x-api-key'));
      markPartnerLlmError.mockResolvedValueOnce(true);

      await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
        code: 'ai_unavailable',
      });
      expect(captureMessage).not.toHaveBeenCalled();
      expect(captureException).not.toHaveBeenCalled();
    });
  });

  describe('rate-limit actor', () => {
    it('uses the org-scoped system limiter for non-user principals', async () => {
      await buildExtensionAiContext().invoke(systemInput);

      expect(checkSystemAiRateLimit).toHaveBeenCalledWith(ORG_ID);
      // The per-user bucket is deployment-global for a synthetic actor id: using
      // it would couple every tenant's automation to one 20/min ceiling.
      expect(checkAiRateLimit).not.toHaveBeenCalled();
    });

    it('surfaces a system rate-limit rejection as rate_limited', async () => {
      checkSystemAiRateLimit.mockResolvedValueOnce('Organization rate limit exceeded');

      await expect(buildExtensionAiContext().invoke(systemInput)).rejects.toMatchObject({
        name: 'ExtensionAiError',
        code: 'rate_limited',
      });
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('W09 failover (#7607)', () => {
    const HOP0_RESERVATION = '55555555-5555-4555-8555-555555555555';
    const HOP1_RESERVATION = '66666666-6666-4666-8666-666666666666';
    const reserved = (reservationId: string, reservedCostCents: number) => ({
      kind: 'reserved', reservationId, reservedCostCents,
      dailyPeriodKey: '2026-09-06', monthlyPeriodKey: '2026-09-01', status: 'active',
    });
    const overloaded = () => Object.assign(new Error('Overloaded'), {
      status: 529, error: { type: 'error', error: { type: 'overloaded_error' } },
    });
    // Free input, 0.01 cent per output token: max_tokens = reservedCostCents * 100.
    const rates = { source: 'linked_platform' as const, standard: { inputCentsPerM: 0, outputCentsPerM: 10_000, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 } };
    const primary = () => makeResolvedModel('anthropic_byok', {
      surface: 'extension_content', offering: { id: 'p', displayName: 'P' }, wireModel: 'claude-sonnet-5-5',
      rateSnapshot: rates, failoverRemaining: ['k'],
    });
    const backup = () => makeResolvedModel('platform', {
      surface: 'extension_content', offering: { id: 'k', displayName: 'K' }, wireModel: 'claude-haiku-4-5',
      rateSnapshot: { ...rates, source: 'platform' }, failover: { fromOfferingId: 'p', hop: 1, cause: 'overloaded' }, failoverRemaining: [],
    });
    const settledRows = () => settleInvocation.mock.calls.map((c) => {
      const arg = c[0] as { binding: { offeringId: string }; usage: unknown[]; reservationId: string };
      return [arg.binding.offeringId, arg.reservationId, arg.usage.length];
    });
    let warnSpy: { mockRestore: () => void };

    beforeEach(() => {
      // clearAllMocks keeps queued *Once values: reset what these cases script.
      resolveModel.mockReset();
      reserveAiBudget.mockReset();
      create.mockReset();
      checkBudgetDetailed.mockReset();
      checkBudgetDetailed.mockResolvedValue(null);
      resolveModel.mockResolvedValueOnce(primary()).mockResolvedValueOnce(backup());
      reserveAiBudget
        .mockResolvedValueOnce(reserved(HOP0_RESERVATION, 4))
        .mockResolvedValueOnce(reserved(HOP1_RESERVATION, 2));
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => warnSpy.mockRestore());

    it('a 529 fails over; each hop is reserved, sized and settled on its own, and the SERVED hop is reported', async () => {
      create.mockRejectedValueOnce(overloaded()).mockResolvedValueOnce(response());

      const out = await buildExtensionAiContext().invoke(input);

      expect(resolveModel).toHaveBeenLastCalledWith(expect.objectContaining({
        partnerId: PARTNER_ID, orgId: ORG_ID, userId: USER_ID, surface: 'extension_content', maxTokens: 512,
        excludeOfferingIds: ['p'], failoverCause: 'overloaded',
        failoverOrigin: { offeringId: 'p', funding: 'partner_key', connectionId: 'conn-1' },
      }));
      expect(checkBudgetDetailed).toHaveBeenLastCalledWith(ORG_ID, 'platform');
      const keys = reserveAiBudget.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(/^extension-ai:/);
      expect(keys[1]).toBe(`${keys[0]}:hop:1`);
      // Each hop's max_tokens comes from ITS OWN reservation (4¢ → 400, 2¢ → 200).
      expect(create.mock.calls.map((c) => [(c[0] as { model: string }).model, (c[0] as { max_tokens: number }).max_tokens]))
        .toEqual([['claude-sonnet-5-5', 400], ['claude-haiku-4-5', 200]]);
      expect(settledRows()).toEqual([['p', HOP0_RESERVATION, 0], ['k', HOP1_RESERVATION, 1]]);
      expect(settleInvocation.mock.calls.every(([arg]) => (arg as { sourceRef: string }).sourceRef === 'extension:workspace_enrichment')).toBe(true);
      expect(out).toMatchObject({ model: 'claude-haiku-4-5', billingSource: 'platform' });
      expect(markAiBudgetReservationIndeterminate).not.toHaveBeenCalled();
    });

    it('a refusal answered before its fallback threw never fails over (burned tokens bill on hop 0)', async () => {
      resolveModel.mockReset();
      const base = makeResolvedModel('catalog', { surface: 'extension_content' });
      resolveModel.mockResolvedValueOnce(makeResolvedModel('catalog', {
        surface: 'extension_content', offering: { id: 'p', displayName: 'P' }, failoverRemaining: ['k'],
        refusalFallback: {
          offeringId: 'fb', displayName: 'Haiku', wireModel: 'anthropic/claude-haiku-4.5',
          wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: base.rateSnapshot,
        } as never,
      })).mockResolvedValueOnce(backup());
      create
        .mockResolvedValueOnce({ ...response(''), model: 'anthropic/claude-sonnet-5.5', stop_reason: 'refusal', stop_details: { category: 'cyber' } })
        .mockRejectedValueOnce(overloaded());

      await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({ name: 'ExtensionAiError' });
      expect(resolveModel).toHaveBeenCalledTimes(1);
      expect(reserveAiBudget).toHaveBeenCalledTimes(1);
      expect(settledRows()).toEqual([['p', HOP0_RESERVATION, 1]]);
    });

    it('with no fallback list configured, a 529 keeps the W03 single-reservation behaviour', async () => {
      resolveModel.mockReset();
      resolveModel.mockResolvedValue(byok());
      create.mockRejectedValueOnce(overloaded());

      await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({ name: 'ExtensionAiError', code: 'ai_unavailable' });
      expect(resolveModel).toHaveBeenCalledTimes(1);
      expect(reserveAiBudget).toHaveBeenCalledTimes(1);
      expect(settleInvocation).not.toHaveBeenCalled();
      expect(markAiBudgetReservationIndeterminate).toHaveBeenCalledWith({ orgId: ORG_ID, reservationId: HOP0_RESERVATION });
    });

    it('a backup refused at admission throws a transient ai_unavailable with hop 0 already settled and nothing held', async () => {
      create.mockRejectedValueOnce(overloaded());
      checkBudgetDetailed
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ message: 'You are out of AI credits.', reason: 'credits_exhausted', permanent: false });

      await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
        name: 'ExtensionAiError', code: 'ai_unavailable', permanent: false,
      });
      expect(reserveAiBudget).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(settledRows()).toEqual([['p', HOP0_RESERVATION, 0]]);
      expect(markAiBudgetReservationIndeterminate).not.toHaveBeenCalled();
      expect(releaseUnusedAiBudgetReservation).not.toHaveBeenCalled();
    });

    it('a rejected partner credential is still stamped when the backup serves', async () => {
      create.mockRejectedValueOnce(apiError(401, 'invalid x-api-key')).mockResolvedValueOnce(response());

      const out = await buildExtensionAiContext().invoke(input);

      expect(out).toMatchObject({ billingSource: 'platform' });
      expect(markPartnerLlmError).toHaveBeenCalledWith({ configId: 'conn-1', configVersion: 2, reason: 'auth_rejected' });
      expect(settledRows()).toEqual([['p', HOP0_RESERVATION, 0], ['k', HOP1_RESERVATION, 1]]);
    });
  });
});
