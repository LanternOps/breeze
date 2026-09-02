import { afterEach, describe, expect, it } from 'vitest';
import {
  buildClaudeSdkChildEnv,
  redactClaudeSdkStderr,
  streamingSessionManager,
} from './streamingSessionManager';

const PLATFORM_CONFIG = {
  source: 'platform' as const,
  apiKey: 'platform-resolved-key',
  model: 'claude-sonnet-4-6',
};

describe('Claude SDK process hardening', () => {
  afterEach(() => {
    streamingSessionManager.shutdown();
  });

  it('builds an allowlisted child environment instead of forwarding process.env wholesale', () => {
    const env = buildClaudeSdkChildEnv(PLATFORM_CONFIG, {
      ANTHROPIC_API_KEY: 'sk-ant-test-key',
      ANTHROPIC_AUTH_TOKEN: 'platform-auth-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'platform-oauth-token',
      DATABASE_URL: 'postgres://user:password@db/breeze',
      REDIS_URL: 'redis://:secret@redis/0',
      PATH: '/usr/bin',
      HOME: '/srv/breeze',
      HTTPS_PROXY: 'http://proxy.local:8080',
    });

    expect(env).toEqual({
      CI: 'true',
      ANTHROPIC_API_KEY: 'sk-ant-test-key',
      ANTHROPIC_AUTH_TOKEN: 'platform-auth-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'platform-oauth-token',
      PATH: '/usr/bin',
      HOME: '/srv/breeze',
      HTTPS_PROXY: 'http://proxy.local:8080',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'breeze-api/ai-agent',
    });
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('REDIS_URL');
  });

  it.each(['false', '0', 'no', 'off'])(
    'forwards ANTHROPIC_BASE_URL + ANTHROPIC_MODEL + ANTHROPIC_AUTH_TOKEN when self-host is declared (IS_HOSTED=%j) (#1412)',
    (isHosted) => {
      const env = buildClaudeSdkChildEnv(PLATFORM_CONFIG, {
        ANTHROPIC_AUTH_TOKEN: 'backend-bearer-token',
        ANTHROPIC_BASE_URL: 'http://localhost:8000',
        ANTHROPIC_MODEL: 'my-vllm-model',
        IS_HOSTED: isHosted,
        PATH: '/usr/bin',
      });

      expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:8000');
      expect(env.ANTHROPIC_MODEL).toBe('my-vllm-model');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('backend-bearer-token');
    },
  );

  // Fail-closed: the base URL is forwarded ONLY when self-host is affirmatively
  // declared. 'true'/'1' = hosted; undefined = unmapped IS_HOSTED (#570 footgun);
  // 'garbage' = unrecognized. All must strip the redirect vector.
  it.each([
    ['true', { IS_HOSTED: 'true' }],
    ['1', { IS_HOSTED: '1' }],
    ['unset', {}],
    ['garbage', { IS_HOSTED: 'garbage' }],
  ])('strips ANTHROPIC_BASE_URL when IS_HOSTED is not an affirmative self-host signal (%s) (#1412)', (_label, hostedEnv) => {
    const env = buildClaudeSdkChildEnv(PLATFORM_CONFIG, {
      ANTHROPIC_API_KEY: 'sk-ant-test-key',
      ANTHROPIC_BASE_URL: 'https://evil.example/v1',
      ANTHROPIC_MODEL: 'still-forwarded',
      ...hostedEnv,
      PATH: '/usr/bin',
    });

    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    // The platform key survives; only the redirect vector is removed.
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');
    // ANTHROPIC_MODEL is NOT a redirect vector and is forwarded regardless of
    // hosted state (it is also passed explicitly via options.model).
    expect(env.ANTHROPIC_MODEL).toBe('still-forwarded');
  });

  it('uses only the resolved Anthropic credential for a partner child process', () => {
    const env = buildClaudeSdkChildEnv(
      {
        source: 'partner',
        partnerId: '11111111-1111-4111-8111-111111111111',
        apiKey: 'partner-api-key',
        model: 'claude-sonnet-4-6',
        configId: '22222222-2222-4222-8222-222222222222',
        configVersion: 7,
        endpoint: { kind: 'anthropic' as const },
      },
      {
        ANTHROPIC_API_KEY: 'platform-api-key',
        ANTHROPIC_AUTH_TOKEN: 'platform-auth-token',
        CLAUDE_CODE_OAUTH_TOKEN: 'platform-oauth-token',
        ANTHROPIC_BASE_URL: 'http://localhost:8000',
        ANTHROPIC_MODEL: 'forwarded-model',
        IS_HOSTED: 'false',
        PATH: '/usr/bin',
        HOME: '/srv/breeze',
        HTTPS_PROXY: 'http://proxy.local:8080',
      },
    );

    expect(env).toEqual({
      CI: 'true',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'breeze-api/ai-agent',
      ANTHROPIC_API_KEY: 'partner-api-key',
      ANTHROPIC_MODEL: 'forwarded-model',
      PATH: '/usr/bin',
      HOME: '/srv/breeze',
      HTTPS_PROXY: 'http://proxy.local:8080',
    });
  });

  it('redacts SDK stderr before logging', () => {
    const redacted = redactClaudeSdkStderr('FATAL token=abc123 password=hunter2 sk-ant-secret000000000000');

    expect(redacted).toContain('FATAL');
    expect(redacted).not.toContain('abc123');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('sk-ant-secret');
    expect(redacted).toContain('[REDACTED]');
  });
});
