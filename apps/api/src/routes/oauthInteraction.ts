import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HttpBindings } from '@hono/node-server';
import { and, eq } from 'drizzle-orm';
import { getProvider } from '../oauth/provider';
import { authMiddleware } from '../middleware/auth';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthClients, partners, partnerUsers, users } from '../db/schema';
import { MCP_OAUTH_ENABLED, OAUTH_ISSUER, OAUTH_RESOURCE_URL } from '../config/env';

const asSystem = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

export const oauthInteractionRoutes = new Hono<{ Bindings: HttpBindings }>();

async function interactionDetails(provider: Awaited<ReturnType<typeof getProvider>>, _c: any, uid: string) {
  // Use Interaction.find(uid) directly with the UID from the URL path
  // instead of provider.interactionDetails(req, res), which reads UID from
  // the `_interaction` cookie. Why: a single OAuth flow can have multiple
  // sequential prompts (e.g. login then consent). Each time the provider
  // resumes the flow it sets a NEW _interaction cookie with the new UID,
  // but the browser may still hold the old cookie when it loads the new
  // consent page (timing/race) — so cookie UID and URL UID can disagree.
  // The URL UID is authoritative, the dashboard JWT (authMiddleware) gates
  // who can call this endpoint, and the UID is a 21-char URL-safe random
  // string with a 1-hour TTL — same security surface as the cookie.
  let details: any;
  try {
    details = await (provider as any).Interaction.find(uid);
  } catch (err) {
    console.error('[oauth] Interaction.find failed unexpectedly', { uid, err });
    throw new HTTPException(500, { message: 'failed to load interaction' });
  }
  if (!details) {
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
      (details as any).result = { error: 'access_denied', error_description: 'user denied access' };
      await (details as any).save((details as any).exp - Math.floor(Date.now() / 1000));
      return c.json({ redirectTo: `${OAUTH_ISSUER}/oauth/auth/${details.uid}` });
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

    // The provider may emit multiple prompts in sequence (login → consent).
    // Build the result based on which one we're responding to. The UI
    // submits a single Approve; if the resume yields another prompt, the
    // consent page reloads and the user clicks again.
    const promptName = details.prompt.name as string;
    const result: Record<string, unknown> = {};

    if (promptName === 'login') {
      // Login prompt: the provider just needs to know which account is
      // logged in for this OIDC session. No Grant required yet.
      result.login = { accountId: userId };
    } else if (promptName === 'consent') {
      // Consent prompt: build a Grant with all missing scopes (per
      // promptDetails.missingOIDCScope and missingResourceScopes), bind
      // it to the chosen partner via grant.breeze, then submit grantId.
      const grant = new (provider.Grant as any)({
        accountId: userId,
        clientId: details.params.client_id as string,
      });
      const promptDetails = (details.prompt.details as any) ?? {};
      const missingOidcScopes = (promptDetails.missingOIDCScope as string[] | undefined)
        ?? (promptDetails.scopes?.new as string[] | undefined)
        ?? [];
      if (missingOidcScopes.length) grant.addOIDCScope(missingOidcScopes.join(' '));

      const missingResourceScopes = (promptDetails.missingResourceScopes as Record<string, string[]> | undefined) ?? {};
      for (const [res, scopes] of Object.entries(missingResourceScopes)) {
        grant.addResourceScope(res, scopes.join(' '));
      }
      // Defensive fallback when prompt didn't list the resource explicitly.
      if (resource && !missingResourceScopes[resource]) {
        grant.addResourceScope(resource, 'mcp:read mcp:write');
      }

      grant.breeze = { partner_id: body.partner_id, org_id: orgId };
      const grantId = await grant.save();

      await asSystem(async () => {
        await db.update(oauthClients)
          .set({ partnerId: body.partner_id })
          .where(eq(oauthClients.id, details.params.client_id as string));
      });

      result.consent = { grantId };
    } else {
      throw new HTTPException(400, { message: `unsupported prompt type: ${promptName}` });
    }

    // We can't use provider.interactionResult(req, res, ...) here for the
    // same reason we don't use interactionDetails(): it reads the UID from
    // the _interaction cookie, which can lag the URL by one step in a
    // multi-prompt flow (login → consent). Set the result on the
    // interaction directly and return the canonical resume URL.
    (details as any).result = result;
    await (details as any).save((details as any).exp - Math.floor(Date.now() / 1000));
    const redirectTo = `${OAUTH_ISSUER}/oauth/auth/${details.uid}`;
    return c.json({ redirectTo });
  });
}
