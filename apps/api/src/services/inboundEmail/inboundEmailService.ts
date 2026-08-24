import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  ticketEmailInbound,
  tickets,
  portalUsers,
  organizations,
  partners,
  ticketMailboxConnections,
} from '../../db/schema';
import { createTicket } from '../ticketService';
import { resolvePartnerByRecipient } from './resolvePartner';
import { resolveOrgBySenderDomain, findOrCreateEmailContact, loadPartnerInboundPolicy } from './resolveOrg';
import { maybeSendAutoresponse } from './autoresponder';
import { insertEmailAuthoredComment } from './emailComments';
import { captureException, captureMessage } from '../sentry';
import { getConfig } from '../../config/validate';
import type { NormalizedInboundEmail, InboundParseStatus } from './types';
import type { M365MailboxGenerationContext } from '../inboundEmailQueue';
import { TICKET_TOKEN_RE, findTicketInPartner, findClosedTicketInPartner, type SenderResolver } from './threadMatcher';
import { claimMessageLink, findLinkByMessageId, normalizeMessageId } from '../ticketEmailLinks';

// Synthetic actor for the inbound pipeline. Only ever written to audit_logs.actor_id
// (NOT NULL, but no FK to users — same pattern as auditEvents.ANONYMOUS_ACTOR_ID /
// notificationDispatcher). createTicket does NOT write actor.userId to any tickets FK
// column. The resolved-ticket reopen is performed as a direct partner-scoped UPDATE here
// (NOT via changeTicketStatus) precisely because changeTicketStatus inserts a
// ticket_comments row with user_id = actor.userId, and ticket_comments.user_id IS FK'd to
// users(id) — a synthetic id would FK-violate at runtime. The direct UPDATE keeps the
// reopen FK-safe while honoring the partner re-assertion guard.
const SYSTEM_ACTOR = { userId: '00000000-0000-0000-0000-000000000000', name: 'Inbound Email' };

// Per-partner ticket display number, e.g. T-2026-0001.
const TOKEN_RE = TICKET_TOKEN_RE;

async function logInbound(
  n: NormalizedInboundEmail,
  partnerId: string | null,
  parseStatus: InboundParseStatus,
  ticketId: string | null,
  error?: string
): Promise<void> {
  // partnerId is intentionally null for the `ignored` path (recipient resolves to no
  // partner). ticket_email_inbound.partner_id is nullable; under system scope a null
  // partner is write-permitted, and partner-scope reads can never see it. NO sentinel.
  await db.insert(ticketEmailInbound).values({
    partnerId,
    provider: n.provider,
    providerMessageId: n.providerMessageId,
    fromAddress: n.from,
    toAddress: n.to,
    subject: n.subject,
    messageId: n.messageId ?? null,
    inReplyTo: n.inReplyTo ?? null,
    references: n.references?.join(' ') ?? null,
    parseStatus,
    ticketId,
    error: error ?? null,
    raw: n.raw
  });
}

// Durable `failed` logging that SURVIVES a poisoned outer transaction.
//
// The worker wraps the entire `processInboundEmail` in ONE Postgres transaction
// (`withSystemDbAccessContext` -> `withDbAccessContext` -> `baseDb.transaction`,
// db/index.ts:107). When a DB write inside the try fails, that tx enters the
// aborted state (25P02) — every subsequent statement on it errors out, so a
// `logInbound('failed')` issued on the SAME tx would also throw and roll back,
// committing NO terminal row (the provider already 202'd, so the message vanishes).
//
// `runOutsideDbContext` clears the AsyncLocalStorage DB context, so the inner
// `withSystemDbAccessContext` resolves `db` back to `baseDb` (the pool) and opens
// a BRAND-NEW transaction on a FRESH pooled connection — fully independent of the
// poisoned outer tx, which is still aborted on its own connection. This insert
// therefore commits even though the outer tx will roll back its partial writes.
async function logInboundFailedDurable(
  n: NormalizedInboundEmail,
  partnerId: string | null,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.insert(ticketEmailInbound).values({
          partnerId,
          provider: n.provider,
          providerMessageId: n.providerMessageId,
          fromAddress: n.from,
          toAddress: n.to,
          subject: n.subject,
          messageId: n.messageId ?? null,
          inReplyTo: n.inReplyTo ?? null,
          references: n.references?.join(' ') ?? null,
          parseStatus: 'failed' as InboundParseStatus,
          ticketId: null,
          error: message,
          raw: n.raw
        })
      )
    );
  } catch (logErr) {
    // A 23505 here means a concurrent retry already logged the failed row (the
    // (partner_id, provider_message_id) unique index) — or any other write error.
    // A failure to LOG must never crash the worker; record it and swallow.
    captureException(logErr instanceof Error ? logErr : new Error(String(logErr)));
  }
}

async function lockActiveMailboxGeneration(
  generation: M365MailboxGenerationContext,
): Promise<boolean> {
  const rows = await db
    .select({ id: ticketMailboxConnections.id })
    .from(ticketMailboxConnections)
    .where(and(
      eq(ticketMailboxConnections.id, generation.connectionId),
      eq(ticketMailboxConnections.partnerId, generation.partnerId),
      eq(ticketMailboxConnections.tenantId, generation.tenantId),
      eq(ticketMailboxConnections.consentAttemptId, generation.consentAttemptId),
      eq(ticketMailboxConnections.status, 'connected'),
    ))
    .for('update')
    .limit(1);
  return rows.length === 1;
}

export interface ProcessInboundEmailDependencies {
  /**
   * Transaction-local observation point used by the real-Postgres concurrency
   * regression. Production callers omit it. Keeping the hook on the invocation
   * (rather than in mutable module state) makes concurrent workers independent.
   */
  afterMailboxGenerationLock?: () => Promise<void>;
}

export async function processInboundEmail(
  n: NormalizedInboundEmail,
  mailboxGeneration?: M365MailboxGenerationContext,
  dependencies: ProcessInboundEmailDependencies = {},
): Promise<void> {
  // partnerId is tracked outside the try so the durable-failed log records whatever
  // tenant was resolved before the failure (may be null if resolution itself failed).
  let partnerId: string | null = null;
  try {
    // A legacy raw BullMQ job cannot prove which mailbox lifecycle generation
    // produced it. Keep generic providers backward-compatible, but fail closed
    // for M365 rather than letting a pre-deploy job bypass the connection lock.
    if (n.provider === 'm365' && !mailboxGeneration) return;

    // (1) Tenant identity is established ONLY from the recipient. Sender data is untrusted.
    // Resolution runs INSIDE the try so a failure here still routes to the durable
    // failed-log instead of escaping (and being silently retried / lost).
    if (mailboxGeneration) {
      // The queue payload's resolvedPartnerId is not authority. Lock and compare
      // every server-issued mailbox-generation field against the live row in the
      // same transaction that performs ticket/comment writes. A disable that won
      // first rotates the generation; a lock acquired here first makes disable wait.
      if (n.provider !== 'm365' || !await lockActiveMailboxGeneration(mailboxGeneration)) return;
      await dependencies.afterMailboxGenerationLock?.();
      partnerId = mailboxGeneration.partnerId;
    } else {
      partnerId = n.resolvedPartnerId ?? await resolvePartnerByRecipient(n.to);
    }
    if (!partnerId) {
      // Distinguish a malformed/empty recipient (no `@`, can never resolve) from a
      // well-formed address for a domain we simply don't host. Both log `ignored`,
      // but the malformed case carries an explanatory note so the audit row is
      // self-describing (FIX 4).
      const malformed = !n.to || !n.to.includes('@');
      await logInbound(n, null, 'ignored', null, malformed ? 'malformed/empty recipient' : undefined);
      return;
    }

    // (1b) Gate ingestion on partner status = active. A suspended/pending/churned
    // partner must not generate or mutate tickets, but we STILL log the inbound row
    // (parse_status: 'skipped') to preserve the audit trail.
    const partnerRow = await db
      .select({ status: partners.status })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1);
    const status = partnerRow[0]?.status;
    if (status !== 'active') {
      await logInbound(n, partnerId, 'skipped', null, `partner ${partnerId} status=${status ?? 'unknown'}`);
      return;
    }

    // (1c) Self-loop DROP (spec §5). If the SENDER is on our own inbound domain
    // (`tickets.<domain>`), this is almost certainly our own outbound mail — a reply
    // we sent, or an autoresponse that bounced — looping back in. Ingesting it would
    // spawn a bogus ticket (or autoresponse) and potentially feed a mail loop. Drop
    // it EARLY, before any match/create/quarantine decision, logging `ignored` with a
    // self-loop note for the audit trail. (The autoresponse-time `self-domain` rule in
    // loopPrevention.ts is the separate, defense-in-depth backstop.) When no platform
    // domain is configured (self-hosted without TICKETS_INBOUND_DOMAIN) the helper
    // returns null and this guard is skipped — nothing to compare against.
    const inboundDomain = inboundDomainOrNull();
    if (inboundDomain && senderDomain(n.from) === inboundDomain.toLowerCase()) {
      await logInbound(n, partnerId, 'ignored', null, `self-loop: sender is inbound domain ${inboundDomain}`);
      return;
    }

    // (2) Idempotency — provider retries / at-least-once delivery. Scoped to the partner.
    // This SELECT alone is NOT the exactly-once guarantee: under CONCURRENT delivery two
    // workers can both miss the dup here and race to insert. Exactly-once is enforced by the
    // `(partner_id, provider_message_id)` UNIQUE index combined with the surrounding
    // `withSystemDbAccessContext` transaction — the losing insert hits 23505, its transaction
    // rolls back, BullMQ retries the job, and the retry's dedup SELECT then finds the row the
    // winner committed and returns early. This SELECT is the fast path; the index is the lock.
    const dup = await db
      .select({ id: ticketEmailInbound.id })
      .from(ticketEmailInbound)
      .where(and(
        eq(ticketEmailInbound.partnerId, partnerId),
        eq(ticketEmailInbound.providerMessageId, n.providerMessageId)
      ))
      .limit(1);
    if (dup[0]) return;

    // (2b) Master switch (#3597). `settings.ticketing.inbound.enabled` used to be
    // display-only: the card persisted and re-rendered it while nothing in this
    // pipeline read it, so a partner who turned the feature OFF kept getting tickets
    // (and autoresponses) with no in-product way to stop it. Gate here — after the
    // partner is known (the flag is per-partner) and after the dedup SELECT, so a
    // provider retry short-circuits on the existing row instead of racing the
    // (partner_id, provider_message_id) unique index and landing a spurious `failed`.
    //
    // Terminate as `ignored`, not an error: the webhook already 202'd and a 4xx/5xx
    // would make the provider retry mail we intend to discard. `ignored` also keeps
    // the row out of the review queue (REVIEW_STATUSES = quarantined|failed), which
    // is the point — a disabled partner should see nothing, not a growing queue.
    // No separate autoresponder gate is needed: autoresponses only fire from
    // createFromEmail, which is downstream of this return.
    //
    // The M365 poll path lands here too (mailboxGeneration carries the partnerId), so
    // it is covered — but note the semantic: the poller still fetches, marks read, and
    // advances its delta cursor, so mail that arrives while the switch is OFF is
    // CONSUMED (with an audit row), not queued for replay when it's switched back on.
    // 'Off' means discard-with-audit, not pause. Pause-and-replay would need a
    // cursor-level design in ticketMailboxPollWorker, not a gate here.
    //
    // Scope: this governs NEW ingestion only. Rows already in the review queue stay
    // manually convertible after the switch goes off — the switch is not a retroactive
    // queue purge.
    //
    // The policy is loaded ONCE here and threaded to the unknown-sender decision at
    // the bottom, replacing what used to be two independent reads of the same row.
    const policy = await loadPartnerInboundPolicy(partnerId);
    if (!policy.enabled) {
      await logInbound(n, partnerId, 'ignored', null, 'inbound disabled for partner');
      return;
    }

    // (2b) CROSS-CHANNEL idempotency — the `ticket_email_links` ledger (spec §4:
    // ONE message-id, ONE canonical association, across BOTH channels).
    //
    // Why this must exist here and not only at the claim sites: a technician who
    // links or creates from the Outlook add-in at t=0 claims the Message-ID, but
    // the 90s mailbox poller then ingests that SAME message. For a FRESH email
    // there is no thread header and no ticket token to match on, so without this
    // consult the pipeline falls through to `createFromEmail` and mints a SECOND
    // ticket, whose `claimMessageLink` then no-ops (onConflictDoNothing) and used
    // to be swallowed — a duplicate ticket with no ledger row. The add-in route
    // has the same consult (routes/officeAddin/tickets.ts, "idempotency fast
    // path"); this is its inbound-side twin.
    //
    // PLACEMENT (deliberate, w.r.t. the R4 sender-auth gate below): this runs
    // BEFORE the gate. That is safe because the short-circuit CREATES NOTHING —
    // no ticket, no comment, no reopen, no autoresponse; it only writes the audit
    // row. The gate exists to stop a spoofed From: from driving those writes, and
    // there are none to drive: an existing claim means an AUTHENTICATED technician
    // already decided what this message is. Quarantining it instead would just put
    // an already-handled message in front of a human. Everything that must keep
    // precedence still runs first — mailbox-generation locking, partner
    // resolution, the partner-status gate, self-loop drop, and provider dedup —
    // so no unclaimed message's path changes by so much as a query.
    // `normalizeMessageId` throws on an empty id, so require a non-blank one —
    // the same shape the add-in route's fast path uses (`?.trim() || null`).
    if (n.messageId?.trim()) {
      const claimed = await findLinkByMessageId(partnerId, normalizeMessageId(n.messageId));
      if (claimed) {
        // 'matched' is the honest terminal status: this message IS associated with
        // that ticket, we simply didn't have to do the associating.
        await logInbound(n, partnerId, 'matched', claimed.ticketId, `already claimed by ${claimed.origin}`);
        return;
      }
    }

    // (R4) Sender authentication gate. The From header is spoofable and the per-partner
    // ticket token (T-YYYY-NNNN) is enumerable, so a token/thread match or a
    // known-portal-user match must NOT be trusted to append a PUBLIC comment, reopen a
    // ticket, or create a ticket as a trusted sender unless the sender's domain is
    // authenticated. We rely on the verdicts the provider already computed at its MX
    // boundary (aligned SPF+DKIM, or DMARC pass). When NOT verified, route the message to
    // the EXISTING quarantine/review path instead of auto-acting — mail is never dropped.
    if (!n.senderAuth?.verified) {
      // A `senderAuthDiagnostic` means we're acting NOT because of a genuine DMARC fail but
      // because no usable provider verdict could be read — the silent mass-quarantine (or, when
      // the partner opts to drop, mass-DROP) failure mode from a provider MX/host or
      // payload-format change. Surface it: enrich the audit reason AND raise a Sentry warning,
      // since the inbound webhook was already signature-verified, so a missing verdict is
      // anomalous rather than ordinary spam rejection. Raise it regardless of the drop policy —
      // a systemic verdict-reading gap matters even more when unverified mail is being dropped.
      const gap = n.senderAuthDiagnostic;
      if (gap) {
        captureMessage(
          'Inbound email quarantined: no usable provider sender-auth verdict on a signature-verified webhook',
          {
            eventCode: 'inbound_email_sender_auth_unverified',
          }
        );
      }
      const reason = gap
        ? `unverified sender (SPF/DKIM/DMARC): ${gap}`
        : 'unverified sender (SPF/DKIM/DMARC)';
      // Default: route to the review queue. If the partner opted into dropping
      // unverified mail, silently ignore it instead (audit row only, no review
      // queue, no autoresponse). This gate runs before any sender matching, so
      // the drop applies to ALL unverified senders — known or not (see
      // PartnerInboundPolicy.dropUnverifiedSenders).
      if (policy.dropUnverifiedSenders) {
        await logInbound(n, partnerId, 'ignored', null, `drop: ${reason}`);
      } else {
        await logInbound(n, partnerId, 'quarantined', null, reason);
      }
      return;
    }

    // Resolve sender identity lazily so token binding and unmatched fallthrough
    // reuse the same partner-scoped lookups.
    const senderResolver = createSenderResolver(n.from, partnerId);
    const matched = await findTicketInPartner(n, partnerId, senderResolver);
    if (matched) {
      // GUARD (spec §6 layer 2): never act across partners. A partner-scoped match query
      // should already make this impossible, but re-assert before ANY write and throw
      // (-> failed) rather than risk a silent cross-tenant append. `findTicketInPartner`
      // only returns LIVE (non-closed) tickets, so this never sees a closed original.
      if (matched.partnerId !== partnerId) {
        throw new Error(`cross-partner match: ticket ${matched.id} (partner ${matched.partnerId}) for resolved partner ${partnerId}`);
      }

      // Append a public inbound comment, then reopen if resolved.
      const commentId = await appendInboundComment(matched.id, n, partnerId, senderResolver);
      if (matched.status === 'resolved') {
        await reopenResolvedTicket(matched.id, partnerId);
      }
      // Record the reply's OWN Message-ID as a claimed link row (Task 4). This
      // preserves the next hop when a client strips older References entries —
      // the NEXT reply's In-Reply-To will point at THIS message, and the link
      // table (consulted by findTicketInPartner) still resolves it to this
      // ticket even though no header column carries it. Runs inside the same
      // outer transaction as the comment insert (NOT the durable outside-context
      // pattern) — a rollback must discard this together with the comment.
      let lostClaimTo: string | null = null;
      if (n.messageId) {
        const claim = await claimMessageLink({
          ticketId: matched.id,
          orgId: matched.orgId,
          partnerId,
          messageId: n.messageId,
          origin: 'inbound',
          visibility: 'public',
          commentId
        });
        lostClaimTo = claimRaceLoserTicketId(claim, matched.id);
        if (lostClaimTo) warnLostClaim(n, partnerId, matched.id, lostClaimTo, 'matched-reply');
      }
      await logInbound(
        n,
        partnerId,
        'matched',
        matched.id,
        lostClaimTo ? `lost message-id claim to ticket ${lostClaimTo}` : undefined
      );
      return;
    }

    // No LIVE thread match. A reply to a CLOSED ticket is immutable -> create a NEW
    // linked ticket carrying the original thread key. This lookup is intentionally
    // SEPARATE from findTicketInPartner (which excludes closed) so the live-continuation
    // it spawns is what future replies match — the closed original is never re-matched,
    // which is what prevents a thread from forking into N tickets (FIX 2).
    const closedOriginal = await findClosedTicketInPartner(n, partnerId, senderResolver);
    if (closedOriginal) {
      const t = await createFromEmail(n, partnerId, closedOriginal.orgId, closedOriginal.emailThreadKey, closedOriginal.internalNumber);
      await logCreated(n, partnerId, t);
      return;
    }

    // (5) Known portal-user sender -> their home org. Most specific; wins over
    // domain rules (a user who belongs to a sub-org isn't overridden by a
    // broader domain mapping).
    const sender = await senderResolver.portalUser();
    if (sender) {
      const t = await createFromEmail(n, partnerId, sender.orgId, null, null, sender.id);
      await logCreated(n, partnerId, t);
      return;
    }

    // (6) Sender domain mapped to a customer org (Phase 5) -> ALWAYS create the
    // ticket; optionally onboard a password-less contact so future replies
    // thread + attribute. This sits behind the senderAuth.verified (DMARC) gate
    // above, so a forged From: @customer.com can't file into the customer's org.
    const domainMatch = await senderResolver.domainOrg();
    if (domainMatch) {
      const submittedBy = domainMatch.autoCreateContact
        ? await findOrCreateEmailContact(domainMatch.orgId, n.from, n.fromName ?? null)
        : undefined;
      const t = await createFromEmail(n, partnerId, domainMatch.orgId, null, null, submittedBy);
      await logCreated(n, partnerId, t);
      return;
    }

    // (7) Unknown sender (no thread, no portal user, no mapped domain). The
    // partner's policy (settings.ticketing.inbound) decides the fate. No contact
    // is onboarded — the customer is unknown. Default-off: absent settings keep
    // the Phase 4 quarantine behavior. (`policy` was loaded at the master-switch
    // gate above.)

    // 'drop' — silently ignore: no ticket, no review-queue row, no autoresponse.
    // Distinct from quarantine so unmapped spam doesn't fill the review queue.
    if (policy.unknownSenderMode === 'drop') {
      await logInbound(n, partnerId, 'ignored', null, 'drop: unknown sender');
      return;
    }

    // 'triage' — auto-create in the partner's default triage org (only when one
    // is configured; otherwise fall through to quarantine).
    if (policy.unknownSenderMode === 'triage' && policy.defaultTriageOrgId) {
      const t = await createFromEmail(n, partnerId, policy.defaultTriageOrgId, null, null);
      await logCreated(n, partnerId, t);
      return;
    }

    // (8) 'quarantine' (default) -> review queue for manual handling.
    await logInbound(n, partnerId, 'quarantined', null);
  } catch (err) {
    // (9) Any guard/error -> failed, logged under the RESOLVED partner (or null if
    // resolution failed). Never a cross-tenant write.
    //
    // The outer work transaction is now poisoned (25P02): we CANNOT log on it. Record
    // the terminal `failed` row in a FRESH transaction (logInboundFailedDurable) so it
    // survives the rollback. Then RETURN (swallow) so the outer tx rolls back its partial
    // writes and BullMQ does NOT retry — the durable `failed` row is the terminal record
    // surfaced by the review queue.
    captureException(err instanceof Error ? err : new Error(String(err)));
    await logInboundFailedDurable(n, partnerId, err);
  }
}

// Lazy, memoized sender-identity lookups. Threaded through the matchers (token
// binding, #3643) and the unmatched fallthrough so both reuse the same
// partner-scoped queries instead of issuing duplicates.
function createSenderResolver(from: string, partnerId: string): SenderResolver {
  let portalUserPromise: Promise<{ id: string; orgId: string; name: string | null } | null> | undefined;
  let domainOrgPromise: Promise<{ orgId: string; autoCreateContact: boolean } | null> | undefined;

  return {
    portalUser() {
      portalUserPromise ??= findPortalUserInPartner(from, partnerId);
      return portalUserPromise;
    },
    domainOrg() {
      domainOrgPromise ??= resolveOrgBySenderDomain(from, partnerId);
      return domainOrgPromise;
    }
  };
}

// Terminal audit row for a create-path result. `lostClaimTo` is normally null;
// when set, the row names the ticket that already owned this message-id so the
// duplicate is reconcilable without reading Sentry (see `warnLostClaim`).
async function logCreated(
  n: NormalizedInboundEmail,
  partnerId: string,
  result: { id: string; lostClaimTo: string | null }
): Promise<void> {
  await logInbound(
    n,
    partnerId,
    'created',
    result.id,
    result.lostClaimTo ? `lost message-id claim to ticket ${result.lostClaimTo}` : undefined
  );
}

// (4) Sender -> portal user, scoped to the resolved partner via the org->partner join.
// portal_users has no partner_id; a same-email user under a DIFFERENT partner must not match.
async function findPortalUserInPartner(email: string, partnerId: string): Promise<{ id: string; orgId: string; name: string | null } | null> {
  const rows = await db
    .select({ id: portalUsers.id, orgId: portalUsers.orgId, name: portalUsers.name })
    .from(portalUsers)
    .innerJoin(organizations, eq(portalUsers.orgId, organizations.id))
    .where(and(eq(portalUsers.email, email.toLowerCase()), eq(organizations.partnerId, partnerId)))
    .limit(1);
  return rows[0] ?? null;
}

// Resolve TICKETS_INBOUND_DOMAIN defensively. The inbound worker runs `getConfig()`
// against a validated config at runtime, but some execution contexts (e.g. the
// integration harness, which seeds partner_inbound_domains and never calls
// validateConfig()) reach the create path without an initialized config. A config
// read must NEVER poison ingestion — degrade to null (threading off) instead of
// throwing, mirroring `resolvePartner`'s slug-address branch being unreachable
// there. Returns null when the domain is unset OR config isn't initialized.
function inboundDomainOrNull(): string | null {
  try {
    return getConfig().TICKETS_INBOUND_DOMAIN ?? null;
  } catch {
    return null;
  }
}

// Lower-cased domain part of an email address (everything after the last '@'),
// or '' when the address is malformed. Used by the ingest-time self-loop drop.
function senderDomain(addr: string): string {
  const a = (addr || '').trim().toLowerCase();
  const at = a.lastIndexOf('@');
  return at >= 0 ? a.slice(at + 1) : '';
}

async function createFromEmail(
  n: NormalizedInboundEmail,
  partnerId: string,
  orgId: string,
  carryThreadKey: string | null,
  priorNumber: string | null,
  submittedBy?: string
) {
  // GUARD (spec §6 layer 2): the resolved org MUST belong to the resolved partner before create.
  const orgOk = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), eq(organizations.partnerId, partnerId)))
    .limit(1);
  if (!orgOk[0]) throw new Error(`org ${orgId} not in partner ${partnerId}`);

  const description = priorNumber ? `Re: ${priorNumber} (continued)\n\n${n.text}` : n.text;
  const ticket = await createTicket(
    {
      orgId,
      subject: n.subject.replace(TOKEN_RE, '').trim() || '(no subject)',
      description,
      source: 'email',
      submitterEmail: n.from,
      submitterName: n.fromName,
      submittedBy
    },
    SYSTEM_ACTOR
  );

  // Record the originating Message-ID as a claimed link row (Task 4) — same
  // idempotent claim as the matched-reply path, covering the create path (fresh
  // ticket + closed-continuation). Runs inside the pipeline's outer transaction
  // — a rollback discards it with the ticket.
  //
  // A created:false whose winner is a DIFFERENT ticket means we just minted a
  // duplicate: someone (the add-in, or a concurrent worker) claimed this
  // message between the (2b) ledger consult and here. It is reported, never
  // swallowed — see `warnLostClaim`.
  let lostClaimTo: string | null = null;
  if (n.messageId) {
    const claim = await claimMessageLink({
      ticketId: ticket.id,
      orgId,
      partnerId,
      messageId: n.messageId,
      origin: 'inbound',
      visibility: 'public'
    });
    lostClaimTo = claimRaceLoserTicketId(claim, ticket.id);
    if (lostClaimTo) warnLostClaim(n, partnerId, ticket.id, lostClaimTo, 'create');
  }

  // Stamp the threading key so future replies match. Precedence:
  //   1) carryThreadKey — preserves a closed-continuation's original thread, so a
  //      reply to the linked ticket still resolves to the original thread key.
  //   2) the deterministic generated anchor — <ticket-${id}@TICKETS_INBOUND_DOMAIN>
  //      — WHEN a platform domain is configured. This is the SAME value PR3's
  //      OUTBOUND mail stamps as Message-ID/In-Reply-To/References (the one-time
  //      autoresponse's Message-ID and every comment reply's In-Reply-To), so the
  //      autoresponse, the outbound reply headers, and the inbound matcher all
  //      round-trip to ONE key. It MUST take precedence over the customer's own
  //      Message-Id: otherwise a reply to the autoresponse (In-Reply-To = anchor)
  //      would not match email_thread_key and would only thread via the weaker
  //      [T-...] subject token (review finding — header threading must work).
  //   3) n.messageId — the customer's own Message-Id, used ONLY when no platform
  //      domain is configured (self-hosted without TICKETS_INBOUND_DOMAIN). Keeps
  //      the no-domain integration env unchanged (still anchors on the inbound id).
  //   4) null — no domain AND no Message-Id (threading off for this ticket).
  // ALSO stamp the customer's OWN Message-Id (email_message_id, Phase 1 column).
  // When a platform domain is configured, email_thread_key is the generated
  // anchor — so an autoresponder-OFF partner's customer who replies to their OWN
  // original (In-Reply-To = their original Message-Id, NOT the anchor) would not
  // header-match email_thread_key and would fork a duplicate ticket. Persisting
  // the customer's Message-Id here lets findTicketInPartner match the reply
  // against EITHER key (review fix). Harmless when it duplicates email_thread_key
  // (no-domain path) — both columns just carry the same value.
  const domain = inboundDomainOrNull();
  const generatedAnchor = domain ? `<ticket-${ticket.id}@${domain}>` : null;
  await db.update(tickets)
    .set({
      emailThreadKey: carryThreadKey ?? (domain ? generatedAnchor : (n.messageId ?? null)),
      emailMessageId: n.messageId ?? null,
    })
    .where(eq(tickets.id, ticket.id));

  // One-time autoresponse — ONLY for an accepted known sender on a FRESH ticket.
  // The known-sender create call passes `submittedBy` and a null `priorNumber`; the
  // closed-continuation call passes `priorNumber` (and no `submittedBy`). Gating on
  // `submittedBy && !priorNumber` therefore fires the autoresponder exactly once on
  // the fresh known-sender path and NEVER on the quarantine path (which never calls
  // createFromEmail) or the closed-continuation path (spec §5).
  if (submittedBy && !priorNumber) {
    // Read the PERSISTED subject (token-stripped by createTicket) + internalNumber.
    // Never use raw n.subject — it may still carry the [T-...] token.
    const persisted = await db
      .select({ internalNumber: tickets.internalNumber, subject: tickets.subject })
      .from(tickets)
      .where(eq(tickets.id, ticket.id))
      .limit(1);
    await maybeSendAutoresponse(n, partnerId, {
      id: ticket.id,
      orgId,
      partnerId,
      internalNumber: persisted[0]?.internalNumber ?? null,
      subject: persisted[0]?.subject ?? '',
    });
  }
  return { id: ticket.id, lostClaimTo };
}

/**
 * A `claimMessageLink` result that lost the (partner_id, message_id) race to a
 * DIFFERENT ticket. `created:false` pointing at the ticket we just wrote to is
 * an ordinary idempotent replay (a retry re-observing its own prior claim) and
 * returns null; anything else is the lost race.
 */
function claimRaceLoserTicketId(
  claim: Awaited<ReturnType<typeof claimMessageLink>>,
  ourTicketId: string
): string | null {
  if (claim.created) return null;
  return claim.existing.ticketId === ourTicketId ? null : claim.existing.ticketId;
}

/**
 * Report a lost message-id claim. With the (2b) ledger consult in place this is
 * near-unreachable (it needs a claim committed in the window between that SELECT
 * and this INSERT), which is exactly why it must be loud rather than deleted:
 * it is the invariant alarm for "one message-id, one canonical association".
 *
 * We report rather than throw deliberately. `processInboundEmail`'s catch
 * SWALLOWS and returns, so the worker's transaction would COMMIT anyway — a
 * throw would buy no rollback here, only a `failed` audit row that hides which
 * two tickets are involved. The comment/ticket we already wrote therefore
 * stands, and the audit row plus this Sentry warning name both sides so the
 * duplicate is reconcilable by a human.
 */
function warnLostClaim(
  n: NormalizedInboundEmail,
  partnerId: string,
  ourTicketId: string,
  winnerTicketId: string,
  path: 'matched-reply' | 'create'
): void {
  captureMessage(
    'Inbound email lost the message-id claim race: duplicate ticket/comment written',
    {
      eventCode: 'inbound_email_claim_race_lost',
    }
  );
}

async function appendInboundComment(
  ticketId: string,
  n: NormalizedInboundEmail,
  partnerId: string,
  senderResolver: SenderResolver
): Promise<string> {
  const sender = await senderResolver.portalUser();
  // appendInboundComment is only reached on the verified-sender match path (R4 gate
  // upstream), so a matched portal user is an authenticated identity: prefer their
  // STORED name over the spoofable From display name. Fall back to the header only
  // when the sender isn't a known portal user (still verified by SPF/DKIM/DMARC).
  const authorName = sender?.name ?? n.fromName ?? n.from;
  const { commentId } = await insertEmailAuthoredComment({
    ticketId,
    orgId: '', // existing wart, preserved — see EmailCommentInput
    senderPortalUserId: sender?.id ?? null,
    authorName,
    content: n.text
  });
  return commentId;
}

// Reopen a resolved ticket via a direct partner-scoped UPDATE (FK-safe — see SYSTEM_ACTOR note).
// The partner_id predicate is a defense-in-depth re-assertion: even though the matched ticket
// was already partner-checked, the write itself is bounded to the resolved partner.
async function reopenResolvedTicket(ticketId: string, partnerId: string): Promise<void> {
  await db.update(tickets)
    .set({ status: 'open', resolvedAt: null, updatedAt: new Date() })
    .where(and(eq(tickets.id, ticketId), eq(tickets.partnerId, partnerId), eq(tickets.status, 'resolved')));
}
