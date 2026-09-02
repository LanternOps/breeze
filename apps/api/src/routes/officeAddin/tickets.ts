import { and, eq, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { db } from '../../db';
import { partners, tickets } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { officeAddinTechAuthMiddleware, requireAddinCapability } from '../../middleware/officeAddinTechAuth';
import { recordUsage } from '../../services/aiCostTracker';
import { writeAuditEvent } from '../../services/auditEvents';
import { applyDlp } from '../../services/clientAiDlp';
import { getOrgPolicy } from '../../services/clientAiPolicy';
import { ticketThreadAnchor } from '../../services/inboundEmail/outboundThreading';
import { insertEmailAuthoredComment } from '../../services/inboundEmail/emailComments';
import { createConfirmedContact, findPortalUserByEmail } from '../../services/officeAddin/addinContacts';
import { draftTicketFromEmail, EmailDraftFailedError } from '../../services/officeAddin/aiEmailDraft';
import {
  getAnthropicClientForPartner,
  LlmUnavailableError,
  resolveWireModel,
} from '../../services/llm/llmConfigResolver';
import { claimMessageLink, findLinkByMessageId, normalizeMessageId } from '../../services/ticketEmailLinks';
import {
  addTicketComment,
  createTicket,
  getPortalUserForValidation,
  TicketServiceError,
  toAddinTicketSummary,
  type AddinTicketSummary,
  type TicketActor,
} from '../../services/ticketService';
import type { OfficeAddinTechAuth } from '../../middleware/officeAddinTechAuth';
import { draftSchema, fromEmailSchema, linkEmailSchema } from './schemas';

/**
 * Outlook tech add-in ticket creation (spec §3.2, Task 16).
 *
 * ONE message-id, ONE ticket — across BOTH channels. The add-in and the inbound
 * poller both claim the RFC 5322 Message-ID in `ticket_email_links`, whose
 * (partner_id, message_id) unique index is the only arbiter. Everything else in
 * this file exists to make the loser of that race leave no trace.
 *
 * TRANSACTION SHAPE (the load-bearing part):
 *   The whole handler already runs inside the tech middleware's
 *   `withDbAccessContext`, i.e. ONE open transaction. `claimMessageLink` uses
 *   `onConflictDoNothing`, so losing the race raises NO database error — the
 *   transaction is perfectly healthy and a plain try/catch could not undo the
 *   ticket we just inserted.
 *
 *   So the create+stamp+claim sequence runs inside a NESTED `db.transaction(...)`.
 *   Under drizzle's postgres-js driver a nested transaction is a SAVEPOINT
 *   (PostgresJsTransaction.transaction -> session.client.savepoint), so throwing
 *   `MessageClaimRaceError` out of that callback emits ROLLBACK TO SAVEPOINT,
 *   while the enclosing request transaction stays alive and usable.
 *   The statements inside the callback are issued through the ambient `db`
 *   proxy (which resolves to the OUTER transaction) rather than the savepoint's
 *   own `tx` handle — that is deliberate and correct: a savepoint is a
 *   connection-level marker, and both objects drive the same reserved
 *   connection, so everything between SAVEPOINT and ROLLBACK TO SAVEPOINT is
 *   undone regardless of which handle issued it. Routing through the ambient
 *   proxy is also what keeps the RLS GUCs (set with SET LOCAL on the outer
 *   transaction) and every service's own `db` import working unchanged.
 *
 *   This correctness argument DEPENDS on the ambient context existing: with no
 *   outer transaction, `db.transaction(...)` opens a real top-level transaction
 *   while the callback's statements still route to the bare pool, so nothing
 *   would roll back. The route is only ever reachable through
 *   `officeAddinTechAuthMiddleware`, which always opens one.
 *
 *   After the rollback we re-read the winner's association with an ordinary
 *   scoped query — no `runOutsideDbContext` / system-context escalation is
 *   needed, because the request transaction was never aborted and the caller's
 *   partner-scope context still grants exactly the visibility we want.
 *
 *   WHAT THE SAVEPOINT DOES AND DOES NOT UNDO. It undoes exactly the writes
 *   issued on THIS connection inside the callback: the `tickets` row, its
 *   threading stamp, and the `ticket_email_links` claim attempt. It does NOT
 *   undo work that deliberately leaves this connection or this transaction:
 *     - `allocateInternalTicketNumber` runs under
 *       `runOutsideDbContext(withSystemDbAccessContext(...))`, i.e. its own
 *       short transaction on another connection. The loser therefore BURNS a
 *       per-partner counter value. That is by design (see the comment inside
 *       `allocateInternalTicketNumber` in ticketNumbers.ts —
 *       gaps in ticket numbers are acceptable, and holding the partner row lock
 *       inside the request transaction would be worse).
 *     - `emitTicketEvent` enqueues a BullMQ job for a ticket id that will not
 *       exist. Ticket-event consumers already MUST treat ticket-not-found as
 *       retryable rather than terminal (see the NOTE above `createTicket` in
 *       ticketService.ts), so the job retries and expires instead of
 *       corrupting anything.
 *     - `createAuditLogAsync` leaves an orphan `ticket.create` audit row.
 *     - `createConfirmedContact` (the `create_contact` requester branch) runs
 *       before the nested transaction opens, so the requester's portal-user
 *       row survives a claim-race loser. Intentional: the technician
 *       explicitly confirmed that contact, and it stays valid for the winning
 *       ticket / future ones.
 *   The first three are pre-existing consequences of the shapes those helpers
 *   chose; the route adds no new escape. The route's OWN audit event
 *   (`office_addin.ticket.created_from_email`) is written only after the nested
 *   transaction commits, so it never describes a ticket that vanished.
 *
 * Proven end-to-end against real Postgres in
 * `src/__tests__/integration/ticketEmailLinksClaim.integration.test.ts`
 * ("add-in create loses the race..."), which asserts the loser's ticket row is
 * absent afterwards.
 */
export const officeAddinTicketRoutes = new Hono();

officeAddinTicketRoutes.use('*', officeAddinTechAuthMiddleware);

/**
 * Thrown INSIDE the nested transaction to trigger the savepoint rollback.
 * `commentId` is optional because Task 16's create path never claims one
 * (`addin_create` links carry no comment); Task 17's link path always does.
 */
class MessageClaimRaceError extends Error {
  constructor(public readonly existing: { ticketId: string; orgId: string; commentId?: string | null }) {
    super('message-id claimed concurrently');
    this.name = 'MessageClaimRaceError';
  }
}

/** Comment length cap for a link-quoted email; ticket_comments.content has no DB-level limit, so
 * this mirrors fromEmailSchema's description cap (spec §3.3) rather than relying on one. */
const LINKED_COMMENT_MAX = 100_000;

function buildQuotedEmail(input: { from: { email: string; name?: string | null }; subject: string; bodyText: string }): string {
  const name = input.from.name?.trim() || input.from.email;
  const quoted = `From: ${name} <${input.from.email}>\nSubject: ${input.subject}\n\n${input.bodyText}`;
  return quoted.length > LINKED_COMMENT_MAX ? quoted.slice(0, LINKED_COMMENT_MAX) : quoted;
}

const SUMMARY_COLUMNS = {
  id: tickets.id,
  orgId: tickets.orgId,
  internalNumber: tickets.internalNumber,
  subject: tickets.subject,
  status: tickets.status,
  priority: tickets.priority,
  updatedAt: tickets.updatedAt,
  submitterEmail: tickets.submitterEmail,
  emailThreadKey: tickets.emailThreadKey,
};

interface TicketRowForSummary {
  id: string;
  orgId: string;
  internalNumber: string | null;
  subject: string;
  status: string;
  priority: string | null;
  updatedAt: Date;
  submitterEmail: string | null;
  emailThreadKey?: string | null;
}

// Delegates to ticketService.toAddinTicketSummary so the add-in sees ONE
// ticket shape (the @breeze/shared wire type) across /email-context and this
// route.
function toSummary(row: TicketRowForSummary, submitterEmail: string | null): AddinTicketSummary {
  return toAddinTicketSummary(row, submitterEmail);
}

/**
 * Partner-scoped ticket load. RLS narrows further; the explicit partner
 * predicate is the app-layer half of the same boundary.
 *
 * `excludeDeleted` is opt-in per call site, because the two callers want
 * opposite things from a soft-deleted ticket:
 *   - the follow-up branch MUST exclude it. Continuing a deleted closed
 *     original is precisely what threadMatcher.ts:123 refuses to do ("a deleted
 *     closed original must not spawn a continuation"), and this route would
 *     otherwise be a way around that invariant.
 *   - the link fast path MUST NOT. A `ticket_email_links` row outlives the soft
 *     delete of its ticket, so hiding it here would make the route mint a
 *     SECOND ticket for a message that is already claimed — the exact duplicate
 *     the ledger exists to prevent. Answering `alreadyExisted` with a
 *     soft-deleted ticket is the lesser evil.
 */
async function loadTicket(
  ticketId: string,
  partnerId: string,
  opts: { excludeDeleted?: boolean } = {}
): Promise<TicketRowForSummary | null> {
  const rows = await db
    .select(SUMMARY_COLUMNS)
    .from(tickets)
    .where(
      and(
        eq(tickets.id, ticketId),
        eq(tickets.partnerId, partnerId),
        ...(opts.excludeDeleted ? [isNull(tickets.deletedAt)] : [])
      )
    )
    .limit(1);
  return (rows[0] as TicketRowForSummary | undefined) ?? null;
}

/**
 * Turn an existing (partner, message-id) association into this route's response.
 * Same rule for the pre-check fast path and the post-rollback race path:
 *   - the linked ticket lives in the org the technician asked for, and they can
 *     reach it -> 200 `alreadyExisted` (an idempotent replay; the pane just
 *     re-attaches to the ticket that already represents this message)
 *   - anything else (another org, or an org this technician cannot see) -> 409
 *     `message_linked_elsewhere`. The ticket is echoed when it is visible so
 *     the pane can offer "open it"; it is null when it is not, which is itself
 *     the answer ("someone else's ticket owns this message").
 */
async function respondToExistingLink(
  c: Context,
  link: { ticketId: string; orgId: string },
  auth: OfficeAddinTechAuth,
  requestedOrgId: string,
  submitterEmail: string
): Promise<Response> {
  const accessible = auth.canAccessOrg(link.orgId);
  const row = accessible ? await loadTicket(link.ticketId, auth.partnerId) : null;
  const summary = row ? toSummary(row, submitterEmail) : null;

  if (accessible && row && link.orgId === requestedOrgId) {
    return c.json({ ticket: summary, alreadyExisted: true }, 200);
  }
  return c.json({ error: 'message_linked_elsewhere', ticket: summary }, 409);
}

/**
 * Task 17's sibling of `respondToExistingLink` above, for a route that already
 * targets ONE specific ticket (the `:id` in the URL) rather than an org. The
 * match rule is therefore ticket-identity, not org-identity: a link that
 * already points at THIS ticket is a true idempotent replay (200, no second
 * comment); a link pointing anywhere else — even another ticket in the SAME
 * org — is a conflict (409), because "link this message to ticket X" cannot
 * silently resolve to ticket Y. Reuses `loadTicket`/`toSummary` for the
 * accessibility + summary shape, same as `respondToExistingLink`.
 */
async function respondToLinkConflict(
  c: Context,
  existing: { ticketId: string; orgId: string; commentId?: string | null },
  auth: OfficeAddinTechAuth,
  targetTicketId: string,
  submitterEmail: string
): Promise<Response> {
  if (existing.ticketId === targetTicketId) {
    return c.json({ linked: true, alreadyLinked: true, commentId: existing.commentId ?? null }, 200);
  }
  const accessible = auth.canAccessOrg(existing.orgId);
  const row = accessible ? await loadTicket(existing.ticketId, auth.partnerId) : null;
  const summary = row ? toSummary(row, submitterEmail) : null;
  return c.json({ error: 'message_linked_elsewhere', ticket: summary }, 409);
}

const DRAFT_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ai email draft timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Partner-level AI entitlement for the add-in's AI features (spec §6). This is
 * the SAME flag the client-AI Entra exchange gates on
 * (`services/clientAiExchange.ts`: `partners.ai_for_office_enabled`), so a
 * partner who has not bought AI for Office cannot spend model tokens through
 * the Outlook pane either. Read by partner id — the technician's binding
 * already fixes the partner, so no org join is needed.
 */
async function partnerAiEnabled(partnerId: string): Promise<boolean> {
  const rows = await db
    .select({ enabled: partners.aiForOfficeEnabled })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  return rows[0]?.enabled === true;
}

/**
 * AI email -> ticket draft (spec Task 19). A prefill only: subject + a plain-
 * English summary + a suggested time estimate. Never blocks ticket creation —
 * every failure answers with a non-200 (403 no entitlement, 503 no key /
 * timeout / model error, and the DLP block's 422 is one of them too), and ANY
 * non-200 makes the pane fall back to a deterministic (non-AI) prefill.
 *
 * Check order is entitlement -> LLM config -> DLP -> model: the cheapest and most
 * authoritative "you may not do this at all" answer first, so an unentitled
 * partner never reaches DLP evaluation or the model.
 */
// Registered as '/draft' — the router is mounted under '/tickets' in
// ./index.ts, so the external path stays POST /office-addin/tickets/draft
// (same for '/from-email' and '/:id/link-email' below).
officeAddinTicketRoutes.post(
  '/draft',
  requireAddinCapability('ticket-create'),
  zValidator('json', draftSchema),
  async (c) => {
    const auth = c.get('officeAddinAuth');
    const input = c.req.valid('json');

    if (!auth.canAccessOrg(input.orgId)) {
      return c.json({ error: 'not_found' }, 404);
    }

    if (!(await partnerAiEnabled(auth.partnerId))) {
      return c.json({ error: 'ai_not_enabled' }, 403);
    }

    let llm: Awaited<ReturnType<typeof getAnthropicClientForPartner>>;
    try {
      llm = await getAnthropicClientForPartner(auth.partnerId, {
        surface: 'one_shot_email_draft',
        orgId: input.orgId,
      });
    } catch (err) {
      if (err instanceof LlmUnavailableError) {
        return c.json({ error: 'ai_unavailable' }, 503);
      }
      throw err;
    }
    const { client, resolved: llmConfig } = llm;

    const policy = await getOrgPolicy(input.orgId);
    const dlpResult = await applyDlp({ text: input.bodyText, dlpConfig: policy?.dlpConfig, orgId: input.orgId });
    if (dlpResult.action === 'block') {
      return c.json({ error: 'dlp_blocked' }, 422);
    }

    // `model` stays the platform-logical id for metering/budgets; `wire.model`
    // is what the resolved endpoint speaks (a catalog endpoint 404s on the
    // platform id), and `wire.catalogPricing` is what meters catalog traffic.
    const model = llmConfig.model;
    let wire;
    try {
      wire = resolveWireModel(llmConfig, model);
    } catch (err) {
      if (err instanceof LlmUnavailableError) {
        return c.json({ error: 'ai_unavailable' }, 503);
      }
      throw err;
    }
    try {
      const draft = await withTimeout(
        draftTicketFromEmail({
          subject: input.subject,
          bodyText: dlpResult.text ?? input.bodyText,
          model: wire.model,
          partnerId: auth.partnerId,
          orgId: input.orgId,
          client,
        }),
        DRAFT_TIMEOUT_MS
      );
      // Usage accounting (spec §6). `recordUsage` takes a NULLABLE session id
      // (see its doc in aiCostTracker.ts) — this one-shot draft has no
      // `ai_sessions` row, so the per-session totals update is skipped while
      // the per-org budget aggregates (`ai_cost_usage`) still see the spend.
      // Token counts are accumulated across retry attempts, so a
      // failed-then-recovered attempt 1 is metered too. Best-effort: a
      // metering failure must never turn a good draft into a 503 for the pane.
      try {
        await recordUsage(
          null,
          input.orgId,
          model,
          draft.inputTokens,
          draft.outputTokens,
          false,
          llmConfig.source === 'partner' ? 'partner_key' : 'platform',
          wire.catalogPricing,
        );
      } catch (err) {
        console.error('[office-addin] draft usage accounting failed', err);
      }
      return c.json({ draft }, 200);
    } catch (err) {
      // Blanket 503 for the pane's deterministic fallback, but never silent —
      // a model/timeout/parse failure here is otherwise invisible in prod.
      console.error('[office-addin] draft failed', err);
      // Failed attempts still burned tokens — meter them (same best-effort
      // posture as the success path). A timeout escapes this: withTimeout
      // rejects with a plain Error before token counts exist.
      if (err instanceof EmailDraftFailedError && (err.inputTokens > 0 || err.outputTokens > 0)) {
        try {
          await recordUsage(
            null,
            input.orgId,
            model,
            err.inputTokens,
            err.outputTokens,
            false,
            llmConfig.source === 'partner' ? 'partner_key' : 'platform',
            wire.catalogPricing,
          );
        } catch (meterErr) {
          console.error('[office-addin] draft usage accounting failed', meterErr);
        }
      }
      return c.json({ error: 'ai_unavailable' }, 503);
    }
  }
);

officeAddinTicketRoutes.post(
  '/from-email',
  requireAddinCapability('ticket-create'),
  zValidator('json', fromEmailSchema),
  async (c) => {
    const auth = c.get('officeAddinAuth');
    const input = c.req.valid('json');

    // 1. Org reachability. A 404 (not 403) so an add-in can never probe which
    //    org ids exist outside the technician's grant.
    if (!auth.canAccessOrg(input.orgId)) {
      return c.json({ error: 'not_found' }, 404);
    }

    // 2. Message id + idempotency fast path. Mailbox hosts below requirement set
    //    1.8 hand us no internetMessageId; those tickets simply get no ledger row.
    const rawMessageId = input.internetMessageId?.trim() || null;
    const messageId = rawMessageId ? normalizeMessageId(rawMessageId) : null;
    if (messageId) {
      const existing = await findLinkByMessageId(auth.partnerId, messageId);
      if (existing) {
        return respondToExistingLink(c, existing, auth, input.orgId, input.from.email);
      }
    }

    // 3. Requester. `create_contact` is a technician-confirmed action, never an
    //    inferred one — the pane only sends it after an explicit choice.
    let submittedBy: string | undefined;
    if (input.requester.kind === 'portal_user') {
      const portalUser = await getPortalUserForValidation(input.requester.id);
      if (!portalUser || portalUser.orgId !== input.orgId) {
        return c.json({ error: 'not_found' }, 404);
      }
      submittedBy = portalUser.id;
    } else if (input.requester.kind === 'create_contact') {
      const contact = await createConfirmedContact(input.orgId, {
        email: input.requester.email,
        name: input.requester.name ?? null,
      });
      submittedBy = contact.portalUserId;
    }

    // 4. Closed-ticket continuation: carry the original thread key so replies to
    //    the OLD thread still resolve, and label the new ticket with the prior
    //    number (same wording as inboundEmailService.createFromEmail).
    let carryThreadKey: string | null = null;
    let description = input.description;
    if (input.followUpOf) {
      const prior = await loadTicket(input.followUpOf.ticketId, auth.partnerId, { excludeDeleted: true });
      // SAME-ORG, not merely reachable. A technician with two orgs in their
      // grant passes canAccessOrg for both, so an org check alone would let
      // org B's new ticket inherit org A's email_thread_key — and
      // findTicketInPartner matches thread keys PARTNER-wide with limit(1), so
      // the customer's next reply on org A's thread would deterministically
      // land on org B's ticket. The inbound path has no such hole: its
      // `createFromEmail` continuation always stays in the closed original's
      // own org (inboundEmailService.ts).
      if (!prior || prior.orgId !== input.orgId) {
        return c.json({ error: 'not_found' }, 404);
      }
      if (prior.status !== 'closed') {
        return c.json({ error: 'follow_up_target_not_closed' }, 400);
      }
      carryThreadKey = prior.emailThreadKey ?? null;
      description = `Re: ${prior.internalNumber} (continued)\n\n${input.description}`;
    }

    const actor: TicketActor = {
      userId: auth.userId,
      name: auth.user.name ?? undefined,
      email: auth.user.email,
    };

    let created: TicketRowForSummary;
    try {
      // 5-7. Create + stamp + claim, atomically discardable. See the file header.
      created = await db.transaction(async () => {
        const ticket = await createTicket(
          {
            source: 'email',
            orgId: input.orgId,
            subject: input.subject,
            description,
            submitterEmail: input.from.email,
            submitterName: input.from.name ?? undefined,
            submittedBy,
          },
          actor
        );

        // Threading precedence matches inboundEmailService.createFromEmail:
        // carried key -> generated anchor (when a platform inbound domain is
        // configured) -> the customer's own Message-ID -> null.
        const anchor = ticketThreadAnchor(ticket.id);
        const emailThreadKey = carryThreadKey ?? anchor ?? messageId;
        await db
          .update(tickets)
          .set({ emailMessageId: messageId, emailThreadKey })
          .where(eq(tickets.id, ticket.id));

        if (messageId) {
          const claim = await claimMessageLink({
            ticketId: ticket.id,
            orgId: input.orgId,
            partnerId: auth.partnerId,
            messageId,
            origin: 'addin_create',
            visibility: 'public',
            linkedBy: auth.userId,
          });
          if (!claim.created) {
            // The poller (or another pane) committed first. Unwind to the
            // savepoint so this duplicate ticket never existed.
            throw new MessageClaimRaceError(claim.existing);
          }
        }

        return { ...(ticket as unknown as TicketRowForSummary), emailThreadKey };
      });
    } catch (err) {
      if (err instanceof MessageClaimRaceError) {
        // The losing ticket is gone; hand back the winner's association.
        return respondToExistingLink(c, err.existing, auth, input.orgId, input.from.email);
      }
      if (err instanceof TicketServiceError) {
        return c.json({ error: err.message }, err.status as 400);
      }
      throw err;
    }

    writeAuditEvent(c, {
      orgId: input.orgId,
      action: 'office_addin.ticket.created_from_email',
      resourceType: 'ticket',
      resourceId: created.id,
      resourceName: created.internalNumber,
      actorType: 'user',
      actorId: auth.userId,
      actorEmail: auth.user.email,
      result: 'success',
      details: {
        principalType: 'user',
        bindingId: auth.bindingId,
        hasMessageId: Boolean(messageId),
        requesterKind: input.requester.kind,
        followUpOf: input.followUpOf?.ticketId ?? null,
      },
    });

    return c.json({ ticket: toSummary(created, input.from.email), alreadyExisted: false }, 201);
  }
);

/**
 * Attach an email (as a comment) to an EXISTING ticket (spec §3.3, Task 16
 * covers the create case; this is the "add to this ticket instead" branch of
 * the pane). Same ledger, same idempotency contract, same nested-transaction
 * savepoint pattern as `/tickets/from-email` — see the file header for the
 * full mechanism. The only new axis is `visibility`:
 *   - 'public' goes through `insertEmailAuthoredComment` (email-authored,
 *     portal-user-attributed when the sender resolves, no firstResponseAt
 *     stamp — spec §4: email can never be the technician's first response).
 *   - 'internal' goes through `addTicketComment` as a technician-authored
 *     internal note (WILL stamp firstResponseAt on an unanswered ticket, same
 *     as any other technician-written public/internal comment would).
 */
officeAddinTicketRoutes.post(
  '/:id/link-email',
  requireAddinCapability('ticket-link'),
  zValidator('json', linkEmailSchema),
  async (c) => {
    const auth = c.get('officeAddinAuth');
    const ticketId = c.req.param('id');
    const input = c.req.valid('json');

    // 1. Ticket must exist, not be soft-deleted (unlike the from-email fast
    //    path, linking must never touch a deleted ticket), and live in an org
    //    this technician can reach. 404 either way — never 403 — so the pane
    //    can't probe ticket ids outside the grant.
    const ticket = await loadTicket(ticketId, auth.partnerId, { excludeDeleted: true });
    if (!ticket) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (!auth.canAccessOrg(ticket.orgId)) {
      return c.json({ error: 'not_found' }, 404);
    }

    // 2. Idempotency pre-check. Mailbox hosts below requirement set 1.8 send no
    //    internetMessageId; those links simply get no ledger row (spec §3.3).
    const rawMessageId = input.internetMessageId?.trim() || null;
    const messageId = rawMessageId ? normalizeMessageId(rawMessageId) : null;
    if (messageId) {
      const existing = await findLinkByMessageId(auth.partnerId, messageId);
      if (existing) {
        return respondToLinkConflict(c, existing, auth, ticket.id, input.from.email);
      }
    }

    // 3. Ticket-state rule, checked BEFORE any comment is inserted — and only
    //    reached once we know this message isn't already linked (a replay of
    //    an existing link must stay a 200, even on a since-closed ticket). The
    //    pane offers "create a linked follow-up" via Task 16's `followUpOf`.
    if (ticket.status === 'closed') {
      return c.json(
        {
          error: 'ticket_closed',
          ticket: { id: ticket.id, internalNumber: ticket.internalNumber, emailThreadKey: ticket.emailThreadKey },
        },
        409
      );
    }

    const content = buildQuotedEmail(input);
    const actor: TicketActor = {
      userId: auth.userId,
      name: auth.user.name ?? undefined,
      email: auth.user.email,
    };

    let commentId: string;
    try {
      // 4-5. Comment + claim, atomically discardable — same savepoint shape as
      //      the create route. See the file header for the full mechanism.
      commentId = await db.transaction(async () => {
        let newCommentId: string;
        if (input.visibility === 'public') {
          const sender = await findPortalUserByEmail(ticket.orgId, input.from.email);
          const authorName = sender?.name ?? input.from.name?.trim() ?? input.from.email;
          const inserted = await insertEmailAuthoredComment({
            ticketId: ticket.id,
            orgId: ticket.orgId,
            senderPortalUserId: sender?.id ?? null,
            authorName,
            content,
          });
          newCommentId = inserted.commentId;
        } else {
          const { comment } = await addTicketComment(ticket.id, { content, isPublic: false }, actor);
          newCommentId = comment.id;
        }

        if (messageId) {
          const claim = await claimMessageLink({
            ticketId: ticket.id,
            orgId: ticket.orgId,
            partnerId: auth.partnerId,
            messageId,
            origin: 'addin_link',
            visibility: input.visibility,
            linkedBy: auth.userId,
            commentId: newCommentId,
          });
          if (!claim.created) {
            // Another pane (or the poller) claimed this message first. Unwind
            // to the savepoint so this duplicate comment never existed.
            throw new MessageClaimRaceError(claim.existing);
          }
        }

        return newCommentId;
      });
    } catch (err) {
      if (err instanceof MessageClaimRaceError) {
        return respondToLinkConflict(c, err.existing, auth, ticket.id, input.from.email);
      }
      if (err instanceof TicketServiceError) {
        return c.json({ error: err.message }, err.status as 400);
      }
      throw err;
    }

    writeAuditEvent(c, {
      orgId: ticket.orgId,
      action: 'office_addin.ticket.email_linked',
      resourceType: 'ticket',
      resourceId: ticket.id,
      resourceName: ticket.internalNumber,
      actorType: 'user',
      actorId: auth.userId,
      actorEmail: auth.user.email,
      result: 'success',
      details: {
        principalType: 'user',
        bindingId: auth.bindingId,
        visibility: input.visibility,
        hasMessageId: Boolean(messageId),
      },
    });

    return c.json({ linked: true, commentId }, 201);
  }
);
