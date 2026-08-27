import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionAiError, type ExtensionAiInvokeInput } from '@breeze/extension-sdk';

const {
  buildAnthropicClient,
  calculateCostCents,
  checkAiRateLimit,
  checkBudget,
  checkSystemAiRateLimit,
  create,
  deductBillingCredits,
  markPartnerLlmError,
  recordUsage,
  resolveLlmConfigForOrg,
} = vi.hoisted(() => ({
  buildAnthropicClient: vi.fn(),
  calculateCostCents: vi.fn<() => number>(),
  checkAiRateLimit: vi.fn<() => Promise<string | null>>(),
  checkBudget: vi.fn<() => Promise<string | null>>(),
  checkSystemAiRateLimit: vi.fn<() => Promise<string | null>>(),
  create: vi.fn(),
  deductBillingCredits: vi.fn<() => Promise<void>>(),
  markPartnerLlmError: vi.fn<() => Promise<boolean>>(),
  recordUsage: vi.fn<() => Promise<void>>(),
  resolveLlmConfigForOrg: vi.fn(),
}));

vi.mock('./aiCostTracker', () => ({
  calculateCostCents,
  checkAiRateLimit,
  checkBudget,
  checkSystemAiRateLimit,
  deductBillingCredits,
  isPricedModel: (model: string) => [
    'claude-haiku-4-5',
    'claude-sonnet-4-6',
  ].includes(model),
  recordUsage,
}));

const { LlmOrgResolutionError } = vi.hoisted(() => ({
  LlmOrgResolutionError: class LlmOrgResolutionError extends Error {
    readonly orgId: string;
    constructor(orgId: string) {
      super(`Organization ${orgId} could not be resolved for AI configuration.`);
      this.name = 'LlmOrgResolutionError';
      this.orgId = orgId;
    }
  },
}));

vi.mock('./llm/llmConfigResolver', () => ({
  buildAnthropicClient,
  markPartnerLlmError,
  resolveLlmConfigForOrg,
  LlmOrgResolutionError,
}));

import { buildExtensionAiContext } from './extensionAi';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

const PARTNER_CONFIG = {
  source: 'partner' as const,
  partnerId: PARTNER_ID,
  apiKey: 'partner-key',
  model: 'claude-sonnet-4-6',
  configId: 'config-1',
  configVersion: 3,
};

const PLATFORM_CONFIG = {
  source: 'platform' as const,
  apiKey: 'platform-key',
  model: 'claude-sonnet-4-6',
};

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
  resolveLlmConfigForOrg.mockResolvedValue(PARTNER_CONFIG);
  buildAnthropicClient.mockReturnValue({ messages: { create } });
  checkAiRateLimit.mockResolvedValue(null);
  checkSystemAiRateLimit.mockResolvedValue(null);
  checkBudget.mockResolvedValue(null);
  create.mockResolvedValue(response());
  recordUsage.mockResolvedValue(undefined);
  deductBillingCredits.mockResolvedValue(undefined);
  markPartnerLlmError.mockResolvedValue(true);
  calculateCostCents.mockReturnValue(4);
});

describe('buildExtensionAiContext', () => {
  it('meters a BYOK invocation and records partner_key usage', async () => {
    const result = await buildExtensionAiContext().invoke(input);

    expect(result).toEqual({
      text: 'workspace summary',
      model: 'claude-haiku-4-5',
      billingSource: 'partner_key',
      usage: { inputTokens: 17, outputTokens: 9 },
    });
    expect(resolveLlmConfigForOrg).toHaveBeenCalledWith(ORG_ID);
    expect(buildAnthropicClient).toHaveBeenCalledWith(PARTNER_CONFIG);
    expect(checkAiRateLimit).toHaveBeenCalledWith(USER_ID, ORG_ID);
    expect(checkBudget).toHaveBeenCalledWith(ORG_ID, 'partner_key');
    expect(create).toHaveBeenCalledWith({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      system: 'Return concise prose.',
      messages: [{ role: 'user', content: 'Summarize this workspace.' }],
    });
    expect(recordUsage).toHaveBeenCalledWith(
      null,
      ORG_ID,
      'claude-haiku-4-5',
      17,
      9,
      true,
      'partner_key',
    );
    // A partner-funded call must never touch the org's prepaid platform credits.
    expect(deductBillingCredits).not.toHaveBeenCalled();
  });

  it('does not resolve until usage recording has completed', async () => {
    // Discriminating by construction: recordUsage is held open on a deferred, so
    // `void recordUsage(...)` (accounting skipped) resolves invoke early and fails.
    let releaseRecordUsage!: () => void;
    recordUsage.mockReturnValueOnce(new Promise<void>((resolve) => {
      releaseRecordUsage = () => resolve();
    }));

    let settled = false;
    const invocation = buildExtensionAiContext().invoke(input).then((value) => {
      settled = true;
      return value;
    });

    // Drain the microtask queue well past every internal await.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(settled).toBe(false);

    releaseRecordUsage();
    await expect(invocation).resolves.toMatchObject({ billingSource: 'partner_key' });
  });

  it('attributes platform usage to the platform billing source and deducts credits', async () => {
    resolveLlmConfigForOrg.mockResolvedValueOnce(PLATFORM_CONFIG);
    calculateCostCents.mockReturnValueOnce(7);

    const result = await buildExtensionAiContext().invoke(input);

    expect(result.billingSource).toBe('platform');
    expect(recordUsage).toHaveBeenCalledWith(
      null,
      ORG_ID,
      'claude-haiku-4-5',
      17,
      9,
      true,
      'platform',
    );
    expect(calculateCostCents).toHaveBeenCalledWith('claude-haiku-4-5', 17, 9);
    expect(deductBillingCredits).toHaveBeenCalledWith(ORG_ID, 7);
  });

  it('rejects an unresolvable organization instead of billing the platform key', async () => {
    resolveLlmConfigForOrg.mockRejectedValueOnce(new LlmOrgResolutionError(ORG_ID));

    await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
      name: 'ExtensionAiError',
      code: 'ai_unavailable',
    });
    expect(create).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(deductBillingCredits).not.toHaveBeenCalled();
  });

  it('maps a broken partner BYOK config to ai_unavailable before calling the client', async () => {
    resolveLlmConfigForOrg.mockResolvedValueOnce({
      source: 'unavailable',
      partnerId: PARTNER_ID,
      reason: 'key_error',
    });

    await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
      name: 'ExtensionAiError',
      code: 'ai_unavailable',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('reports a deployment with no platform key as not_configured, not a failure', async () => {
    resolveLlmConfigForOrg.mockResolvedValueOnce({
      source: 'platform',
      apiKey: '  ',
      model: 'claude-sonnet-4-6',
    });

    await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
      name: 'ExtensionAiError',
      code: 'not_configured',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an exceeded budget before calling the client', async () => {
    checkBudget.mockResolvedValueOnce('Monthly AI budget exceeded');

    await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
      name: 'ExtensionAiError',
      code: 'budget_exceeded',
      message: 'Monthly AI budget exceeded',
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
    expect(checkBudget).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an unpriced model before resolving or enforcing limits', async () => {
    await expect(buildExtensionAiContext().invoke({
      ...input,
      model: 'not-a-real-model',
    })).rejects.toMatchObject({
      name: 'ExtensionAiError',
      code: 'ai_unavailable',
    });

    expect(resolveLlmConfigForOrg).not.toHaveBeenCalled();
    expect(checkAiRateLimit).not.toHaveBeenCalled();
    expect(checkBudget).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
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
      expect(recordUsage).not.toHaveBeenCalled();
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
      expect(markPartnerLlmError).toHaveBeenCalledWith({
        configId: 'config-1',
        configVersion: 3,
        reason: 'auth_rejected',
      });
    });

    it('does not mark a partner config when the platform key is rejected', async () => {
      resolveLlmConfigForOrg.mockResolvedValueOnce(PLATFORM_CONFIG);
      create.mockRejectedValueOnce(apiError(403, 'forbidden'));

      await expect(buildExtensionAiContext().invoke(input)).rejects.toMatchObject({
        name: 'ExtensionAiError',
        code: 'ai_unavailable',
      });
      expect(markPartnerLlmError).not.toHaveBeenCalled();
    });

    it('rethrows a permanent per-request 4xx unchanged so the caller can fail soft', async () => {
      const rejection = apiError(400, 'prompt too long');
      create.mockRejectedValueOnce(rejection);

      const error = await buildExtensionAiContext().invoke(input).catch((caught) => caught);

      expect(error).toBe(rejection);
      expect(error).not.toBeInstanceOf(ExtensionAiError);
      expect(recordUsage).not.toHaveBeenCalled();
      expect(markPartnerLlmError).not.toHaveBeenCalled();
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
});
