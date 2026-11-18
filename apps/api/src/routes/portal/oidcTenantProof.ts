/**
 * Entra tenant proof run, portal side (portal registration W4 #11381, plan
 * Task 8; D6; Review Focus 3; spec §5.4(b), inv. 2).
 *
 * An MSP creates a proof-run link (routes/orgPortalEntraTenant.ts) and sends it
 * to the customer's tenant admin. This file holds the two portal halves:
 *
 *  - `GET /api/v1/portal/auth/oidc/entra/proof?run=<token>` (public, mounted in
 *    ./oidc.ts): PEEK the run, mint a `tenant_proof` OIDC state and send the
 *    admin to Microsoft with the run's pinned tenant as the authority and the
 *    proof scope (OD2). The run is not consumed, so a failed sign-in or a
 *    failed admin check leaves the link usable.
 *  - the `tenant_proof` branch of the shared callback, reached after the code
 *    exchange and the id_token check pinned to the run's tenant:
 *      1. the live Graph admin-role check (Global Administrator or Privileged
 *         Role Administrator), bound to the token's principal and tenant —
 *         `wids` is never read;
 *      2. GET+DEL the run by its hash (two concurrent callbacks record ONE
 *         proof), then re-authorize: the org is still active and still the
 *         run's partner's, and the link's creator is still an active member of
 *         that partner whose org access covers the org;
 *      3. record the proof (`via: 'proof_run'`; the service audits `.proven`
 *         and any `.displaced`);
 *      4. send the admin to the tenant-wide admin consent for the sign-in
 *         scopes.
 *
 * Result pages are only `/entra-setup?status=invalid|failed` (the consent
 * return ends at `consent_done`). A refused callback writes ONE
 * `organization.portal_identity_proof.failed` row on the run's org, carrying the
 * reason only. No DB context is held on these public routes: every read here
 * and the proof writer open their own system contexts.
 *
 * Nothing here logs or audits a code, token, run token or hash (D14).
 */
import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partnerUsers, users } from '../../db/schema';
import { getPortalEntraConfig, type PortalEntraConfig } from '../../config/portalEntra';
import { writeAuditEventAsync } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import { rateLimitIpKey } from '../../services/clientIp';
import { PortalEntraProofError, recordEntraTenantProof } from '../../services/portalEntraTenantProof';
import {
  PORTAL_ENTRA_PROOF_SCOPE,
  buildPortalAppAdminConsentUrl,
  buildPortalEntraAuthorizeUrl,
} from '../../services/portalOidc/entraClient';
import {
  consumePortalEntraProofRunByHash,
  peekPortalEntraProofRun,
  type PortalEntraProofRunRecord,
} from '../../services/portalOidc/proofRunStore';
import {
  PortalOidcStateUnavailableError,
  buildPortalOidcBindingCookie,
  createPortalOidcState,
} from '../../services/portalOidc/stateStore';
import type { PortalOidcPurpose, PortalOidcVerifiedIdentity } from '../../services/portalOidc/types';
import { getActiveOrgTenant } from '../../services/tenantStatus';
import { getUserPermissions, hasPermission, PERMISSIONS } from '../../services/permissions';
import { checkMailboxConsentAdminRoleViaGraph } from '../../services/ticketMailbox/microsoftIdentity';
import { buildPortalUrl, checkRateLimit, getClientIp, sweepPortalState } from './helpers';

/** Mounted under /api/v1/portal; equals services/portalOidc/proofRunStore PORTAL_ENTRA_PROOF_RUN_PATH. */
export const PORTAL_ENTRA_PROOF_ROUTE = '/auth/oidc/entra/proof';

/** Global Constraints: per-IP proof-link limiter. */
const PROOF_RATE_LIMIT = { windowMs: 15 * 60 * 1000, maxAttempts: 10, blockMs: 30 * 60 * 1000 };
const AUDIT_FAILED = 'organization.portal_identity_proof.failed';

// ============================================
// Result page
// ============================================

export type EntraSetupResult = 'proven' | 'consent_done' | 'invalid' | 'failed';

/** The fixed portal page every proof flow (and the consent return) ends on. */
export function entraSetupResult(status: EntraSetupResult): string {
  return buildPortalUrl(`/entra-setup?status=${status}`);
}

// ============================================
// Audit
// ============================================

/**
 * One secret-free `organization.portal_identity_proof.failed` row on the run's
 * org for a refused proof callback: the reason (plus a Graph-check or proof
 * error code) only. The actor is anonymous: the tenant admin is not a Breeze
 * user. A failed audit write never changes the redirect. Also used by the
 * shared callback for proof flows it refuses before this branch.
 */
export async function auditTenantProofRefusal(
  c: Context,
  orgId: string,
  reason: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await writeAuditEventAsync(c, {
      orgId,
      actorType: 'system',
      actorId: null,
      initiatedBy: 'manual',
      action: AUDIT_FAILED,
      resourceType: 'organization',
      resourceId: orgId,
      result: 'failure',
      details: { reason, ...extra },
    });
  } catch (error) {
    console.error('[portal] Entra tenant proof audit write failed:', error instanceof Error ? error.message : error);
    captureException(error instanceof Error ? error : new Error(String(error)));
  }
}

// ============================================
// Proof-run link: start the pinned sign-in
// ============================================

/** Exactly one non-empty `run`; other keys (mail-client tracking) are ignored. */
function runTokenFrom(c: Context): string | null {
  const values = c.req.queries('run') ?? [];
  return values.length === 1 && values[0] ? values[0] : null;
}

/**
 * `GET {PORTAL_ENTRA_PROOF_ROUTE}?run=<token>`. Not configured → 404 and
 * rate-limited → 429, as the other start routes; a state store outage → 503.
 * An unknown, used or expired run → 302 `/entra-setup?status=invalid`.
 * Otherwise 302 to Microsoft, authority = the run's pinned tenant (D6).
 */
export async function startPortalEntraTenantProof(
  c: Context,
  opts: { secureCookie: boolean; hostOrgId: () => Promise<string | null> },
): Promise<Response> {
  sweepPortalState();
  c.header('Cache-Control', 'no-store');
  // The link URL carries the capability: never let it travel as a referrer.
  c.header('Referrer-Policy', 'no-referrer');

  const cfg = getPortalEntraConfig();
  if (!cfg) return c.json({ error: 'Not found' }, 404);

  const rate = await checkRateLimit(`portal:oidc:proof:ip:${rateLimitIpKey(getClientIp(c))}`, PROOF_RATE_LIMIT);
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfterSeconds));
    return c.json({ error: 'Too many attempts. Please try again later.' }, 429);
  }

  const token = runTokenFrom(c);
  // A peek: the run is consumed only right before the proof is recorded.
  const peeked = token ? await peekPortalEntraProofRun(token) : null;
  if (!peeked) return c.redirect(entraSetupResult('invalid'), 302);
  const { record, tokenHash } = peeked;

  let flow: Awaited<ReturnType<typeof createPortalOidcState>>;
  try {
    flow = await createPortalOidcState({
      provider: 'entra',
      purpose: { kind: 'tenant_proof', runTokenHash: tokenHash, orgId: record.orgId, expectedTenantId: record.expectedTenantId },
      hostOrgId: await opts.hostOrgId(),
      authority: record.expectedTenantId,
    });
  } catch (error) {
    if (error instanceof PortalOidcStateUnavailableError) return c.json({ error: 'Service temporarily unavailable' }, 503);
    throw error;
  }

  const authorizeUrl = buildPortalEntraAuthorizeUrl(cfg, {
    authority: record.expectedTenantId,
    scope: PORTAL_ENTRA_PROOF_SCOPE,
    state: flow.state,
    nonce: flow.nonce,
    codeChallenge: flow.codeChallenge,
  });
  c.header('Set-Cookie', buildPortalOidcBindingCookie(flow.bindingCookie, { secure: opts.secureCookie }), { append: true });
  return c.redirect(authorizeUrl, 302);
}

// ============================================
// Callback branch
// ============================================

/** What the shared callback hands this branch: a verified sign-in for the pinned tenant. */
export interface PortalTenantProofCallbackInput {
  cfg: PortalEntraConfig;
  purpose: Extract<PortalOidcPurpose, { kind: 'tenant_proof' }>;
  /** Verified with `expectedTenantId` = the run's pinned tenant. */
  identity: PortalOidcVerifiedIdentity & { entraTenantId: string };
  /** For the Graph admin-role check (OD2 scope). Never logged. */
  accessToken: string | null;
}

/** Test seam (routes/portal/oidc.ts `__testOnly.setEntraDeps`): no network in tests. */
export interface PortalTenantProofDeps {
  graphFetch?: typeof fetch;
}

/**
 * D6 re-authorization of the link's creator at record time: still an `active`
 * user, still a member of the org's partner, and that membership still reaches
 * the org (`all`, or a selection that names it), the authority the link was
 * created with. Partner-axis tables: a fresh system context, outside any held one.
 */
async function creatorStillAuthorized(run: PortalEntraProofRunRecord, partnerId: string): Promise<boolean> {
  const [membership] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ orgAccess: partnerUsers.orgAccess, orgIds: partnerUsers.orgIds })
    .from(partnerUsers)
    .innerJoin(users, eq(users.id, partnerUsers.userId))
    .where(and(
      eq(partnerUsers.userId, run.createdByUserId),
      eq(partnerUsers.partnerId, partnerId),
      eq(users.status, 'active'),
    ))
    .limit(1), 'portalEntraTenantProof.creator'));
  if (!membership) return false;
  const coversOrg = membership.orgAccess === 'all'
    || (membership.orgAccess === 'selected' && (membership.orgIds ?? []).includes(run.orgId));
  if (!coversOrg) return false;
  // The link was created behind requireOrgWrite: the creator's role must still
  // grant it now (a downgrade during the 72 h window kills the link). Fresh
  // read, not the per-process permission cache.
  const perms = await getUserPermissions(run.createdByUserId, { partnerId, scope: 'partner' }, { bypassCache: true });
  return perms !== null && hasPermission(perms, PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
}

/**
 * The `tenant_proof` branch of the callback (plan Task 8, D6). Returns the
 * redirect target: the tenant's admin-consent URL on success, else an
 * `/entra-setup` result. A `PortalEntraProofError` is a `failed`; anything
 * else unexpected propagates to the shared callback (302 `failed`, audited).
 */
export async function handleTenantProofCallback(
  c: Context,
  input: PortalTenantProofCallbackInput,
  deps: PortalTenantProofDeps = {},
): Promise<string> {
  const { cfg, purpose, identity, accessToken } = input;

  const refuse = async (
    status: 'invalid' | 'failed',
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> => {
    console.warn('[portal] Entra tenant proof refused', { reason, orgId: purpose.orgId, ...extra });
    await auditTenantProofRefusal(c, purpose.orgId, reason, extra);
    return entraSetupResult(status);
  };

  // Defence in depth: the id_token check is already pinned to this tenant.
  if (identity.entraTenantId !== purpose.expectedTenantId) return refuse('failed', 'tenant_mismatch');

  // 1. A live admin-role check, bound to the token's principal and tenant.
  //    The run is only peeked so far: a refusal here leaves the link usable.
  if (!accessToken) return refuse('failed', 'no_access_token');
  const adminCheck = await checkMailboxConsentAdminRoleViaGraph(
    accessToken,
    { tid: identity.entraTenantId, oid: identity.subject },
    deps.graphFetch ? { fetch: deps.graphFetch } : {},
  );
  if (!adminCheck.ok) {
    return refuse('failed', 'admin_check_failed', {
      adminCheck: adminCheck.reason,
      ...(adminCheck.status !== undefined ? { status: adminCheck.status } : {}),
    });
  }

  // 2. GET+DEL: of two concurrent callbacks for one run, exactly one goes on.
  const run = await consumePortalEntraProofRunByHash(purpose.runTokenHash);
  if (!run) return refuse('invalid', 'run_unavailable');
  if (run.orgId !== purpose.orgId || run.expectedTenantId !== purpose.expectedTenantId) {
    return refuse('invalid', 'run_mismatch');
  }
  // Re-authorization (D6): the run's authority must still hold at record time.
  const org = await getActiveOrgTenant(run.orgId);
  if (!org || org.partnerId !== run.partnerId) return refuse('invalid', 'org_unavailable');
  if (!(await creatorStillAuthorized(run, org.partnerId))) return refuse('invalid', 'creator_unauthorized');

  // 3. Record. A refusal has already spent the run: the MSP fixes the cause
  //    and creates a new link (D6).
  try {
    await recordEntraTenantProof({
      orgId: run.orgId,
      tenantId: identity.entraTenantId,
      via: 'proof_run',
      evidence: { adminOid: identity.subject, runId: run.runId },
      provenByUserId: run.createdByUserId,
    });
  } catch (error) {
    if (error instanceof PortalEntraProofError) return refuse('failed', 'proof_refused', { code: error.code });
    throw error;
  }

  // 4. The tenant-wide admin consent for the sign-in scopes; its return reads nothing as authority.
  return buildPortalAppAdminConsentUrl(cfg, identity.entraTenantId);
}
