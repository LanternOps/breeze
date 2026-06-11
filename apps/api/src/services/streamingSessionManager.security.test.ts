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

  it('redacts SDK stderr before logging', () => {
    const redacted = redactClaudeSdkStderr('FATAL token=abc123 password=hunter2 sk-ant-secret000000000000');

    expect(redacted).toContain('FATAL');
    expect(redacted).not.toContain('abc123');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('sk-ant-secret');
    expect(redacted).toContain('[REDACTED]');
  });
});
