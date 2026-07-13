import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { authMiddleware } from '../middleware/auth';
import { db } from '../db';
import { oauthClients, oauthClientPartnerGrants } from '../db/schema';
import { revokeClientFamilies } from '../oauth/revocationService';
import { ERROR_IDS, logOauthError } from '../oauth/log';
import { MCP_OAUTH_ENABLED } from '../config/env';

export const connectedAppsRoutes = new Hono();

if (MCP_OAUTH_ENABLED) {
  connectedAppsRoutes.use('*', authMiddleware);

  connectedAppsRoutes.get('/', async (c) => {
    const partnerId = c.get('auth').partnerId;
    if (!partnerId) throw new HTTPException(403, { message: 'partner scope required' });

    // Query (client, partner) pairs from the join table — a single DCR
    // client_id is shared across all consenting partners, so the old
    // `oauth_clients.partner_id = $partnerId` filter would only show the
    // FIRST partner that consented and hide the app from everyone else.
    const rows = await db.select({
      clientId: oauthClients.id,
      metadata: oauthClients.metadata,
      createdAt: oauthClients.createdAt,
      lastUsedAt: oauthClients.lastUsedAt,
      disabledAt: oauthClients.disabledAt,
    })
      .from(oauthClients)
      .innerJoin(
        oauthClientPartnerGrants,
        eq(oauthClientPartnerGrants.clientId, oauthClients.id),
      )
      .where(eq(oauthClientPartnerGrants.partnerId, partnerId));

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

    // Look up the join row, not the client row. A DCR client is shared
    // across partners; "is this app connected for me?" is answered by the
    // (client, partner) join, not by `oauth_clients.partner_id` (which
    // only points at the first consenting partner under the legacy schema).
    const [row] = await db.select()
      .from(oauthClientPartnerGrants)
      .where(and(
        eq(oauthClientPartnerGrants.clientId, clientId),
        eq(oauthClientPartnerGrants.partnerId, partnerId),
      ))
      .limit(1);
    if (!row) return c.body(null, 404);

    // Partner disconnect of a shared DCR client. Grant discovery is
    // authoritative from oauth_grants (partner scope), so code-only grants —
    // auth-code access tokens minted without a refresh token — are revoked
    // too (MCP-OAUTH-07). The service writes Redis markers BEFORE any DB
    // mutation and throws on marker failure; we surface that as a 503 so the
    // user sees a hard error rather than a hidden-but-partially-revoked app.
    // Only this partner's join row is removed; other partners on the same
    // shared client keep working.
    try {
      await revokeClientFamilies(clientId, { kind: 'partner', partnerId });
    } catch (err) {
      logOauthError({
        errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
        message: 'connected-app partner revocation failed',
        err,
        context: { clientId, partnerId },
      });
      throw new HTTPException(503, { message: 'revocation cache unavailable' });
    }

    return c.body(null, 204);
  });
}
