import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Redis so module load doesn't reach out to a real instance.
vi.mock('./redis', () => ({
  getRedis: () => null,
}));

describe('shouldUseRedis', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOverride = process.env.WS_TICKETS_REQUIRE_REDIS;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.NODE_ENV;
    delete process.env.WS_TICKETS_REQUIRE_REDIS;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalOverride === undefined) delete process.env.WS_TICKETS_REQUIRE_REDIS;
    else process.env.WS_TICKETS_REQUIRE_REDIS = originalOverride;
  });

  async function loadShouldUseRedis(): Promise<() => boolean> {
    const mod = await import('./remoteSessionAuth');
    return mod.shouldUseRedis;
  }

  it('returns false in NODE_ENV=development (no override)', async () => {
    process.env.NODE_ENV = 'development';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(false);
  });

  it('returns false in NODE_ENV=test (no override)', async () => {
    process.env.NODE_ENV = 'test';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(false);
  });

  it('returns true in NODE_ENV=staging (no override)', async () => {
    process.env.NODE_ENV = 'staging';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(true);
  });

  it('returns true in NODE_ENV=production (no override)', async () => {
    process.env.NODE_ENV = 'production';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(true);
  });

  it('WS_TICKETS_REQUIRE_REDIS=true forces true even in development', async () => {
    process.env.NODE_ENV = 'development';
    process.env.WS_TICKETS_REQUIRE_REDIS = 'true';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(true);
  });

  it('WS_TICKETS_REQUIRE_REDIS=1 forces true even in development', async () => {
    process.env.NODE_ENV = 'development';
    process.env.WS_TICKETS_REQUIRE_REDIS = '1';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(true);
  });

  it('WS_TICKETS_REQUIRE_REDIS=false forces false even in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_TICKETS_REQUIRE_REDIS = 'false';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(false);
  });

  it('WS_TICKETS_REQUIRE_REDIS=0 forces false even in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_TICKETS_REQUIRE_REDIS = '0';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(false);
  });

  it('unrecognized override value falls back to NODE_ENV-based default', async () => {
    process.env.NODE_ENV = 'staging';
    process.env.WS_TICKETS_REQUIRE_REDIS = 'yes';
    const shouldUseRedis = await loadShouldUseRedis();
    expect(shouldUseRedis()).toBe(true);
  });
});

describe('WS ticket caller binding (IP + UA)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBindIp = process.env.WS_TICKET_BIND_IP;

  beforeEach(() => {
    vi.resetModules();
    // Force in-memory backend so tests don't need Redis.
    process.env.NODE_ENV = 'test';
    delete process.env.WS_TICKET_BIND_IP;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalBindIp === undefined) delete process.env.WS_TICKET_BIND_IP;
    else process.env.WS_TICKET_BIND_IP = originalBindIp;
  });

  async function loadModule() {
    return import('./remoteSessionAuth');
  }

  it('rejects when consumed from a different IP than issued', async () => {
    const { createWsTicket, consumeWsTicket } = await loadModule();
    const { ticket } = await createWsTicket({
      sessionId: 's1',
      sessionType: 'terminal',
      userId: 'u1',
      ip: '203.0.113.1',
      userAgent: 'Mozilla/5.0',
    });
    const consumed = await consumeWsTicket(ticket, {
      ip: '198.51.100.7',
      userAgent: 'Mozilla/5.0',
    });
    expect(consumed.ok).toBe(false);
    expect(consumed.ok === false && consumed.reason).toBe('ip_mismatch');
  });

  it('rejects when consumed from a different UA than issued', async () => {
    const { createWsTicket, consumeWsTicket } = await loadModule();
    const { ticket } = await createWsTicket({
      sessionId: 's1',
      sessionType: 'terminal',
      userId: 'u1',
      ip: '203.0.113.1',
      userAgent: 'Mozilla/5.0',
    });
    const consumed = await consumeWsTicket(ticket, {
      ip: '203.0.113.1',
      userAgent: 'curl/8.5',
    });
    expect(consumed.ok).toBe(false);
    expect(consumed.ok === false && consumed.reason).toBe('ua_mismatch');
  });

  it('accepts when IP and UA match', async () => {
    const { createWsTicket, consumeWsTicket } = await loadModule();
    const { ticket } = await createWsTicket({
      sessionId: 's1',
      sessionType: 'terminal',
      userId: 'u1',
      ip: '203.0.113.1',
      userAgent: 'Mozilla/5.0',
    });
    const consumed = await consumeWsTicket(ticket, {
      ip: '203.0.113.1',
      userAgent: 'Mozilla/5.0',
    });
    expect(consumed.ok).toBe(true);
    if (consumed.ok) {
      expect(consumed.userId).toBe('u1');
      expect(consumed.sessionId).toBe('s1');
      expect(consumed.sessionType).toBe('terminal');
    }
  });

  it('deletes the ticket on first mismatch (no probing)', async () => {
    const { createWsTicket, consumeWsTicket } = await loadModule();
    const { ticket } = await createWsTicket({
      sessionId: 's1',
      sessionType: 'terminal',
      userId: 'u1',
      ip: '203.0.113.1',
      userAgent: 'Mozilla/5.0',
    });
    // First attempt with WRONG IP — must be rejected and ticket burned.
    const r1 = await consumeWsTicket(ticket, {
      ip: '198.51.100.7',
      userAgent: 'Mozilla/5.0',
    });
    expect(r1.ok).toBe(false);
    expect(r1.ok === false && r1.reason).toBe('ip_mismatch');

    // Second attempt — even with the CORRECT IP+UA — must now fail with not_found.
    const r2 = await consumeWsTicket(ticket, {
      ip: '203.0.113.1',
      userAgent: 'Mozilla/5.0',
    });
    expect(r2.ok).toBe(false);
    expect(r2.ok === false && r2.reason).toBe('not_found');
  });

  it('honors WS_TICKET_BIND_IP=false (UA still bound, IP relaxed)', async () => {
    process.env.WS_TICKET_BIND_IP = 'false';
    const { createWsTicket, consumeWsTicket } = await loadModule();

    // IP mismatch with bind disabled: accept.
    const issued1 = await createWsTicket({
      sessionId: 's1',
      sessionType: 'terminal',
      userId: 'u1',
      ip: '203.0.113.1',
      userAgent: 'Mozilla/5.0',
    });
    const consumed = await consumeWsTicket(issued1.ticket, {
      ip: '198.51.100.7',
      userAgent: 'Mozilla/5.0',
    });
    expect(consumed.ok).toBe(true);

    // UA mismatch with bind disabled: still rejected.
    const issued2 = await createWsTicket({
      sessionId: 's1',
      sessionType: 'terminal',
      userId: 'u1',
      ip: '203.0.113.1',
      userAgent: 'Mozilla/5.0',
    });
    const consumed2 = await consumeWsTicket(issued2.ticket, {
      ip: '203.0.113.1',
      userAgent: 'curl/8.5',
    });
    expect(consumed2.ok).toBe(false);
    expect(consumed2.ok === false && consumed2.reason).toBe('ua_mismatch');
  });

  it('atomic claim — concurrent consume calls yield exactly one success', async () => {
    // Regression for the TOCTOU between consumeWsTicket's GET and DEL that
    // briefly slipped in (microtask boundary between read and burn). With
    // the atomic get-then-sync-delete path, only one parallel claim can
    // observe the record; the other gets not_found.
    const { createWsTicket, consumeWsTicket } = await loadModule();
    const { ticket } = await createWsTicket({
      sessionId: 's1',
      sessionType: 'terminal',
      userId: 'u1',
      ip: '203.0.113.1',
      userAgent: 'Mozilla/5.0',
    });

    const [a, b] = await Promise.all([
      consumeWsTicket(ticket, { ip: '203.0.113.1', userAgent: 'Mozilla/5.0' }),
      consumeWsTicket(ticket, { ip: '203.0.113.1', userAgent: 'Mozilla/5.0' }),
    ]);

    const successes = [a, b].filter((r) => r.ok).length;
    const notFounds = [a, b].filter((r) => !r.ok && r.reason === 'not_found').length;
    expect(successes).toBe(1);
    expect(notFounds).toBe(1);
  });

  it('returns not_found for an unknown ticket', async () => {
    const { consumeWsTicket } = await loadModule();
    const consumed = await consumeWsTicket('does-not-exist', {
      ip: '203.0.113.1',
      userAgent: 'Mozilla/5.0',
    });
    expect(consumed.ok).toBe(false);
    expect(consumed.ok === false && consumed.reason).toBe('not_found');
  });
});
