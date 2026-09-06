import { describe, it, expect, afterEach, vi } from 'vitest';

// #4329: the runTurn() background turn touches withDbAccessContext (turnCount
// increment in its `finally`) even on the stream-error path under test here.
// Same db-mock shape as aiKillState.test.ts: pass calls straight through so
// runTurn's DB write is a no-op instead of hitting a real pool.
vi.mock('../../db', () => ({
  db: {
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
  runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown> | unknown) => fn()),
}));

vi.mock('../sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('./historyBuilder', () => ({
  buildMessagesFromHistory: vi.fn(async () => []),
  ToolUseInHistoryError: class ToolUseInHistoryError extends Error {},
}));

vi.mock('../../config/validate', () => ({
  getConfig: vi.fn(() => ({ MCP_LLM_MODEL: 'test-model' })),
}));

import { OpenAISessionManager } from './openaiSessionManager';
import { captureException } from '../sentry';
import type { RequestLike } from '../auditEvents';
import type { OpenAICompatibleProvider } from './openaiCompatibleProvider';
import type { AuthContext } from '../../middleware/auth';
import type { LLMStreamEvent } from './types';

// Mirrors the canonical shim in services/clientIp.test.ts.
function makeContext(headers: Record<string, string | undefined>, remoteAddress?: string): RequestLike {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) normalized[k.toLowerCase()] = v;
  }
  return {
    req: {
      header: (name: string) => normalized[name.toLowerCase()],
    },
    ...(remoteAddress
      ? { env: { incoming: { socket: { remoteAddress } } } }
      : {}),
  } as RequestLike;
}

describe('OpenAISessionManager.getOrCreate — auditSnapshot.ip via trusted resolver (SR2-16)', () => {
  const origTrust = process.env.TRUST_PROXY_HEADERS;
  const origCidrs = process.env.TRUSTED_PROXY_CIDRS;
  let manager: OpenAISessionManager | undefined;

  afterEach(() => {
    manager?.shutdown();
    manager = undefined;
    if (origTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = origTrust;
    if (origCidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
    else process.env.TRUSTED_PROXY_CIDRS = origCidrs;
    delete process.env.TRUST_CF_CONNECTING_IP;
  });

  it('records undefined, not a spoofed x-forwarded-for, when the peer is untrusted (SR2-16)', () => {
    process.env.TRUST_PROXY_HEADERS = 'false';
    delete process.env.TRUSTED_PROXY_CIDRS;

    manager = new OpenAISessionManager({} as OpenAICompatibleProvider);
    const ctx = makeContext({ 'x-forwarded-for': '203.0.113.5' }, '198.51.100.77');
    const session = manager.getOrCreate('sess-untrusted-1', 'org-1', {} as AuthContext, ctx);

    // GUARD-BITE: RED today — the raw header read persists the spoof
    // '203.0.113.5' instead of the resolver's undefined fallback.
    expect(session.auditSnapshot.ip).not.toBe('203.0.113.5');
    expect(session.auditSnapshot.ip).toBeUndefined();
  });

  it('records the real trusted client IP when the peer is a trusted proxy (SR2-16)', () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    process.env.TRUSTED_PROXY_CIDRS = '198.51.100.77/32';
    process.env.TRUST_CF_CONNECTING_IP = 'true';

    manager = new OpenAISessionManager({} as OpenAICompatibleProvider);
    const ctx = makeContext({ 'cf-connecting-ip': '203.0.113.5' }, '198.51.100.77');
    const session = manager.getOrCreate('sess-trusted-1', 'org-1', {} as AuthContext, ctx);

    expect(session.auditSnapshot.ip).toBe('203.0.113.5');
  });

  it('records undefined ip when no requestContext is provided', () => {
    manager = new OpenAISessionManager({} as OpenAICompatibleProvider);
    const session = manager.getOrCreate('sess-no-ctx', 'org-1', {} as AuthContext, undefined);
    expect(session.auditSnapshot.ip).toBeUndefined();
  });
});

describe('OpenAISessionManager.startTurn — stream error events reach Sentry (#4329)', () => {
  let manager: OpenAISessionManager | undefined;

  afterEach(() => {
    manager?.shutdown();
    manager = undefined;
    vi.clearAllMocks();
  });

  it('calls captureException when the provider yields an error stream event, not just on a thrown exception', async () => {
    // Regression guard: before #4329's fix, only the surrounding try/catch's
    // `catch (err)` called captureException — a provider-*yielded* `error`
    // event (the guarded-fetch refusal path added by #4324, e.g. an SSRF
    // block or a non-2xx endpoint response) published to the client but never
    // reached Sentry.
    const fakeProvider = {
      chatStream: async function* (): AsyncGenerator<LLMStreamEvent> {
        yield { type: 'error', message: 'LLM endpoint error: HTTP 500: backend unavailable' };
      },
    } as unknown as OpenAICompatibleProvider;

    manager = new OpenAISessionManager(fakeProvider);
    const session = manager.getOrCreate('sess-stream-err', 'org-1', {} as AuthContext, undefined);
    manager.tryTransitionToProcessing(session);

    const events: Array<{ type: string }> = [];
    const sub = session.eventBus.subscribe('test-sub');
    const consumer = (async () => {
      for await (const e of sub) {
        events.push(e);
        if (e.type === 'done') break;
      }
    })();

    manager.startTurn(session, 'test-model', 'system prompt', 'hello');
    await consumer;

    // The client-facing behavior is unchanged — the error still publishes.
    expect(events).toContainEqual({
      type: 'error',
      message: 'LLM endpoint error: HTTP 500: backend unavailable',
    });

    // The fix: the yielded error is ALSO reported to Sentry, same as the
    // catch-block path for thrown exceptions.
    expect(captureException).toHaveBeenCalledTimes(1);
    const [reportedErr] = vi.mocked(captureException).mock.calls.at(0)!;
    expect(reportedErr).toBeInstanceOf(Error);
    expect((reportedErr as Error).message).toContain('LLM endpoint error: HTTP 500: backend unavailable');
  });
});
