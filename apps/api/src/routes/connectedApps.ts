import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { authMiddleware } from '../middleware/auth';
import { db } from '../db';
import { oauthClients, oauthRefreshTokens } from '../db/schema';
import { revokeJti } from '../oauth/revocationCache';
import { MCP_OAUTH_ENABLED } from '../config/env';

export const connectedAppsRoutes = new Hono();

if (MCP_OAUTH_ENABLED) {
  connectedAppsRoutes.use('*', authMiddleware);

  connectedAppsRoutes.get('/', async (c) => {
    const partnerId = c.get('auth').partnerId;
    if (!partnerId) throw new HTTPException(403, { message: 'partner scope required' });

    const rows = await db.select({
      clientId: oauthClients.id,
      metadata: oauthClients.metadata,
      createdAt: oauthClients.createdAt,
      lastUsedAt: oauthClients.lastUsedAt,
    }).from(oauthClients).where(eq(oauthClients.partnerId, partnerId));

    return c.json({
      clients: rows.map((r) => ({
        client_id: r.clientId,
        client_name: ((r.metadata as { client_name?: string } | null)?.client_name) ?? r.clientId,
        created_at: r.createdAt,
        last_used_at: r.lastUsedAt,
      })),
    });
  });

  connectedAppsRoutes.delete('/:clientId', async (c) => {
    const partnerId = c.get('auth').partnerId;
    if (!partnerId) throw new HTTPException(403, { message: 'partner scope required' });
    const clientId = c.req.param('clientId');

    const [row] = await db.select().from(oauthClients)
      .where(and(eq(oauthClients.id, clientId), eq(oauthClients.partnerId, partnerId)))
      .limit(1);
    if (!row) return c.body(null, 404);

    if (!row.disabledAt) {
      await db.update(oauthClients)
        .set({ disabledAt: new Date() })
        .where(eq(oauthClients.id, clientId));
    }

    const tokens = await db.select({
      id: oauthRefreshTokens.id,
      payload: oauthRefreshTokens.payload,
      expiresAt: oauthRefreshTokens.expiresAt,
    }).from(oauthRefreshTokens)
      .where(and(eq(oauthRefreshTokens.clientId, clientId), eq(oauthRefreshTokens.partnerId, partnerId)));

    const now = new Date();
    for (const token of tokens) {
      await db.update(oauthRefreshTokens)
        .set({ revokedAt: now })
        .where(eq(oauthRefreshTokens.id, token.id));

      const jti = (token.payload as { jti?: string } | null)?.jti;
      if (!jti) continue;

      const ttl = Math.ceil((new Date(token.expiresAt).getTime() - Date.now()) / 1000);
      try {
        await revokeJti(jti, Math.max(ttl, 1));
      } catch (err) {
        console.error('[oauth] connected-app revocation cache write failed', err);
      }
    }

    return c.body(null, 204);
  });
}
