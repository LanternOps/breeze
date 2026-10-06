import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isPlatformLlmConfigured,
  LlmNotConfiguredError,
  PLATFORM_LLM_CREDENTIAL_ENV_KEYS,
} from './llmAvailability';

beforeEach(() => {
  for (const key of PLATFORM_LLM_CREDENTIAL_ENV_KEYS) vi.stubEnv(key, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isPlatformLlmConfigured', () => {
  it('reads ANTHROPIC_API_KEY from the environment when no key is passed', () => {
    expect(isPlatformLlmConfigured()).toBe(false);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-platform');
    expect(isPlatformLlmConfigured()).toBe(true);
  });

  it('treats a blank key as no credential and accepts a passed key', () => {
    expect(isPlatformLlmConfigured('   ')).toBe(false);
    expect(isPlatformLlmConfigured('sk-platform')).toBe(true);
  });

  it('accepts every credential the platform AI subprocess authenticates with', () => {
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      vi.stubEnv(key, 'token');
      expect(isPlatformLlmConfigured(undefined)).toBe(true);
      vi.stubEnv(key, '');
    }
  });

  it('W06: an env OpenAI-compatible deployment is not a platform credential on any transport (it is an env-managed registry connection)', () => {
    vi.stubEnv('MCP_LLM_PROVIDER', 'openai-compatible');
    vi.stubEnv('MCP_LLM_BASE_URL', 'http://10.0.0.5:8000/v1');
    for (const transport of ['chat', 'agent_sdk'] as const) {
      expect(isPlatformLlmConfigured(undefined, transport)).toBe(false);
      expect(isPlatformLlmConfigured('sk-platform', transport)).toBe(true);
    }
  });
});

describe('the legacy resolved-config check is gone (W08)', () => {
  it('llmUnusableCode is no longer exported (readiness reads the registry: aiModels/readiness.ts)', async () => {
    const mod = await import('./llmAvailability');
    expect('llmUnusableCode' in mod).toBe(false);
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
