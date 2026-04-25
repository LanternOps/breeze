import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { authMiddleware } from '../middleware/auth';
import { db } from '../db';
import { oauthClients, oauthRefreshTokens } from '../db/schema';
import { revokeGrant, revokeJti } from '../oauth/revocationCache';
import { ERROR_IDS, logOauthError } from '../oauth/log';
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
      disabledAt: oauthClients.disabledAt,
    }).from(oauthClients).where(eq(oauthClients.partnerId, partnerId));

    return c.json({
      clients: rows
        .filter((r) => !r.disabledAt)
        .map((r) => ({
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
    // Track unique grant ids so we only write each grant marker once per
    // delete (a connected app may have many active refresh tokens, all
    // pointing at the same Grant after rotation).
    const seenGrants = new Set<string>();
    // Grant-revocation marker TTL must outlive every access JWT minted under
    // the grant. Mirrors ACCESS_TOKEN_TTL_SECONDS in oauth/provider.ts.
    const ACCESS_TOKEN_TTL_SECONDS = 600;

    for (const token of tokens) {
      await db.update(oauthRefreshTokens)
        .set({ revokedAt: now })
        .where(eq(oauthRefreshTokens.id, token.id));

      const payload = token.payload as { jti?: string; grantId?: string } | null;
      const jti = payload?.jti;
      const grantId = payload?.grantId;

      // Cache writes MUST propagate failures. The DB row above marks the
      // refresh token revoked (so future refresh-grant exchanges fail), but
      // the cache is the only signal that kills sibling access JWTs already
      // minted under the grant before their natural expiry. If the cache
      // write fails we MUST surface a 503 so the operator/user knows the
      // app is only partially disconnected — better a hard error than a
      // silent residual-access window.
      if (jti) {
        const ttl = Math.ceil((new Date(token.expiresAt).getTime() - Date.now()) / 1000);
        try {
          await revokeJti(jti, Math.max(ttl, 1));
        } catch (err) {
          logOauthError({
            errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
            message: 'connected-app jti revocation cache write failed',
            err,
            context: { jti, clientId },
          });
          throw new HTTPException(503, { message: 'revocation cache unavailable' });
        }
      }

      // Mark the entire grant revoked too so any access JWTs already in
      // flight (separate jtis derived from the same grant) are immediately
      // rejected by bearer middleware. Without this the access tokens
      // would survive until natural 10-minute expiry.
      if (grantId && !seenGrants.has(grantId)) {
        seenGrants.add(grantId);
        try {
          await revokeGrant(grantId, ACCESS_TOKEN_TTL_SECONDS);
        } catch (err) {
          logOauthError({
            errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
            message: 'connected-app grant revocation cache write failed',
            err,
            context: { grantId, clientId },
          });
          throw new HTTPException(503, { message: 'revocation cache unavailable' });
        }
      }
    }

    return c.body(null, 204);
  });
}
