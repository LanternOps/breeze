import { Hono } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { getProvider } from '../oauth/provider';
import { MCP_OAUTH_ENABLED } from '../config/env';

export const oauthRoutes = new Hono<{ Bindings: HttpBindings }>();

if (MCP_OAUTH_ENABLED) {
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
