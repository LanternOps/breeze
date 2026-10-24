import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import {
  CORS_ALLOW_HEADERS, CORS_EXPOSE_HEADERS, CORS_MIDDLEWARE_OPTIONS,
  __resetMcpOriginCountersForTests, checkMcpOrigin, mcpLegacyOriginRejectCount, resolveCorsOrigin,
} from './corsPolicy';

describe('corsPolicy', () => {
  it('CORS_ALLOW_HEADERS includes MCP-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name', () => {
    for (const h of ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Key', 'X-Breeze-CSRF',
      'MCP-Protocol-Version', 'Mcp-Session-Id', 'Mcp-Method', 'Mcp-Name']) {
      expect(CORS_ALLOW_HEADERS).toContain(h);
    }
  });

  it('CORS_EXPOSE_HEADERS includes Mcp-Session-Id and WWW-Authenticate', () => {
    for (const h of ['Content-Length', 'X-Request-Id', 'Mcp-Session-Id', 'WWW-Authenticate']) {
      expect(CORS_EXPOSE_HEADERS).toContain(h);
    }
  });

  it('reads CORS env on first use, not at import (index.ts loads .env after imports run)', async () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS };
    vi.resetModules();
    delete process.env.CORS_ALLOWED_ORIGINS;
    process.env.NODE_ENV = 'development';
    const fresh = await import('./corsPolicy');
    // dotenv runs here in production, after every import has evaluated.
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
    try {
      expect(fresh.resolveCorsOrigin('https://app.example.com')).toBe('https://app.example.com');
      expect(fresh.resolveCorsOrigin('http://10.0.0.5:4321')).toBeNull();
      expect(fresh.resolveCorsOrigin('http://localhost:4321')).toBeNull();
    } finally {
      process.env.NODE_ENV = saved.NODE_ENV;
      if (saved.CORS_ALLOWED_ORIGINS === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
      else process.env.CORS_ALLOWED_ORIGINS = saved.CORS_ALLOWED_ORIGINS;
    }
  });

  it('resolveCorsOrigin keeps the dev defaults (non-production test env)', () => {
    expect(resolveCorsOrigin('http://localhost:4321')).toBe('http://localhost:4321');
    expect(resolveCorsOrigin('https://evil.example.net')).toBeNull();
    expect(resolveCorsOrigin(undefined)).toBeNull();
  });

  it('OPTIONS /api/v1/mcp/sse preflight allows Mcp-Method (the global options index.ts uses)', async () => {
    const app = new Hono();
    app.use('*', cors(CORS_MIDDLEWARE_OPTIONS));
    app.post('/api/v1/mcp/sse', (c) => c.text('ok'));
    const res = await app.request('/api/v1/mcp/sse', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:4321',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'mcp-method,mcp-name,mcp-protocol-version',
      },
    });
    expect(res.status).toBe(204);
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    for (const h of ['mcp-method', 'mcp-name', 'mcp-protocol-version', 'mcp-session-id']) expect(allowed).toContain(h);
  });

  it('index.ts mounts the global CORS middleware with CORS_MIDDLEWARE_OPTIONS', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8');
    expect(src).toContain('cors(CORS_MIDDLEWARE_OPTIONS)');
    expect(src).not.toMatch(/allowHeaders:\s*\[/);
  });

  describe('checkMcpOrigin', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    beforeEach(() => {
      __resetMcpOriginCountersForTests();
      warn.mockClear();
    });
    afterEach(() => warn.mockClear());

    async function run(era: 'legacy' | 'modern', origin?: string) {
      const app = new Hono();
      app.post('/x', (c) => checkMcpOrigin(c, era) ?? c.json({ ok: true }));
      return app.request('/x', { method: 'POST', headers: origin ? { Origin: origin } : {} });
    }

    it('modern request with a disallowed Origin → 403 with id-less -32600', async () => {
      const res = await run('modern', 'https://evil.example.net');
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toEqual({ jsonrpc: '2.0', error: { code: -32600, message: 'Origin not allowed' } });
      expect(body).not.toHaveProperty('id');
    });

    it('modern request with no Origin passes', async () => {
      expect((await run('modern')).status).toBe(200);
    });

    it('modern request with an allowed Origin passes', async () => {
      expect((await run('modern', 'http://localhost:4321')).status).toBe(200);
    });

    it('legacy request with a disallowed Origin passes and is counted (log-only)', async () => {
      const res = await run('legacy', 'https://evil.example.net');
      expect(res.status).toBe(200);
      expect(mcpLegacyOriginRejectCount()).toBe(1);
      await run('legacy', 'https://evil.example.net');
      expect(mcpLegacyOriginRejectCount()).toBe(2);
      // One line per window (on its first occurrence), not one per request.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toEqual({ windowSeconds: 60, totalSinceBoot: 1 });
    });

    it('legacy request with an allowed or absent Origin is not counted', async () => {
      await run('legacy', 'http://localhost:4321');
      await run('legacy');
      expect(mcpLegacyOriginRejectCount()).toBe(0);
    });
  });
});
