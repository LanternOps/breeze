import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { contacts, customerEmailDomains, partners } from '../../db/schema';
import { createContact, matchContactByEmail, normalizeContactEmail } from '../contacts/crud';

/** Lowercased domain part of an email address, or null if malformed. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

/**
 * Resolve a sender's email domain to a mapped customer org (Phase 5).
 * Read-only; caller is in system context (the inbound worker).
 *
 * Matches the EXACT sender domain only — `bob@mail.acme.com` does NOT match an
 * `acme.com` mapping (it falls through to triage/quarantine). This is deliberate:
 * a suffix match would route arbitrary subdomains the MSP never vetted into the org.
 * Do not "fix" this into an endsWith() match.
 */
export async function resolveOrgBySenderDomain(
  fromAddress: string,
  partnerId: string,
): Promise<{ orgId: string; autoCreateContact: boolean } | null> {
  const domain = domainOf(fromAddress);
  if (!domain) return null;
  const rows = await db
    .select({ orgId: customerEmailDomains.orgId, autoCreateContact: customerEmailDomains.autoCreateContact })
    .from(customerEmailDomains)
    .where(
      and(
        eq(customerEmailDomains.partnerId, partnerId),
        eq(customerEmailDomains.domain, domain),
        eq(customerEmailDomains.isActive, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The inbound sender's identity, resolved onto `contacts` (#3258 W03).
 *
 * The non-contact outcome is DISCRIMINATED, not a bare "nothing": each reason
 * is a different operator story and the caller writes it verbatim into
 * `ticket_email_inbound.error` (which already carries notes, e.g. "lost
 * message-id claim ..."). Before that, a shared mailbox and a malformed From
 * were indistinguishable at the audit row — the ticket simply arrived
 * unattributed and nothing anywhere said why.
 *
 *  - 'unusable-address' — the From address is empty/whitespace. Nothing can
 *    identify anyone; not an error, the ticket is still created.
 *  - 'shared-mailbox'   — several contacts hold this address. A legitimate
 *    state (`support@`, `ap@`): `contacts_org_email_idx` is deliberately
 *    non-unique and there is no honest way to pick one. Picking by display
 *    name would key attribution off a header the sender controls (see
 *    inboundEmailService's spoofable-From note); picking oldest or newest is a
 *    coin flip wearing a rule.
 *  - 'vanished'         — the single match was deleted between the probe and
 *    the FOR KEY SHARE pin.
 *
 * In every case the ticket is still created and still carries the snapshotted
 * submitter name/email — it just does not claim to know WHICH person wrote it.
 */
export type EmailRequesterResolution =
  | { kind: 'contact'; contactId: string }
  | { kind: 'none'; reason: 'unusable-address' | 'shared-mailbox' | 'vanished' };

/**
 * Advisory-lock namespace for "resolve this (org, address) to a contact".
 *
 * The two-argument `pg_advisory_xact_lock(ns, key)` form the rest of the repo
 * uses (services/discoveryJobCreation.ts, c2cJobCreation.ts, aiBudgetAlerts.ts):
 * the one-argument form puts every caller in the process into ONE 64-bit key
 * space, so an unrelated feature hashing a colliding string would block
 * ingest for a tenant with no way to trace why.
 *
 * Exported because the INVITE path (routes/orgPortalUsers.ts) resolves the
 * same (org, address) to the same contact and must take the SAME lock — an
 * invite racing a first email from that address would otherwise each see "no
 * contact" and each create one.
 */
export const INBOUND_CONTACT_LOCK_NAMESPACE = 'inbound-email-contact';

/**
 * Resolve an inbound sender to the org's contact for that address, creating
 * one when the address is new. Caller is the inbound worker, in a SYSTEM DB
 * context; `orgId` has ALREADY been partner-validated by the caller
 * (resolveOrgBySenderDomain + createFromEmail's org re-assertion) and MUST NOT
 * be re-derived from the sender here.
 *
 * This replaces `findOrCreateEmailContact`, which minted a password-less
 * `portal_users` row per unknown sender. No path here writes to `portal_users`
 * at all: a portal user is a LOGIN, and an emailing customer has none.
 *
 * Concurrency: the worker runs at concurrency 5 and the check-then-insert
 * below is not atomic, so two first-time messages from the SAME new sender
 * arriving together would each see "no contact" and each create one —
 * `contacts_org_email_idx` is deliberately NON-unique (shared mailboxes), so
 * the database will not stop it. The advisory lock is taken FIRST, keyed on
 * (org, normalized address), which serialises exactly those two and nothing
 * else.
 *
 * The lock is TRANSACTION-scoped, and the worker wraps the whole of
 * `processInboundEmail` in one transaction — so it is held until that
 * transaction ends, which includes `maybeSendAutoresponse`'s in-transaction
 * send. That is deliberate (a duplicate contact is worse than a briefly held
 * per-address lock) but it does mean the lock's hold time includes an SMTP
 * round trip for the FIRST message from a new sender.
 */
export async function resolveEmailRequester(
  orgId: string,
  email: string,
  name: string | null,
): Promise<EmailRequesterResolution> {
  const normalized = normalizeContactEmail(email);
  // An empty/whitespace From cannot identify anyone, and locking on `<org>:`
  // would serialise every malformed message in the org against each other for
  // the rest of the worker transaction. Bail BEFORE the lock.
  if (!normalized) return { kind: 'none', reason: 'unusable-address' };

  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${INBOUND_CONTACT_LOCK_NAMESPACE}), hashtext(${`${orgId}:${normalized}`}))`,
  );

  const found = await matchContactByEmail(db, orgId, normalized);
  if (found.kind === 'no-match') {
    // roles: [] — an emailing customer has demonstrated nothing except that
    // they email. 'portal' is claimed by the invite path, which is where
    // someone deliberately grants portal access.
    const created = await createContact(db, { orgId, email: normalized, name, roles: [] }, { userId: null });
    return { kind: 'contact', contactId: created.id };
  }
  return found;
}

/**
 * How an inbound email from an UNKNOWN sender (no live thread, no closed-ticket
 * reply, no portal user, no mapped customer domain) is handled:
 *  - 'quarantine' — route to the review queue for manual convert/dismiss (default)
 *  - 'triage'     — auto-create a ticket in the partner's default triage org
 *                   (only effective when defaultTriageOrgId is set)
 *  - 'drop'       — silently ignore: no ticket, no review-queue row, no
 *                   autoresponse (an 'ignored' audit row is still written)
 */
export type UnknownSenderMode = 'quarantine' | 'triage' | 'drop';

const UNKNOWN_SENDER_MODES: readonly UnknownSenderMode[] = ['quarantine', 'triage', 'drop'];

export interface PartnerInboundPolicy {
  /**
   * The 'Enable email-to-ticket' master switch (settings.ticketing.inbound.enabled).
   * When false, `processInboundEmail` terminates as 'ignored' before any ticket,
   * review-queue row, or autoresponse is produced.
   *
   * Defaults to TRUE when absent, which is deliberately the opposite of the safe
   * default used by every other field here: from the feature's introduction until
   * this gate existed the flag was display-only, so ingestion has ALWAYS been on.
   * Defaulting to false would silently stop ticketing for every partner that never
   * touched the toggle. A stored `false` written before this gate shipped is not
   * evidence of intent either — see the `2026-08-24-inbound-enabled-backfill.sql`
   * migration, which repairs those rows for partners with observed inbound mail.
   */
  enabled: boolean;
  unknownSenderMode: UnknownSenderMode;
  defaultTriageOrgId: string | null;
  /**
   * When true, an inbound email whose sender fails the SPF/DKIM/DMARC gate is
   * silently dropped ('ignored' audit row) instead of quarantined. Applies to
   * ALL unverified senders (known or not), since the auth gate runs before any
   * sender matching. Default false (preserves the quarantine-for-review behavior).
   */
  dropUnverifiedSenders: boolean;
}

/**
 * Read the partner's inbound routing policy from partners.settings JSONB
 * (settings.ticketing.inbound). Absent fields read as the safe default
 * (quarantine; never drop) — with the deliberate exception of `enabled`, which
 * defaults to true so an upgrade cannot silently stop ingestion (see the field
 * docs on PartnerInboundPolicy). Back-compat: a partner that only has the legacy
 * `triageUnknownSenders` boolean (set before the 3-way mode existed) maps
 * true -> 'triage', false/absent -> 'quarantine'. The first save from the UI
 * replaces the inbound object wholesale, retiring the legacy key.
 */
export async function loadPartnerInboundPolicy(
  partnerId: string,
): Promise<PartnerInboundPolicy> {
  const rows = await db
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  const settings = (rows[0]?.settings ?? {}) as Record<string, unknown>;
  const inbound =
    (((settings.ticketing as Record<string, unknown> | undefined)?.inbound) as
      | {
          enabled?: boolean;
          defaultTriageOrgId?: string | null;
          triageUnknownSenders?: boolean;
          unknownSenderMode?: string;
          dropUnverifiedSenders?: boolean;
        }
      | undefined) ?? {};

  // Prefer the explicit 3-way mode; fall back to the legacy boolean. An
  // unrecognized stored value falls through to the safe 'quarantine' default.
  const mode = UNKNOWN_SENDER_MODES.includes(inbound.unknownSenderMode as UnknownSenderMode)
    ? (inbound.unknownSenderMode as UnknownSenderMode)
    : inbound.triageUnknownSenders === true
      ? 'triage'
      : 'quarantine';

  return {
    enabled: inbound.enabled !== false,
    unknownSenderMode: mode,
    defaultTriageOrgId: inbound.defaultTriageOrgId ?? null,
    dropUnverifiedSenders: inbound.dropUnverifiedSenders === true,
  };
}
