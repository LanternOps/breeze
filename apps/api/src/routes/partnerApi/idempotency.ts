import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { partnerApiIdempotencyKeys } from '../../db/schema';
import type { PartnerApiPrincipalContext } from '../../middleware/partnerApiAuth';
import { canonicalJsonStringify } from './exportSafety';

/**
 * `X-Idempotency-Key` for resource-creating Partner API ticket writes, backed
 * by `partner_api_idempotency_keys` (migration 2026-12-18-100000; design doc
 * §4.3).
 *
 * Protocol (same as the enrollment-key mint, generalised by `route` and bound
 * to the ticket the claim guards):
 *   1. `validateIdempotencyHeader` — 1..128 printable ASCII, or absent.
 *   2. The caller AUTHORIZES first (org membership for a create, the
 *      partner-bound ticket lookup for a comment) before any claim state is
 *      read, so a key cannot probe for existence.
 *   3. `requestFingerprint` = sha256(canonical JSON { route, ticketId, body }):
 *      `ticketId` is the path ticket for `tickets.comment` and null for
 *      `tickets.create`, so the same body replayed against ANOTHER ticket is a
 *      mismatch, never a silent replay of the first ticket's comment.
 *   4. `findIdempotencyReplay` BEFORE the write: a claim with the same
 *      fingerprint answers the retry from its linked resource; a different
 *      fingerprint is a 409 (the key was reused with another request).
 *   5. `claimIdempotency` inside the write's own bounded context, BEFORE the
 *      resource insert, so claim + resource commit together. A lost race on
 *      the unique index returns null. ON CONFLICT DO NOTHING has waited for
 *      the holder to finish by then, so the caller looks the key up again
 *      and answers from the committed holder; a holder that stays invisible
 *      is hidden by RLS (its ticket left the principal's organizations).
 *   6. `linkIdempotencyResource` with the created id (and, for a create, the
 *      new ticket id), same transaction.
 *
 * There is no "claim without a resource" state a later request can observe:
 * the claim only becomes visible once the transaction that also linked it has
 * committed. Finding one is an invariant violation and surfaces as a 500.
 *
 * Every function here runs inside the caller's partner-scoped context; the
 * table is org-scoped (shape 1), so the claim is only visible to a principal
 * that can reach the org it was made for.
 */
export type PartnerApiIdempotencyRoute = 'tickets.create' | 'tickets.comment';

export const IDEMPOTENCY_HEADER = 'X-Idempotency-Key';

export type IdempotencyHeaderResult =
  | { ok: true; key: string | null }
  | { ok: false; response: Response };

export function validateIdempotencyHeader(c: Context, code: string): IdempotencyHeaderResult {
  const header = c.req.header(IDEMPOTENCY_HEADER);
  if (header === undefined) return { ok: true, key: null };
  // Validate before any Redis or database I/O: the value is persisted in a
  // bounded varchar and participates in a unique index.
  if (header.length === 0 || header.length > 128 || !/^[\x20-\x7E]+$/.test(header)) {
    return {
      ok: false,
      response: c.json({ error: `${IDEMPOTENCY_HEADER} must be 1-128 printable ASCII characters.`, code }, 400),
    };
  }
  return { ok: true, key: header };
}

/**
 * Key-order independent digest of the validated body, so a client that
 * serialises the same request differently still replays rather than 409s.
 * The route and the target ticket are folded in so one key cannot answer for
 * another route or another ticket. The body is JSON round-tripped first: zod
 * coerces `dueDate` to a `Date`, and `canonicalJsonStringify` refuses
 * non-plain objects.
 */
export function requestFingerprint(route: PartnerApiIdempotencyRoute, ticketId: string | null, body: unknown): string {
  const plain = JSON.parse(JSON.stringify(body ?? null)) as unknown;
  return createHash('sha256').update(canonicalJsonStringify({ route, ticketId, body: plain }), 'utf8').digest('hex');
}

export type IdempotencyReplay =
  | { kind: 'none' }
  | { kind: 'mismatch' }
  | { kind: 'replay'; resourceId: string };

export async function findIdempotencyReplay(
  principal: PartnerApiPrincipalContext,
  route: PartnerApiIdempotencyRoute,
  key: string,
  fingerprint: string,
): Promise<IdempotencyReplay> {
  const [claim] = await db
    .select({
      id: partnerApiIdempotencyKeys.id,
      requestFingerprint: partnerApiIdempotencyKeys.requestFingerprint,
      resourceId: partnerApiIdempotencyKeys.resourceId,
    })
    .from(partnerApiIdempotencyKeys)
    .where(and(
      eq(partnerApiIdempotencyKeys.partnerServicePrincipalId, principal.partnerServicePrincipalId),
      eq(partnerApiIdempotencyKeys.route, route),
      eq(partnerApiIdempotencyKeys.idempotencyKey, key),
    ))
    .limit(1);
  if (!claim) return { kind: 'none' };
  if (claim.requestFingerprint !== fingerprint) return { kind: 'mismatch' };
  if (!claim.resourceId) {
    // Claim and link commit together, so a committed claim always names its
    // resource. Not a client-recoverable state: fail loudly rather than
    // create a second resource or pretend the first is still in flight.
    throw new Error(`partner API idempotency claim ${claim.id} is committed without a resource`);
  }
  return { kind: 'replay', resourceId: claim.resourceId };
}

/** Returns the claim id, or null when another request holds this key (lost race). */
export async function claimIdempotency(input: {
  principal: PartnerApiPrincipalContext;
  orgId: string;
  /** The ticket the claim guards — the path ticket for a comment; null until the create links it. */
  ticketId: string | null;
  route: PartnerApiIdempotencyRoute;
  key: string;
  fingerprint: string;
}): Promise<{ id: string } | null> {
  const [claim] = await db
    .insert(partnerApiIdempotencyKeys)
    .values({
      partnerId: input.principal.partnerId,
      partnerServicePrincipalId: input.principal.partnerServicePrincipalId,
      orgId: input.orgId,
      ticketId: input.ticketId,
      route: input.route,
      idempotencyKey: input.key,
      requestFingerprint: input.fingerprint,
    })
    .onConflictDoNothing()
    .returning({ id: partnerApiIdempotencyKeys.id });
  return claim ?? null;
}

/**
 * Bind the claim to what the write created. `ticketId` is passed by the
 * create route (the claim was made before the ticket existed); the comment
 * route set it at claim time.
 */
export async function linkIdempotencyResource(claimId: string, resourceId: string, ticketId?: string): Promise<void> {
  const [linked] = await db
    .update(partnerApiIdempotencyKeys)
    .set({ resourceId, ...(ticketId ? { ticketId } : {}) })
    .where(eq(partnerApiIdempotencyKeys.id, claimId))
    .returning({ id: partnerApiIdempotencyKeys.id });
  if (!linked) throw new Error('idempotency claim link failed');
}
