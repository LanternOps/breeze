import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  assignTicketSchema,
  changeTicketStatusBaseSchema,
  createTicketBaseSchema,
  externalTicketIdSchema,
  externalTicketUrlSchema,
  refineChangeTicketStatus,
  updateTicketSchema,
} from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { ticketComments } from '../../db/schema';
import { requirePartnerApiScope, type PartnerApiPrincipalContext } from '../../middleware/partnerApiAuth';
import {
  addTicketComment,
  assignTicket,
  changeTicketStatus,
  createTicket,
  TicketServiceError,
  updateTicketFields,
  type TicketActor,
} from '../../services/ticketService';
import {
  clearTicketExternalRef,
  TicketExternalRefConflictError,
  ticketExternalRefsFor,
  upsertTicketExternalRef,
  type TicketExternalRef,
} from '../../services/ticketExternalRefs';
import { inPartnerContext } from './dbContext';
import { safelyExportDefinition } from './exportSafety';
import {
  claimIdempotency,
  findIdempotencyReplay,
  linkIdempotencyResource,
  requestFingerprint,
  validateIdempotencyHeader,
  type IdempotencyReplay,
  type PartnerApiIdempotencyRoute,
} from './idempotency';
import { partnerTicketCommentWriteResponseSchema, partnerTicketWriteResponseSchema } from './schemas';
import {
  getPartnerTicketOr404,
  ticketRowFromRecord,
  toPartnerTicketCommentRecord,
  toPartnerTicketRecord,
  type TicketRow,
} from './tickets';

/**
 * Partner API tickets surface, write side (tickets:write).
 *
 *   POST  /tickets                 create (X-Idempotency-Key)
 *   PATCH /tickets/:id             field updates (not status/assignee)
 *   POST  /tickets/:id/status      status transition
 *   POST  /tickets/:id/assign      assignee
 *   POST  /tickets/:id/comments    comment or internal note (X-Idempotency-Key)
 *
 * Every write goes through `ticketService` — the same functions the staff
 * routes call — with a `'service_principal'` actor: the principal acts as
 * ITSELF, identified by the PRINCIPAL id (feed rows and audit rows name the
 * principal, users(id) FK columns are null), never as the human who minted
 * the key. The service performs the cross-entity tenancy checks (device/
 * contact/portal user in the ticket's org, assignee and category in the
 * partner) and writes the domain audit row (`ticket.*`, actor_type
 * 'api_key'); the auth middleware writes the surface-level
 * `partner_api.request` row. No further audit here.
 *
 * External correlation is namespaced by principal (`ticket_external_refs`):
 * `externalTicketId`/`externalTicketUrl` on create and PATCH write THIS
 * principal's ref, never the legacy `tickets.external_ticket_id` columns.
 *
 * Deliberately NOT offered: delete/restore, move-org, bulk actions,
 * attachments, time entries and parts, AI drafts, mailbox, comment edit/
 * delete. Those stay human, MFA-gated actions on the main API.
 *
 * Execution model matches provisioning/contracts: non-GET has no ambient DB
 * context, so each handler opens its own partner-scoped context
 * (`inPartnerContext`). Everything inside it — idempotency claim, resource
 * insert, external ref, claim link — commits or rolls back together.
 */
export const partnerTicketWriteRoutes = new Hono();

const writeScope = requirePartnerApiScope('tickets:write');
const idParam = z.object({ id: z.string().uuid() });

// Free text from a machine must not smuggle control characters into feeds,
// notification emails or CSV exports; newlines and tabs stay allowed.
const NO_CONTROL_CHARS = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/u;
const text = (max: number) => z.string().max(max).regex(NO_CONTROL_CHARS, 'control characters are not allowed');

/**
 * Create: the staff schema minus the intake form (a human's composer) and the
 * portal login (`submittedBy`); `subject` is therefore always required. The
 * requester CONTACT and the free-text name/email snapshot stay, as does
 * `assigneeId` (the service enforces same-partner eligibility). `source` is
 * never accepted — it is fixed to 'api'. The external ref fields are this
 * surface's own (the staff schemas do not take them).
 */
export const partnerCreateTicketSchema = createTicketBaseSchema
  .omit({ formId: true, formResponses: true, submittedBy: true })
  .extend({
    subject: text(255).trim().min(1),
    description: text(50_000).optional(),
    externalTicketId: externalTicketIdSchema.optional(),
    externalTicketUrl: externalTicketUrlSchema.optional(),
  })
  .strict();

/** Update: never the portal login nor the SLA targets (a human, MFA-gated decision). */
export const partnerUpdateTicketSchema = updateTicketSchema
  .omit({ submittedBy: true, responseSlaMinutes: true, resolutionSlaMinutes: true })
  .extend({
    subject: text(255).trim().min(1).optional(),
    description: text(50_000).optional(),
    // null clears this principal's ref; a url alone re-points an existing ref's url.
    externalTicketId: externalTicketIdSchema.nullable().optional(),
    externalTicketUrl: externalTicketUrlSchema.nullable().optional(),
  })
  .strict();

/** Status: the shared coherence rules, without a technician's AI draft. */
export const partnerChangeTicketStatusSchema = changeTicketStatusBaseSchema
  .omit({ aiDraftId: true })
  .strict()
  .superRefine(refineChangeTicketStatus);

export const partnerAssignTicketSchema = assignTicketSchema.strict();

/**
 * Comment: `isPublic` is REQUIRED, with no default. A PSA mirroring technician
 * notes wants `false`; a customer-side system wants `true`, and a public
 * comment emails the requester — the caller must choose. No attachments.
 */
export const partnerAddTicketCommentSchema = z.object({
  content: text(50_000).trim().min(1),
  isPublic: z.boolean(),
}).strict();

/** The service returns `updated[0]`; a missing row after a successful write is a bug, not a 404. */
function requireRow<T>(row: T | undefined): T {
  if (row === undefined) throw new TicketServiceError('Ticket write returned no row', 500);
  return row;
}

/** The principal acts as itself: identified by the principal id, stable across key rotations. */
function actorFrom(principal: PartnerApiPrincipalContext): TicketActor {
  return {
    kind: 'service_principal',
    principalId: principal.partnerServicePrincipalId,
    keyId: principal.keyId,
    name: principal.name,
  };
}

type Json = { json: (body: unknown, status: number) => Response };

function handleTicketError(c: Json, err: unknown): Response {
  if (err instanceof TicketServiceError) {
    return c.json({
      error: err.message,
      code: err.code ?? 'partner_tickets_error',
      ...(err.details ? { details: err.details } : {}),
    }, err.status);
  }
  if (err instanceof TicketExternalRefConflictError) {
    return c.json({ error: err.message, code: err.code, details: err.details }, err.status);
  }
  throw err;
}

function orgDenied(c: Json): Response {
  return c.json({ error: 'Access to this organization denied.', code: 'partner_tickets_org_access_denied' }, 403);
}

function notFound(c: Json): Response {
  return c.json({ error: 'Ticket not found.', code: 'partner_ticket_not_found' }, 404);
}

const IDEMPOTENCY_CODES = {
  invalid: 'partner_tickets_invalid_idempotency_key',
  reused: 'partner_tickets_idempotency_key_reused',
} as const;

function idempotencyKeyReused(c: Json): Response {
  return c.json({ error: 'X-Idempotency-Key was already used with a different request.', code: IDEMPOTENCY_CODES.reused }, 409);
}

type TicketWithRef = { row: TicketRow; ref: TicketExternalRef | null };

function ticketResponse(c: Context, value: TicketWithRef, status: 200 | 201, replay = false): Response {
  const record = toPartnerTicketRecord(value.row, value.ref);
  const inspected = safelyExportDefinition({ resource: 'tickets' as const, id: record.id, orgId: record.orgId }, record);
  return c.json(partnerTicketWriteResponseSchema.parse({
    schemaVersion: '1',
    id: record.id,
    orgId: record.orgId,
    data: inspected.safe ? inspected.definition : null,
    ...(inspected.safe ? {} : { blocked: [inspected.blocked] }),
    ...(replay ? { idempotencyReplay: true } : {}),
  }), status);
}

function commentResponse(
  c: Context,
  row: typeof ticketComments.$inferSelect,
  orgId: string,
  status: 200 | 201,
  replay = false,
): Response {
  const record = toPartnerTicketCommentRecord(row, orgId);
  const inspected = safelyExportDefinition({ resource: 'tickets' as const, id: record.id, orgId }, record);
  return c.json(partnerTicketCommentWriteResponseSchema.parse({
    schemaVersion: '1',
    id: record.id,
    ticketId: record.ticketId,
    orgId,
    data: inspected.safe ? inspected.definition : null,
    ...(inspected.safe ? {} : { blocked: [inspected.blocked] }),
    ...(replay ? { idempotencyReplay: true } : {}),
  }), status);
}

/** This principal's ref for one ticket, in the caller's context. */
async function refFor(principal: PartnerApiPrincipalContext, ticketId: string): Promise<TicketExternalRef | null> {
  return (await ticketExternalRefsFor(principal.partnerServicePrincipalId, [ticketId])).get(ticketId) ?? null;
}

/**
 * Runs `create` under an idempotency claim when the caller sent a key. Must
 * be called INSIDE the partner context: the replay lookup, the claim, the
 * create and the link share that context's transaction. `ticketId` is the
 * path ticket the claim guards (null for a create — linked afterwards).
 */
async function withIdempotency<T>(
  principal: PartnerApiPrincipalContext,
  route: PartnerApiIdempotencyRoute,
  key: string | null,
  target: { orgId: string; ticketId: string | null },
  fingerprint: string,
  load: (resourceId: string) => Promise<T | null>,
  create: () => Promise<{ id: string; ticketId: string; value: T }>,
): Promise<{ kind: 'created' | 'replay'; value: T } | { kind: 'mismatch' | 'gone' }> {
  if (!key) return { kind: 'created', value: (await create()).value };
  const answerFrom = async (
    found: Exclude<IdempotencyReplay, { kind: 'none' }>,
  ): Promise<{ kind: 'replay'; value: T } | { kind: 'mismatch' | 'gone' }> => {
    if (found.kind === 'mismatch') return { kind: 'mismatch' };
    // Re-read through the partner-bound lookup: the resource may have been
    // soft-deleted or moved out of the principal's set since it was created.
    const value = await load(found.resourceId);
    return value === null ? { kind: 'gone' } : { kind: 'replay', value };
  };
  const replay = await findIdempotencyReplay(principal, route, key, fingerprint);
  if (replay.kind !== 'none') return answerFrom(replay);
  const claim = await claimIdempotency({ principal, orgId: target.orgId, ticketId: target.ticketId, route, key, fingerprint });
  if (!claim) {
    // The key is taken. ON CONFLICT DO NOTHING waits for a concurrent holder
    // to finish, so the holder has committed by now, and this READ COMMITTED
    // read sees it: answer the retry from it directly.
    const holder = await findIdempotencyReplay(principal, route, key, fingerprint);
    if (holder.kind !== 'none') return answerFrom(holder);
    // Still invisible: RLS hides the holder because its ticket has left this
    // principal's organizations, and no retry can change that. Say what is
    // true rather than "in flight" until retention reaps the row (#8235
    // review). A create retry is asking for that ticket: 404, like a replay
    // whose ticket moved out. A comment was authorized against an accessible
    // path ticket, so a hidden holder guards ANOTHER ticket: the key was reused.
    return { kind: target.ticketId ? 'mismatch' : 'gone' };
  }
  const created = await create();
  await linkIdempotencyResource(claim.id, created.id, target.ticketId ? undefined : created.ticketId);
  return { kind: 'created', value: created.value };
}

partnerTicketWriteRoutes.post(
  '/tickets',
  writeScope,
  zValidator('json', partnerCreateTicketSchema),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const { externalTicketId, externalTicketUrl, ...input } = c.req.valid('json');
    if (!principal.accessibleOrgIds.includes(input.orgId)) return orgDenied(c);
    const header = validateIdempotencyHeader(c, IDEMPOTENCY_CODES.invalid);
    if (!header.ok) return header.response;
    const route = 'tickets.create';
    const fingerprint = header.key ? requestFingerprint(route, null, c.req.valid('json')) : '';
    try {
      const outcome = await inPartnerContext(principal, () => withIdempotency<TicketWithRef>(
        principal, route, header.key, { orgId: input.orgId, ticketId: null }, fingerprint,
        async (resourceId) => {
          const row = await getPartnerTicketOr404(principal, resourceId);
          return row ? { row, ref: await refFor(principal, resourceId) } : null;
        },
        async () => {
          const ticket = await createTicket({ ...input, source: 'api' }, actorFrom(principal));
          // Same transaction as the create: a 409 on the external id rolls
          // the ticket back too, so a conflict never leaves a duplicate.
          const ref = externalTicketId
            ? await upsertTicketExternalRef({
              principalId: principal.partnerServicePrincipalId,
              partnerId: principal.partnerId,
              ticketId: ticket.id,
              externalId: externalTicketId,
              externalUrl: externalTicketUrl ?? null,
            })
            : null;
          return { id: ticket.id, ticketId: ticket.id, value: { row: ticketRowFromRecord(ticket), ref } };
        },
      ));
      if (outcome.kind === 'created') return ticketResponse(c, outcome.value, 201);
      if (outcome.kind === 'replay') return ticketResponse(c, outcome.value, 200, true);
      if (outcome.kind === 'gone') return notFound(c);
      return idempotencyKeyReused(c);
    } catch (err) {
      return handleTicketError(c, err);
    }
  },
);

partnerTicketWriteRoutes.patch(
  '/tickets/:id',
  writeScope,
  zValidator('param', idParam),
  zValidator('json', partnerUpdateTicketSchema),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const { id } = c.req.valid('param');
    const { externalTicketId, externalTicketUrl, ...fields } = c.req.valid('json');
    const hasFields = Object.keys(fields).length > 0;
    const hasRef = externalTicketId !== undefined || externalTicketUrl !== undefined;
    if (!hasFields && !hasRef) {
      return c.json({ error: 'No fields to update.', code: 'partner_tickets_no_fields' }, 400);
    }
    try {
      const result = await inPartnerContext(principal, async (): Promise<TicketWithRef | 'not_found' | 'url_without_id'> => {
        const found = await getPartnerTicketOr404(principal, id);
        if (!found) return 'not_found';
        const row = hasFields
          ? ticketRowFromRecord(requireRow(await updateTicketFields(id, fields, actorFrom(principal))))
          : found;
        const existing = await refFor(principal, id);
        if (externalTicketId === null) {
          await clearTicketExternalRef(principal.partnerServicePrincipalId, id);
          return { row, ref: null };
        }
        if (externalTicketId === undefined && externalTicketUrl === undefined) return { row, ref: existing };
        // Re-point (or create) this principal's ref; a url alone updates the
        // url of the ref that already exists.
        const externalId = externalTicketId ?? existing?.externalId;
        if (!externalId) return 'url_without_id';
        const ref = await upsertTicketExternalRef({
          principalId: principal.partnerServicePrincipalId,
          partnerId: principal.partnerId,
          ticketId: id,
          externalId,
          externalUrl: externalTicketUrl !== undefined ? externalTicketUrl : (existing?.externalUrl ?? null),
        });
        return { row, ref };
      });
      if (result === 'not_found') return notFound(c);
      if (result === 'url_without_id') {
        return c.json({
          error: 'externalTicketUrl needs an externalTicketId (in this request or already set for this integration).',
          code: 'partner_tickets_external_url_without_id',
        }, 400);
      }
      return ticketResponse(c, result, 200);
    } catch (err) {
      return handleTicketError(c, err);
    }
  },
);

partnerTicketWriteRoutes.post(
  '/tickets/:id/status',
  writeScope,
  zValidator('param', idParam),
  zValidator('json', partnerChangeTicketStatusSchema),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const value = await inPartnerContext(principal, async (): Promise<TicketWithRef | null> => {
        const found = await getPartnerTicketOr404(principal, id);
        if (!found) return null;
        const updated = await changeTicketStatus(
          id,
          { status: body.status, statusId: body.statusId },
          { resolutionNote: body.resolutionNote, pendingReason: body.pendingReason },
          actorFrom(principal),
        );
        return { row: ticketRowFromRecord(requireRow(updated)), ref: await refFor(principal, id) };
      });
      if (!value) return notFound(c);
      return ticketResponse(c, value, 200);
    } catch (err) {
      return handleTicketError(c, err);
    }
  },
);

partnerTicketWriteRoutes.post(
  '/tickets/:id/assign',
  writeScope,
  zValidator('param', idParam),
  zValidator('json', partnerAssignTicketSchema),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const value = await inPartnerContext(principal, async (): Promise<TicketWithRef | null> => {
        const found = await getPartnerTicketOr404(principal, id);
        if (!found) return null;
        const updated = await assignTicket(id, body.assigneeId, actorFrom(principal));
        return { row: ticketRowFromRecord(requireRow(updated)), ref: await refFor(principal, id) };
      });
      if (!value) return notFound(c);
      return ticketResponse(c, value, 200);
    } catch (err) {
      return handleTicketError(c, err);
    }
  },
);

partnerTicketWriteRoutes.post(
  '/tickets/:id/comments',
  writeScope,
  zValidator('param', idParam),
  zValidator('json', partnerAddTicketCommentSchema),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const header = validateIdempotencyHeader(c, IDEMPOTENCY_CODES.invalid);
    if (!header.ok) return header.response;
    const route = 'tickets.comment';
    const fingerprint = header.key ? requestFingerprint(route, id, body) : '';
    try {
      const result = await inPartnerContext(principal, async () => {
        // Authorization first: an unknown or foreign ticket is a 404 before
        // any idempotency state is read, so a key cannot probe for existence.
        const found = await getPartnerTicketOr404(principal, id);
        if (!found) return null;
        const orgId = found.orgId!;
        const outcome = await withIdempotency(
          principal, route, header.key, { orgId, ticketId: id }, fingerprint,
          async (resourceId) => {
            const [row] = await db.select().from(ticketComments).where(eq(ticketComments.id, resourceId)).limit(1);
            if (row && row.ticketId !== id) {
              // The claim is bound to the path ticket and the fingerprint
              // includes it: a linked comment on another ticket is corrupt state.
              throw new Error(`partner API idempotency claim for ticket ${id} names a comment of ticket ${row.ticketId}`);
            }
            return row ?? null;
          },
          async () => {
            const { comment } = await addTicketComment(id, { content: body.content, isPublic: body.isPublic }, actorFrom(principal));
            return { id: comment.id, ticketId: id, value: comment };
          },
        );
        return { orgId, outcome };
      });
      if (!result) return notFound(c);
      const { orgId, outcome } = result;
      if (outcome.kind === 'created') return commentResponse(c, outcome.value, orgId, 201);
      if (outcome.kind === 'replay') return commentResponse(c, outcome.value, orgId, 200, true);
      if (outcome.kind === 'gone') return notFound(c);
      return idempotencyKeyReused(c);
    } catch (err) {
      return handleTicketError(c, err);
    }
  },
);
