import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HttpBindings } from '@hono/node-server';
import { and, eq, isNull } from 'drizzle-orm';
import { getProvider } from '../oauth/provider';
import { setGrantBreezeMeta } from '../oauth/adapter';
import { authMiddleware } from '../middleware/auth';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthClients, partners, partnerUsers, users } from '../db/schema';
import { MCP_OAUTH_ENABLED, OAUTH_ISSUER, OAUTH_RESOURCE_URL } from '../config/env';
import { ERROR_IDS, logOauthError } from '../oauth/log';
import { writeRouteAudit } from '../services/auditEvents';

// Grant TTL in seconds — must match `ttl.Grant` in oauth/provider.ts so the
// breeze metadata side-table entry expires no later than the Grant itself.
const GRANT_TTL_SECONDS = 14 * 24 * 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    logOauthError({
      errorId: ERROR_IDS.OAUTH_INTERACTION_FIND_FAILED,
      message: 'Interaction.find failed unexpectedly',
      err,
      context: { uid },
    });
    throw new HTTPException(500, { message: 'failed to load interaction' });
  }
  if (!details) {
    throw new HTTPException(404, { message: 'interaction expired or mismatched' });
  }
  return details;
}

/**
 * Binds the interaction to the dashboard user who is currently posting.
 *
 * Threat model: anyone with a valid dashboard JWT could otherwise complete
 * an OAuth flow that another user initiated — the URL `uid` is the only
 * authority and the consent UI doesn't verify the initiating account. After
 * the OIDC login prompt, `details.session.accountId` is normally pinned to
 * the user that signed in. We:
 *   1. Reject if `session.accountId` is set AND not equal to the dashboard
 *      user (that's exactly the cross-user hijack we're guarding against).
 *   2. Reject if a previous POST already pinned a different `accountId`
 *      via `lastSubmission` (set below on the success path) — this guards
 *      against the rare pre-login resume case where the session pointer
 *      hasn't populated yet but a previous user already started consent.
 *
 * Returns nothing on success; throws HTTPException 403 with code
 * `interaction_user_mismatch` on rejection so the consent UI can surface a
 * useful error message.
 */
function ensureInteractionBoundToUser(details: any, userId: string): void {
  const sessionAccountId = details.session?.accountId;
  if (typeof sessionAccountId === 'string' && sessionAccountId !== userId) {
    throw new HTTPException(403, { message: 'interaction_user_mismatch' });
  }
  const lastSubmission = (details as { lastSubmission?: { accountId?: string } }).lastSubmission;
  const lastAccountId = lastSubmission?.accountId;
  if (typeof lastAccountId === 'string' && lastAccountId !== userId) {
    throw new HTTPException(403, { message: 'interaction_user_mismatch' });
  }
}

async function parseConsentBody(c: any): Promise<{ partner_id: string; approve: boolean }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'invalid consent request body' });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HTTPException(400, { message: 'invalid consent request body' });
  }
  const candidate = body as { partner_id?: unknown; approve?: unknown };
  if (typeof candidate.approve !== 'boolean') {
    throw new HTTPException(400, { message: 'approve must be a boolean' });
  }
  if (typeof candidate.partner_id !== 'string' || !UUID_RE.test(candidate.partner_id)) {
    throw new HTTPException(400, { message: 'partner_id must be a valid UUID' });
  }

  return { partner_id: candidate.partner_id, approve: candidate.approve };
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
    // H1: refuse to even reveal the consent payload (client_name, scopes,
    // partner picker) to a user who didn't initiate the OAuth flow. Without
    // this an attacker with a valid dashboard JWT could use a leaked URL to
    // enumerate which client a victim is connecting and prep a follow-up.
    ensureInteractionBoundToUser(details, userId);
    const clientId = details.params.client_id as string;
    const [memberships, clientRow] = await Promise.all([
      asSystem(() =>
        db.select({ partnerId: partners.id, partnerName: partners.name })
          .from(partnerUsers)
          .innerJoin(partners, eq(partners.id, partnerUsers.partnerId))
          .where(eq(partnerUsers.userId, userId))
      ),
      asSystem(async () => {
        const [row] = await db.select({ metadata: oauthClients.metadata })
          .from(oauthClients)
          .where(eq(oauthClients.id, clientId))
          .limit(1);
        return row;
      }),
    ]);

    // Prefer the registered client_name from oauth_clients.metadata (set at
    // DCR time per RFC 7591). Fall back to the auth-request param if some
    // client somehow sent one, then to the opaque client_id as a last resort
    // so the heading never renders blank.
    const registeredName = (clientRow?.metadata as { client_name?: unknown } | undefined)?.client_name;
    const clientName =
      (typeof registeredName === 'string' && registeredName.trim()) ||
      (typeof (details.params as any).client_name === 'string' && (details.params as any).client_name) ||
      clientId;

    return c.json({
      uid: details.uid,
      client: {
        client_id: clientId,
        client_name: clientName,
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

    const body = await parseConsentBody(c);
    const userId = c.get('auth').user.id;
    // H1: bind the interaction to the dashboard user submitting consent. If
    // the OIDC login prompt already pinned a different accountId on the
    // session, OR if a previous POST already pinned a different user via
    // lastSubmission, fail closed with 403. Run BEFORE the deny shortcut so
    // a malicious second user can't even cancel another user's flow.
    ensureInteractionBoundToUser(details, userId);

    if (!body.approve) {
      (details as any).result = { error: 'access_denied', error_description: 'user denied access' };
      // Pin the rejecting user so a follow-up POST by a different user
      // hits the lastSubmission mismatch check above.
      (details as any).lastSubmission = { accountId: userId };
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

    const grant = new (provider as any).Grant({
      accountId: userId,
      clientId: details.params.client_id as string,
    });
    const promptDetails = (details.prompt.details as any) ?? {};
    const missingOidcScopes =
      (promptDetails.missingOIDCScope as string[] | undefined) ??
      (promptDetails.scopes?.new as string[] | undefined) ??
      [];
    if (missingOidcScopes.length) grant.addOIDCScope(missingOidcScopes.join(' '));

    const missingResourceScopes =
      (promptDetails.missingResourceScopes as Record<string, string[]> | undefined) ?? {};
    for (const [res, scopes] of Object.entries(missingResourceScopes)) {
      grant.addResourceScope(res, scopes.join(' '));
    }
    // H3: only grant the intersection of (requested) ∩ (displayed). The UI
    // shows scopes from `prompt.details.scopes.new`; previously-accepted
    // scopes for this client live in `prompt.details.scopes.accepted`.
    // Granting anything outside that union would silently expand permissions
    // beyond what the consent screen shows the user.
    const requestedScopes = (details.params.scope as string | undefined)?.split(' ').filter(Boolean) ?? [];
    const displayedScopeSet = new Set<string>([
      ...((promptDetails.scopes?.new as string[] | undefined) ?? []),
      ...((promptDetails.scopes?.accepted as string[] | undefined) ?? []),
      // missingOIDCScope / missingResourceScopes also represent scopes the
      // provider expected the consent prompt to surface — include them so
      // we don't accidentally drop scopes the prompt machinery wants
      // satisfied (otherwise the provider would re-prompt forever).
      ...((promptDetails.missingOIDCScope as string[] | undefined) ?? []),
      ...Object.values(missingResourceScopes).flat(),
    ]);
    const grantedScopes = requestedScopes.filter((s) => displayedScopeSet.has(s));
    if (requestedScopes.length > 0 && grantedScopes.length === 0) {
      throw new HTTPException(400, { message: 'invalid_scope' });
    }
    // Grant the intersection at BOTH the OIDC and resource level. The
    // provider's consent prompt machinery checks `missingOIDCScope` against
    // the OIDC grant set even for scopes that "logically" belong to a
    // resource indicator (because they appear in the auth request's
    // `scope` parameter). Granting them in both places means the consent
    // prompt is auto-satisfied on resume.
    if (grantedScopes.length) grant.addOIDCScope(grantedScopes.join(' '));
    if (resource) {
      const resourceScopes = grantedScopes.filter((scope) => scope.startsWith('mcp:'));
      if (!missingResourceScopes[resource] && resourceScopes.length) {
        grant.addResourceScope(resource, resourceScopes.join(' '));
      }
    }

    const grantId = await grant.save();
    // We can't put `breeze` on the Grant payload — oidc-provider's
    // Grant.IN_PAYLOAD allowlist drops unknown fields on save. Stash the
    // tenancy metadata in a process-local side table keyed by grantId and in
    // the Grant DB row, then read it back in `buildExtraTokenClaims` when the
    // access token is minted.
    //
    // Fail closed: if persistence fails the Grant row exists with NULL
    // partner_id, and resuming the flow would mint a JWT with `partner_id:
    // null` that bearer middleware rejects. The Grant.save() above is
    // recoverable on a retry click since the auth code is short-lived.
    try {
      await setGrantBreezeMeta(grantId, { partner_id: body.partner_id, org_id: orgId }, GRANT_TTL_SECONDS);
    } catch {
      // setGrantBreezeMeta already logs with errorId. Surface a generic 500
      // to the consent client; they can retry.
      throw new HTTPException(500, { message: 'failed to persist grant metadata' });
    }

    // H2: bind partner_id ONLY on the FIRST partner that consents. The same
    // DCR `client_id` is shared across tenants (e.g. Claude.ai registers
    // once, every Breeze partner uses the same row). Unconditional UPDATE
    // would let the most-recent consenting partner stomp the row's binding,
    // breaking the connected-apps UI for every other partner that already
    // installed it. The grants/refresh tokens themselves are still correctly
    // partitioned by `oauth_grants.partner_id` / `oauth_refresh_tokens.partner_id`,
    // so the auth surface is unaffected.
    //
    // TODO(security): the proper long-term fix is a join table
    // `oauth_client_partner_grants(client_id, partner_id, first_consented_at)`
    // so each (client, partner) pair has its own visibility/revocation row.
    // Tracked in the OAuth security audit doc.
    const clientIdForUpdate = details.params.client_id as string;
    const updateResult = await asSystem(async () => {
      const rows = await db.update(oauthClients)
        .set({ partnerId: body.partner_id })
        .where(and(
          eq(oauthClients.id, clientIdForUpdate),
          isNull(oauthClients.partnerId),
        ))
        .returning({ id: oauthClients.id });
      return rows;
    });
    const partnerBound = updateResult.length > 0;
    // LOW: emit an audit-log entry so cross-tenant contention on shared DCR
    // client rows is observable. `partner_bound` is the first-consent path,
    // `partner_bind_skipped` is the (expected, but visibility-relevant)
    // case where another partner had already claimed the row.
    try {
      writeRouteAudit(c as any, {
        orgId: orgId,
        action: partnerBound ? 'oauth.client.partner_bound' : 'oauth.client.partner_bind_skipped',
        resourceType: 'oauth_client',
        resourceId: clientIdForUpdate,
        details: {
          client_id: clientIdForUpdate,
          partner_id: body.partner_id,
          user_id: userId,
        },
      });
    } catch (err) {
      // Audit logging is best-effort; never break the consent flow if it
      // fails. Surface to stderr/Sentry via the existing OAuth logger.
      logOauthError({
        errorId: ERROR_IDS.OAUTH_PROVIDER_SERVER_ERROR,
        message: 'Failed to write partner-bind audit event',
        err,
        context: { clientId: clientIdForUpdate, partnerId: body.partner_id },
      });
    }

    // We can't use provider.interactionResult(req, res, ...) here for the
    // same reason we don't use interactionDetails(): it reads the UID from
    // the _interaction cookie, which can lag the URL by one step in a
    // multi-prompt flow (login → consent). Set the result on the
    // interaction directly and return the canonical resume URL.
    (details as any).result = {
      login: { accountId: userId },
      consent: { grantId },
    };
    // Pin the consenting user so a follow-up POST by a different user
    // hits the H1 mismatch check on `lastSubmission` even if `details.session`
    // hasn't been populated yet (rare pre-login resume edge).
    (details as any).lastSubmission = { accountId: userId };
    await (details as any).save((details as any).exp - Math.floor(Date.now() / 1000));
    const redirectTo = `${OAUTH_ISSUER}/oauth/auth/${details.uid}`;
    return c.json({ redirectTo });
  });
}
