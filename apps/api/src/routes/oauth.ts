import { Hono } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { getProvider } from '../oauth/provider';
import { MCP_OAUTH_ENABLED } from '../config/env';
import { getRedis, rateLimiter } from '../services';

export const oauthRoutes = new Hono<{ Bindings: HttpBindings }>();

if (MCP_OAUTH_ENABLED) {
  oauthRoutes.use('*', async (c, next) => {
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.env.incoming?.socket?.remoteAddress ??
      'unknown';
    const sub = c.req.path.replace(/^\/oauth/, '');

    let limit = 0;
    let windowSeconds = 0;
    let key = '';

    if (c.req.method === 'POST' && sub === '/reg') {
      limit = 10;
      windowSeconds = 3600;
      key = `oauth:register:${ip}`;
    } else if (c.req.method === 'POST' && sub === '/token') {
      // Key by IP only. We could key by client_id but that requires reading the
      // request body, which would drain the underlying Node IncomingMessage
      // stream and prevent oidc-provider's callback() from parsing the body.
      // 60/min/IP is sufficient for MVP - burst protection is the goal here,
      // not per-client granularity.
      limit = 60;
      windowSeconds = 60;
      key = `oauth:token:ip:${ip}`;
    } else if ((c.req.method === 'GET' || c.req.method === 'POST') && sub === '/auth') {
      limit = 20;
      windowSeconds = 60;
      key = `oauth:authorize:${ip}`;
    }

    if (limit) {
      const result = await rateLimiter(getRedis(), key, limit, windowSeconds);
      if (!result.allowed) return c.json({ error: 'rate_limited' }, 429);
    }

    return next();
  });

  oauthRoutes.all('/*', async (c) => {
    const provider = await getProvider();
    const callback = provider.callback();
    const req = c.env.incoming;
    const res = c.env.outgoing;

    // oidc-provider expects issuer-relative paths (/auth, /token, /reg, ...).
    const originalUrl = req.url ?? '/';
    req.url = originalUrl.replace(/^\/oauth/, '') || '/';

    return new Promise<Response>((resolve) => {
      const cleanup = () => {
        res.removeListener('finish', onFinish);
        res.removeListener('close', onClose);
        res.removeListener('error', onError);
      };
      const onFinish = () => {
        cleanup();
        resolve(new Response(null, { status: res.statusCode }));
      };
      const onClose = () => {
        cleanup();
        resolve(new Response(null, { status: res.statusCode || 499 }));
      };
      const onError = (err: unknown) => {
        cleanup();
        console.error('[oauth] bridge response error', { path: originalUrl, err });
        resolve(new Response('oauth error', { status: 500 }));
      };
      res.on('finish', onFinish);
      res.on('close', onClose);
      res.on('error', onError);
      try {
        callback(req, res);
      } catch (err) {
        cleanup();
        console.error('[oauth] bridge callback threw', { path: originalUrl, err });
        resolve(new Response('oauth threw', { status: 500 }));
      }
    });
  });
}
