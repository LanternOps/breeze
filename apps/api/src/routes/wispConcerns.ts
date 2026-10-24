/**
 * Wisp W05a — concern routes (Wisp design §7.1–7.4; w00 "Routes (final
 * names)", A1). Mounted by W02's hub as `wispRoutes.route('/concerns', …)`,
 * i.e. /api/v1/wisp/concerns.
 *
 *   GET  /?grantId&status=open,snoozed&orgId → { concerns: Concern[] }
 *   GET  /:id?grantId                        → { concern: Concern }        (W06 deep links)
 *   POST /:id/snooze  { grantId, until }     → { success: true }
 *   POST /:id/dismiss { grantId }            → { success: true }
 *   POST /:id/resolve { grantId, outcome }   → { success: true }
 *
 * GATES are inherited from the hub's `use('*')` chain (auth → 404 while
 * !wispEnabled() → partner scope → ai_sessions:use → requireEntitlement
 * ('wisp')); they are not re-declared here, so this router must only ever be
 * mounted under `wispRoutes` (pinned by routes/wisp.entitlement.contract.test.ts).
 *
 * GRANT ACCESS. `grantId` names the caller's recipient row. The grant is read
 * in system context pinned to the caller's partner; reads accept the caller's
 * own grant or — partner-admin read of a colleague's grant, w00 A1 — any
 * grant when `canManagePartnerWidePolicies(auth)`. Mutations (snooze /
 * dismiss: personal state; resolve: the caller acting as a recipient) require
 * the caller to OWN the grant. Every other case — another partner's grant, a
 * missing one, a non-uuid id — is the same existence-neutral 404.
 *
 * CEILING. Every route resolves the grant's live ceiling (409 grant_inactive
 * when paused / revoked / expired / unpinned) and reads concerns only through
 * `listConcernsForCeiling` / `getConcernForCeiling`. A mutation first reads
 * the concern under the ceiling: one outside it is indistinguishable from a
 * missing one (404) and the service is never called.
 */
import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  concernGrantQuerySchema,
  dismissBodySchema,
  listConcernsQuerySchema,
  resolveBodySchema,
  snoozeBodySchema,
} from '@breeze/shared';
import { db } from '../db';
import { wispGrants } from '../db/schema/wisp';
import { zValidator } from '../lib/validation';
import type { AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import { captureException } from '../services/sentry';
import {
  ConcernNotFoundError,
  dismissConcern,
  getConcernForCeiling,
  listConcernsForCeiling,
  markAnswered,
  resolveConcern,
  snoozeConcern,
  type Concern,
} from '../services/wisp/concerns';
import {
  CeilingViolationError,
  GrantInactiveError,
  inSystemContext,
  resolveGrantCeiling,
  type GrantCeiling,
} from '../services/wisp/grantAuthority';

// ---------------------------------------------------------------------------
// Shared with routes/wispWatches.ts: grant access, ceiling, error shapes
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();

export const WISP_NOT_FOUND = { error: 'Not found', code: 'not_found' } as const;

type ErrorStatus = 403 | 404 | 409 | 500;
export const wispFail = (c: Context, status: ErrorStatus, code: string, error: string) => c.json({ error, code }, status);

export const authOf = (c: Context): AuthContext => c.get('auth') as AuthContext;

/** A non-uuid path id is a 404, never a 22P02 from Postgres. */
export function pathId(c: Context): string | null {
  const parsed = uuid.safeParse(c.req.param('id'));
  return parsed.success ? parsed.data : null;
}

/** `owner`: the caller is the grantor. `reader`: the grantor, or a partner-wide admin (w00 A1). */
export type GrantAccess = 'owner' | 'reader';

export type RouteGrant = { id: string; partnerId: string; grantorUserId: string; currentRevisionId: string | null };

export type GrantCeilingOutcome =
  | { ok: true; grant: RouteGrant; ceiling: GrantCeiling }
  | { ok: false; response: Response };

/**
 * Load `grantId` (system context, pinned to the caller's partner), check the
 * caller's access to it and resolve its live ceiling. Every refusal is a
 * ready response; unexpected errors propagate.
 */
export async function grantCeilingFor(c: Context, grantId: string, access: GrantAccess): Promise<GrantCeilingOutcome> {
  const auth = authOf(c);
  const partnerId = auth.partnerId;
  // The hub's requireScope('partner') guarantees it; re-asserted as a belt.
  if (!partnerId) throw new Error('wisp concern/watch routes reached without a partner (hub gates bypassed?)');

  const [grant] = await inSystemContext(() =>
    db
      .select({
        id: wispGrants.id,
        partnerId: wispGrants.partnerId,
        grantorUserId: wispGrants.grantorUserId,
        currentRevisionId: wispGrants.currentRevisionId,
      })
      .from(wispGrants)
      .where(and(eq(wispGrants.id, grantId), eq(wispGrants.partnerId, partnerId)))
      .limit(1),
  );
  const own = grant?.grantorUserId === auth.user.id;
  if (!grant || !(own || (access === 'reader' && canManagePartnerWidePolicies(auth)))) {
    return { ok: false, response: c.json(WISP_NOT_FOUND, 404) };
  }
  if (!grant.currentRevisionId) return { ok: false, response: grantInactive(c) };
  try {
    return { ok: true, grant, ceiling: await resolveGrantCeiling(grant.id, grant.currentRevisionId) };
  } catch (err) {
    return { ok: false, response: grantErrorResponse(c, err) };
  }
}

const grantInactive = (c: Context) => wispFail(c, 409, 'grant_inactive', 'This Wisp delegation is not active');

/**
 * Grant / ceiling errors → HTTP; anything else rethrows. A `corrupt` pin is
 * data damage (grantAuthority's contract): logged and captured, then 500.
 * An org outside the ceiling reads as absent (non-enumerating 404).
 */
export function grantErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof GrantInactiveError) {
    if (err.kind !== 'corrupt') return grantInactive(c);
    console.error(`[WispConcerns] grant ${err.grantId} has a corrupt ceiling pin: ${err.message}`);
    captureException(err, undefined, { grantId: err.grantId });
    return wispFail(c, 500, 'grant_corrupt', "This Wisp grant can't be used. Turn Wisp off and on again.");
  }
  if (err instanceof CeilingViolationError) {
    if (err.code === 'inactive') return grantInactive(c);
    if (err.code === 'org') return wispFail(c, 404, 'org_out_of_reach', 'Organization not found');
    // site / permission / tool: the grant exists and is the caller's own; say
    // which restriction refused it instead of pretending the org is missing.
    return wispFail(c, 403, 'outside_ceiling', `This Wisp delegation does not cover that (${err.code} restriction)`);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const wispConcernsRoutes = new Hono();

wispConcernsRoutes.get('/', zValidator('query', listConcernsQuerySchema), async (c) => {
  const { grantId, status, orgId } = c.req.valid('query');
  const access = await grantCeilingFor(c, grantId, 'reader');
  if (!access.ok) return access.response;
  const concerns = await listConcernsForCeiling(access.ceiling, { status, orgId });
  return c.json({ concerns });
});

wispConcernsRoutes.get('/:id', zValidator('query', concernGrantQuerySchema), async (c) => {
  const id = pathId(c);
  if (!id) return c.json(WISP_NOT_FOUND, 404);
  const access = await grantCeilingFor(c, c.req.valid('query').grantId, 'reader');
  if (!access.ok) return access.response;
  const concern = await getConcernForCeiling(access.ceiling, id);
  if (!concern) return c.json(WISP_NOT_FOUND, 404);
  return c.json({ concern });
});

type Mutation = 'snoozed' | 'dismissed' | 'resolved';

/**
 * Shared spine of the three mutations: own grant → live ceiling → the concern
 * visible under it → `apply` → `markAnswered` → audit. A concern deleted
 * between the read and the write (ConcernNotFoundError) is a 404.
 */
async function mutateConcern(
  c: Context,
  grantId: string,
  verb: Mutation,
  apply: (concern: Concern, userId: string) => Promise<unknown>,
  details: Record<string, unknown> = {},
): Promise<Response> {
  const id = pathId(c);
  if (!id) return c.json(WISP_NOT_FOUND, 404);
  const access = await grantCeilingFor(c, grantId, 'owner');
  if (!access.ok) return access.response;
  const concern = await getConcernForCeiling(access.ceiling, id);
  if (!concern) return c.json(WISP_NOT_FOUND, 404);
  // Snooze / dismiss / resolve act on a live concern only; a closed one would
  // write a recipient row and an audit entry for a change that never happens.
  if (concern.status !== 'open' && concern.status !== 'snoozed') {
    return wispFail(c, 409, 'concern_not_live', `This concern is already ${concern.status}`);
  }

  const userId = authOf(c).user.id;
  try {
    await apply(concern, userId);
    await markAnswered(concern.id, access.grant.id, new Date());
  } catch (err) {
    if (err instanceof ConcernNotFoundError) return c.json(WISP_NOT_FOUND, 404);
    throw err;
  }

  writeRouteAudit(c, {
    orgId: concern.orgId,
    partnerId: concern.partnerId,
    action: `wisp.concern.${verb}`,
    resourceType: 'wisp_concern',
    resourceId: concern.id,
    details: { grantId: access.grant.id, ...details },
  });
  return c.json({ success: true });
}

wispConcernsRoutes.post('/:id/snooze', zValidator('json', snoozeBodySchema), async (c) => {
  const { grantId, until } = c.req.valid('json');
  return mutateConcern(c, grantId, 'snoozed', (concern, userId) =>
    snoozeConcern(concern.id, { grantId, userId }, new Date(until)), { until });
});

wispConcernsRoutes.post('/:id/dismiss', zValidator('json', dismissBodySchema), async (c) => {
  const { grantId } = c.req.valid('json');
  return mutateConcern(c, grantId, 'dismissed', (concern, userId) =>
    dismissConcern(concern.id, { grantId, userId }));
});

// Resolving closes the SHARED fact for every recipient (spec §7.3): any grant
// holder whose ceiling covers the concern's org may do it. `grantId` is not
// passed to the service, so a person's resolution is not remembered as a
// Wisp-authored `concern_outcome` memory block.
wispConcernsRoutes.post('/:id/resolve', zValidator('json', resolveBodySchema), async (c) => {
  const { grantId, outcome } = c.req.valid('json');
  return mutateConcern(c, grantId, 'resolved', (concern, userId) =>
    resolveConcern(concern.id, { userId }, outcome));
});
