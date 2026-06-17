import { afterEach, describe, expect, it } from 'vitest';
import {
  buildClaudeSdkChildEnv,
  redactClaudeSdkStderr,
  streamingSessionManager,
} from './streamingSessionManager';

describe('Claude SDK process hardening', () => {
  afterEach(() => {
    streamingSessionManager.shutdown();
  });

  it('builds an allowlisted child environment instead of forwarding process.env wholesale', () => {
    const env = buildClaudeSdkChildEnv({
      ANTHROPIC_API_KEY: 'sk-ant-test-key',
      DATABASE_URL: 'postgres://user:password@db/breeze',
      REDIS_URL: 'redis://:secret@redis/0',
      PATH: '/usr/bin',
      HOME: '/srv/breeze',
      HTTPS_PROXY: 'http://proxy.local:8080',
    });

    expect(env).toMatchObject({
      CI: 'true',
      ANTHROPIC_API_KEY: 'sk-ant-test-key',
      PATH: '/usr/bin',
      HOME: '/srv/breeze',
      HTTPS_PROXY: 'http://proxy.local:8080',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'breeze-api/ai-agent',
    });
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('REDIS_URL');
  });

  it('forwards ANTHROPIC_BASE_URL and ANTHROPIC_MODEL on a self-hosted deployment (#1412)', () => {
    const env = buildClaudeSdkChildEnv({
      ANTHROPIC_API_KEY: 'sk-ant-test-key',
      ANTHROPIC_BASE_URL: 'http://localhost:8000',
      ANTHROPIC_MODEL: 'my-vllm-model',
      IS_HOSTED: 'false',
      PATH: '/usr/bin',
    });

    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:8000');
    expect(env.ANTHROPIC_MODEL).toBe('my-vllm-model');
  });

  it('strips ANTHROPIC_BASE_URL on the hosted platform so it cannot redirect AI traffic (#1412)', () => {
    const env = buildClaudeSdkChildEnv({
      ANTHROPIC_API_KEY: 'sk-ant-test-key',
      ANTHROPIC_BASE_URL: 'https://evil.example/v1',
      IS_HOSTED: 'true',
      PATH: '/usr/bin',
    });

    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    // The platform key is still forwarded; only the redirect vector is removed.
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');
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
