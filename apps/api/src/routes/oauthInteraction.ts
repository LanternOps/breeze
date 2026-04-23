import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HttpBindings } from '@hono/node-server';
import { and, eq } from 'drizzle-orm';
import { getProvider } from '../oauth/provider';
import { authMiddleware } from '../middleware/auth';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthClients, partners, partnerUsers, users } from '../db/schema';
import { MCP_OAUTH_ENABLED, OAUTH_RESOURCE_URL } from '../config/env';

const asSystem = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

export const oauthInteractionRoutes = new Hono<{ Bindings: HttpBindings }>();

async function interactionDetails(provider: Awaited<ReturnType<typeof getProvider>>, c: any, uid: string) {
  let details: Awaited<ReturnType<typeof provider.interactionDetails>>;
  try {
    details = await provider.interactionDetails(c.env.incoming, c.env.outgoing);
  } catch (err) {
    // oidc-provider throws SessionNotFound (and similar) when the cookie is
    // missing/expired — that's a real 404 case. Anything else is unexpected
    // and should surface a 500 with a logged cause so we don't silently
    // mask provider/cookie/bridge bugs as "interaction expired".
    const name = (err as { name?: string }).name ?? '';
    if (name === 'SessionNotFound' || name === 'InvalidRequest') {
      throw new HTTPException(404, { message: 'interaction expired or mismatched' });
    }
    console.error('[oauth] interactionDetails failed unexpectedly', { uid, err });
    throw new HTTPException(500, { message: 'failed to load interaction' });
  }
  if (!details || details.uid !== uid) {
    throw new HTTPException(404, { message: 'interaction expired or mismatched' });
  }
  return details;
}

if (MCP_OAUTH_ENABLED) {
  oauthInteractionRoutes.use('*', authMiddleware);

  oauthInteractionRoutes.get('/interaction/:uid', async (c) => {
    const provider = await getProvider();
    const details = await interactionDetails(provider, c, c.req.param('uid'));
    const resource = details.params.resource as string | undefined;
    if (resource && resource !== OAUTH_RESOURCE_URL) {
      throw new HTTPException(400, { message: 'unsupported resource indicator' });
    }

    const userId = c.get('auth').user.id;
    const memberships = await asSystem(() =>
      db.select({ partnerId: partners.id, partnerName: partners.name })
        .from(partnerUsers)
        .innerJoin(partners, eq(partners.id, partnerUsers.partnerId))
        .where(eq(partnerUsers.userId, userId))
    );

    return c.json({
      uid: details.uid,
      client: {
        client_id: details.params.client_id,
        client_name: (details.params as any).client_name ?? details.params.client_id,
      },
      scopes: ((details.prompt.details as any)?.scopes?.new ?? []) as string[],
      resource: resource ?? null,
      partners: memberships,
    });
  });

  oauthInteractionRoutes.post('/interaction/:uid/consent', async (c) => {
    const provider = await getProvider();
    const details = await interactionDetails(provider, c, c.req.param('uid'));
    const resource = details.params.resource as string | undefined;
    if (resource && resource !== OAUTH_RESOURCE_URL) {
      throw new HTTPException(400, { message: 'unsupported resource indicator' });
    }

    const body = await c.req.json<{ partner_id: string; approve: boolean }>();
    const userId = c.get('auth').user.id;

    if (!body.approve) {
      const result = { error: 'access_denied', error_description: 'user denied access' };
      const redirectTo = await provider.interactionResult(
        c.env.incoming, c.env.outgoing, result, { mergeWithLastSubmission: false }
      );
      return c.json({ redirectTo });
    }

    const { hasAccess, orgId } = await asSystem(async () => {
      const [membership] = await db.select().from(partnerUsers)
        .where(and(eq(partnerUsers.userId, userId), eq(partnerUsers.partnerId, body.partner_id)))
        .limit(1);
      if (!membership) return { hasAccess: false, orgId: null as string | null };

      const [u] = await db.select({ partnerId: users.partnerId, orgId: users.orgId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return {
        hasAccess: true,
        orgId: u && u.partnerId === body.partner_id ? u.orgId : null,
      };
    });
    if (!hasAccess) throw new HTTPException(403, { message: 'not a member of this partner' });

    const grant = new (provider.Grant as any)({
      accountId: userId,
      clientId: details.params.client_id as string,
    });
    const newScopes = ((details.prompt.details as any)?.scopes?.new ?? []) as string[];
    if (newScopes.length) grant.addOIDCScope(newScopes.join(' '));
    if (resource) grant.addResourceScope(resource, 'mcp:read mcp:write');
    grant.breeze = { partner_id: body.partner_id, org_id: orgId };
    const grantId = await grant.save();

    await asSystem(async () => {
      await db.update(oauthClients)
        .set({ partnerId: body.partner_id })
        .where(eq(oauthClients.id, details.params.client_id as string));
    });

    const result = { consent: { grantId }, login: { accountId: userId } };
    const redirectTo = await provider.interactionResult(
      c.env.incoming, c.env.outgoing, result, { mergeWithLastSubmission: false }
    );
    return c.json({ redirectTo });
  });
}
