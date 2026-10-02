import { afterEach, describe, expect, it } from 'vitest';
import {
  buildClaudeSdkChildEnv,
  createSdkStderrRedactor,
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

  // #7444: HOME is forwarded, and `settingSources: []` does not stop the CLI
  // from reading host-level context: auto-memory (~/.claude/projects/<key>/
  // memory/MEMORY.md) and the managed-policy CLAUDE.md. Either one would be
  // prepended to every Breeze AI request, including requests sent to a
  // partner's BYO or catalog endpoint. Every branch must pin both guards, and a
  // parent value (e.g. '0', which the CLI reads as "force on") must not win.
  describe('host Claude Code context guards (#7444)', () => {
    const PARENT_ENV = {
      ANTHROPIC_API_KEY: 'platform-api-key',
      PATH: '/usr/bin',
      HOME: '/Users/dev',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0',
    };
    const PARTNER_BASE = {
      source: 'partner' as const,
      partnerId: '11111111-1111-4111-8111-111111111111',
      apiKey: 'partner-api-key',
      model: 'claude-sonnet-4-6',
      configId: '22222222-2222-4222-8222-222222222222',
      configVersion: 7,
    };
    const PRICING = {
      catalogEntryId: '33333333-3333-4333-8333-333333333333',
      revisionId: '44444444-4444-4444-8444-444444444444',
      inputCentsPerM: 300,
      outputCentsPerM: 1500,
      cacheReadCentsPerM: 30,
      cacheWriteCentsPerM: 375,
    };

    it.each([
      ['platform', () => buildClaudeSdkChildEnv(PLATFORM_CONFIG, PARENT_ENV)],
      ['platform, self-host base URL', () => buildClaudeSdkChildEnv(PLATFORM_CONFIG, {
        ...PARENT_ENV,
        IS_HOSTED: 'false',
        ANTHROPIC_BASE_URL: 'http://localhost:8000',
      })],
      ['direct-Anthropic partner', () => buildClaudeSdkChildEnv(
        { ...PARTNER_BASE, endpoint: { kind: 'anthropic' as const } },
        PARENT_ENV,
      )],
      ['catalog partner', () => buildClaudeSdkChildEnv(
        {
          ...PARTNER_BASE,
          endpoint: {
            kind: 'catalog' as const,
            catalogEntryId: PRICING.catalogEntryId,
            revisionId: PRICING.revisionId,
            baseUrl: 'https://openrouter.ai/api/v1',
            authMode: 'x-api-key' as const,
            providerModel: 'anthropic/claude-sonnet-4-6',
            pricing: PRICING,
            models: {
              'claude-sonnet-4-6': { providerModel: 'anthropic/claude-sonnet-4-6', pricing: PRICING },
            },
          },
        },
        PARENT_ENV,
        { egressProxyUrl: 'http://127.0.0.1:40000' },
      )],
    ])('disables auto-memory and CLAUDE.md loading for a %s child', (_label, build) => {
      const env = build();
      expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
      expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    });
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
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
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
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
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

  it('redacts gateway capability URLs (the grant token in /g/<token>) from SDK stderr', () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'; // 43 base64url chars
    expect(token).toHaveLength(43);
    const redacted = redactClaudeSdkStderr(
      `API Error: connect ECONNREFUSED http://127.0.0.1:41234/g/${token}/v1/messages; retry /g/${token}`,
    );
    expect(redacted).not.toContain(token);
    expect(redacted).toContain('http://127.0.0.1:41234/g/[redacted]/v1/messages');
    expect(redacted.match(/\/g\/\[redacted\]/g)).toHaveLength(2);
    // An unrelated short path segment is left alone.
    expect(redactClaudeSdkStderr('Error at /g/short/path')).toContain('/g/short/path');
  });

  describe('SDK stderr is redacted per complete line, not per chunk', () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'; // 43 base64url chars
    const line = `API Error: connect ECONNREFUSED http://127.0.0.1:41234/g/${token}/v1/messages\n`;

    function collect(): { logged: string[]; redactor: ReturnType<typeof createSdkStderrRedactor> } {
      const logged: string[] = [];
      return { logged, redactor: createSdkStderrRedactor((text) => logged.push(text)) };
    }

    it('a grant token split across two chunks never appears in the logged output', () => {
      for (let cut = 1; cut < line.length; cut += 1) {
        const { logged, redactor } = collect();
        redactor.write(line.slice(0, cut));
        redactor.write(line.slice(cut));
        redactor.flush();
        const all = logged.join('');
        expect({ cut, leaked: all.includes(token) }).toEqual({ cut, leaked: false });
        expect(all).toContain('/g/[redacted]/v1/messages');
      }
    });

    it('a token split across chunks on an unterminated final line is redacted at flush', () => {
      const { logged, redactor } = collect();
      redactor.write(`FATAL /g/${token.slice(0, 20)}`);
      redactor.write(`${token.slice(20)} gave up`);
      expect(logged).toEqual([]);
      redactor.flush();
      expect(logged.join('')).not.toContain(token);
      expect(logged.join('')).toContain('/g/[redacted]');
    });

    it('only batches carrying an error marker are logged (with their context lines), each once', () => {
      const { logged, redactor } = collect();
      redactor.write('debug: starting\n');
      redactor.write('Error: one\n    at frame (x.js:1)\n');
      redactor.write('FATAL two\n');
      redactor.write('plain tail');
      redactor.flush();
      redactor.flush();
      const all = logged.join('\n');
      expect(all).toContain('Error: one');
      expect(all).toContain('at frame (x.js:1)');
      expect(all).toContain('FATAL two');
      expect(all).not.toContain('debug: starting');
      expect(all).not.toContain('plain tail');
      expect(all.match(/Error: one/g)).toHaveLength(1);
    });

    it('an oversized line is flushed redacted and bounded, and a token straddling the flush point still never leaks', () => {
      const { logged, redactor } = collect();
      // An Error line longer than the line cap with the token right at the cap.
      // The token starts 20 chars before the first overflow check (17000 buffered chars).
      const pad = 'x'.repeat(16_970);
      const big = `Error ${pad} /g/${token} tail\n`;
      for (let i = 0; i < big.length; i += 1000) redactor.write(big.slice(i, i + 1000));
      redactor.flush();
      const all = logged.join('');
      expect(all).not.toContain(token);
      for (const text of logged) expect(text.length).toBeLessThanOrEqual(16 * 1024 + 64);
    });
  });
});
