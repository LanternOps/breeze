import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configRef = vi.hoisted(() => ({ provider: 'anthropic' as string, throws: false }));

vi.mock('../../config/validate', () => ({
  getConfig: vi.fn(() => {
    if (configRef.throws) throw new Error('getConfig() called before validateConfig()');
    return { MCP_LLM_PROVIDER: configRef.provider };
  }),
}));

import {
  isOpenAICompatibleProvider,
  isPlatformLlmConfigured,
  LlmNotConfiguredError,
  llmUnusableCode,
  PLATFORM_LLM_CREDENTIAL_ENV_KEYS,
} from './llmAvailability';

const PARTNER = {
  source: 'partner' as const,
  partnerId: '11111111-1111-4111-8111-111111111111',
  apiKey: 'partner-key',
  model: 'claude-sonnet-4-6',
  configId: '22222222-2222-4222-8222-222222222222',
  configVersion: 1,
  endpoint: { kind: 'anthropic' as const },
};

beforeEach(() => {
  configRef.provider = 'anthropic';
  configRef.throws = false;
  for (const key of PLATFORM_LLM_CREDENTIAL_ENV_KEYS) vi.stubEnv(key, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('llmUnusableCode — the one "can a model be called" decision', () => {
  it('reports a platform config with no model credential as not configured', () => {
    expect(llmUnusableCode({ source: 'platform', apiKey: undefined, model: 'claude-sonnet-4-6' })).toBe('ai_not_configured');
    expect(llmUnusableCode({ source: 'platform', apiKey: '   ', model: 'claude-sonnet-4-6' })).toBe('ai_not_configured');
  });

  it('accepts the platform API key carried on the resolved config', () => {
    expect(llmUnusableCode({ source: 'platform', apiKey: 'sk-platform', model: 'claude-sonnet-4-6' })).toBeNull();
  });

  it('accepts every credential the platform AI subprocess authenticates with', () => {
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      vi.stubEnv(key, 'token');
      expect(llmUnusableCode({ source: 'platform', apiKey: undefined, model: 'm' })).toBeNull();
      vi.stubEnv(key, '');
    }
  });

  it('accepts a platform on the OpenAI-compatible provider with no Anthropic credential', () => {
    configRef.provider = 'openai-compatible';
    expect(llmUnusableCode({ source: 'platform', apiKey: undefined, model: 'm' })).toBeNull();
  });

  it('treats a partner BYO key as usable and a broken partner config as unavailable (not "not configured")', () => {
    expect(llmUnusableCode(PARTNER)).toBeNull();
    expect(llmUnusableCode({ source: 'unavailable', partnerId: PARTNER.partnerId, reason: 'key_error' })).toBe('ai_unavailable');
  });
});

describe('isPlatformLlmConfigured', () => {
  it('reads ANTHROPIC_API_KEY from the environment when no key is passed', () => {
    expect(isPlatformLlmConfigured()).toBe(false);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-platform');
    expect(isPlatformLlmConfigured()).toBe(true);
  });

  it('fails closed to "not OpenAI-compatible" before the config is validated', () => {
    configRef.throws = true;
    expect(isOpenAICompatibleProvider()).toBe(false);
    expect(isPlatformLlmConfigured()).toBe(false);
  });
});

describe('LlmNotConfiguredError', () => {
  it('carries a stable 503 code for surfaces to render', () => {
    const error = new LlmNotConfiguredError();
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(503);
    expect(error.code).toBe('ai_not_configured');
    expect(error.message).toMatch(/not configured/i);
  });
});
