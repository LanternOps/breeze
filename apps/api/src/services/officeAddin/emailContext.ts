import { and, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  organizations,
  sites,
  devices,
  tickets,
  contacts,
  customerEmailDomains,
  partnerInboundDomains,
  ticketMailboxConnections,
} from '../../db/schema';
import { portalUsers } from '../../db/schema/portal';
import { getConfig } from '../../config/validate';
import type { OfficeAddinTechAuth } from '../../middleware/officeAddinTechAuth';
import { findTicketInPartner } from '../inboundEmail/threadMatcher';
import { listOrgTicketsForAddin } from '../ticketService';
import type {
  ContactCandidate,
  ContactCandidateKind,
  ContactCandidateProvenance,
  EmailContextResult,
  AddinOrgSummary as OrgSummary,
} from '@breeze/shared';

/**
 * Freemail domains never drive org resolution — a `bob@gmail.com` sender is
 * never mapped to a customer org just because a `customer_email_domains` row
 * happens to say `gmail.com` (it never legitimately would, but this is the
 * same defensive posture as `resolveOrgBySenderDomain`'s exact-domain rule).
 * Address-level matches (portal_users / contacts) still apply to freemail
 * senders — only the domain-guess step is skipped.
 */
export const FREEMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'mail.com',
]);

/** Ticket statuses counted as "open" for the org summary (mirrors ticketService's ADDIN_OPEN_STATUSES). */
const OPEN_TICKET_STATUSES = ['new', 'open', 'pending', 'on_hold'] as const;

export interface EmailContextInput {
  from: { email: string; name?: string | null };
  sender?: { email: string; name?: string | null } | null;
  internetMessageId?: string | null;
  references?: string[] | null;
  inReplyTo?: string | null;
  subject: string;
  conversationId?: string | null;
  itemGeneration: number;
}

// Wire shapes live in @breeze/shared (types/officeAddin.ts) so the add-in
// client consumes the same definitions this service produces. Re-exported
// under the names this module has always exposed.
export type {
  ContactCandidate,
  ContactCandidateKind,
  ContactCandidateProvenance,
  EmailContextResult,
} from '@breeze/shared';
export type { AddinOrgSummary as OrgSummary } from '@breeze/shared';

/** Lowercased domain part of an email address, or null if malformed. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

// Address-level identity resolution: portal_users (partner-scoped join
// organizations) and contacts (org_id direct), both matched on the represented
// `from` address. Rows outside `tech.accessibleOrgIds` are dropped here
// (app-layer narrowing — partner-axis RLS is flat and does not enforce a
// selected-org technician's narrower grant, spec §3.1).
async function findAddressMatches(
  email: string,
  tech: OfficeAddinTechAuth
): Promise<ContactCandidate[]> {
  const [portalRows, contactRows] = await Promise.all([
    db
      .select({
        id: portalUsers.id,
        name: portalUsers.name,
        email: portalUsers.email,
        orgId: portalUsers.orgId,
      })
      .from(portalUsers)
      .innerJoin(organizations, eq(portalUsers.orgId, organizations.id))
      .where(
        and(
          sql`lower(${portalUsers.email}) = ${email}`,
          eq(organizations.partnerId, tech.partnerId)
        )
      )
      .limit(20),
    db
      .select({
        id: contacts.id,
        name: contacts.name,
        email: contacts.email,
        orgId: contacts.orgId,
      })
      .from(contacts)
      .innerJoin(organizations, eq(contacts.orgId, organizations.id))
      .where(
        and(
          sql`lower(${contacts.email}) = ${email}`,
          eq(organizations.partnerId, tech.partnerId)
        )
      )
      .limit(20),
  ]);

  const candidates: ContactCandidate[] = [
    ...portalRows.map(
      (r): ContactCandidate => ({
        kind: 'portal_user',
        id: r.id,
        name: r.name,
        email: r.email,
        orgId: r.orgId,
        provenance: 'address_match',
      })
    ),
    ...contactRows.map(
      (r): ContactCandidate => ({
        kind: 'contact',
        id: r.id,
        name: r.name,
        email: r.email ?? email,
        orgId: r.orgId,
        provenance: 'address_match',
      })
    ),
  ];

  return candidates.filter((c) => tech.canAccessOrg(c.orgId));
}

// Domain-level org resolution (skipped for freemail domains). Same
// exact-domain semantics as resolveOrgBySenderDomain — do not widen to
// endsWith. Narrowed to accessibleOrgIds like every other resolution path.
async function resolveOrgByDomain(
  domain: string,
  tech: OfficeAddinTechAuth
): Promise<string | null> {
  if (FREEMAIL_DOMAINS.has(domain)) return null;
  const rows = await db
    .select({ orgId: customerEmailDomains.orgId })
    .from(customerEmailDomains)
    .where(
      and(
        eq(customerEmailDomains.partnerId, tech.partnerId),
        eq(customerEmailDomains.domain, domain),
        eq(customerEmailDomains.isActive, true)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (!tech.canAccessOrg(row.orgId)) return null;
  return row.orgId;
}

// Honesty flag (spec §8): true when the partner can actually RECEIVE
// inbound ticket email, via either path —
//   a) a connected Graph mailbox (ticket_mailbox_connections.status='connected'), or
//   b) a Mailgun inbound address, which per resolvePartnerByRecipient is either
//      a custom domain row (partner_inbound_domains) OR the platform-wide
//      {slug}@TICKETS_INBOUND_DOMAIN address — unconditionally reachable for
//      every partner (partners.slug is NOT NULL) once that env var is set.
//      There is no per-partner opt-out of the slug address today, so this
//      branch is effectively "is inbound email globally enabled at all",
//      not a per-partner setting — documented rather than modeled as a query.
async function isInboundPathConfigured(partnerId: string): Promise<boolean> {
  const [mailboxRows, customDomainRows] = await Promise.all([
    db
      .select({ id: ticketMailboxConnections.id })
      .from(ticketMailboxConnections)
      .where(
        and(eq(ticketMailboxConnections.partnerId, partnerId), eq(ticketMailboxConnections.status, 'connected'))
      )
      .limit(1),
    db
      .select({ partnerId: partnerInboundDomains.partnerId })
      .from(partnerInboundDomains)
      .where(eq(partnerInboundDomains.partnerId, partnerId))
      .limit(1),
  ]);
  if (mailboxRows[0] || customDomainRows[0]) return true;

  try {
    return Boolean(getConfig().TICKETS_INBOUND_DOMAIN);
  } catch {
    // Config not initialized in this execution context (mirrors
    // inboundEmailService's inboundDomainOrNull) — degrade to "not configured"
    // rather than throwing out of a read-only context-building path.
    return false;
  }
}

export async function buildEmailContext(
  input: EmailContextInput,
  tech: OfficeAddinTechAuth
): Promise<EmailContextResult> {
  // Represented `from` drives ALL resolution; `sender` is provenance only and
  // is never read here (spec §3.1).
  const email = input.from.email.toLowerCase();
  const domain = domainOf(email);

  const [addressMatches, matchedTicket, inboundPathConfigured] = await Promise.all([
    findAddressMatches(email, tech),
    findTicketInPartner(
      {
        messageId: input.internetMessageId ?? undefined,
        inReplyTo: input.inReplyTo ?? undefined,
        references: input.references ?? undefined,
        subject: input.subject,
      },
      tech.partnerId
    ),
    isInboundPathConfigured(tech.partnerId),
  ]);

  // Explicit projection to the wire type: the matcher row now carries
  // submittedBy/submitterEmail (sender-binding inputs, #3643) which must not
  // serialize to the add-in client, and its partnerId is nullable while the
  // partner-scoped query guarantees it here.
  const threadMatchedTicket =
    matchedTicket && tech.canAccessOrg(matchedTicket.orgId)
      ? {
          id: matchedTicket.id,
          partnerId: matchedTicket.partnerId ?? tech.partnerId,
          orgId: matchedTicket.orgId,
          status: matchedTicket.status,
          emailThreadKey: matchedTicket.emailThreadKey,
          internalNumber: matchedTicket.internalNumber,
        }
      : null;

  // org = single address-match org, else domain org, else null (ambiguity
  // across orgs -> org null; the candidates list above is never auto-picked).
  const distinctAddressOrgIds = Array.from(new Set(addressMatches.map((c) => c.orgId)));
  let orgId: string | null = null;
  if (distinctAddressOrgIds.length === 1) {
    orgId = distinctAddressOrgIds[0]!;
  } else if (distinctAddressOrgIds.length === 0 && domain) {
    orgId = await resolveOrgByDomain(domain, tech);
  }

  let org: { id: string; name: string } | null = null;
  let orgSummary: OrgSummary | null = null;
  let openTickets: EmailContextResult['openTickets'] = [];
  let recentTickets: EmailContextResult['recentTickets'] = [];

  if (orgId) {
    const orgRows = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    const orgRow = orgRows[0];
    if (orgRow) {
      org = { id: orgRow.id, name: orgRow.name };

      const [siteCountRows, deviceCountRows, openTicketCountRows, ticketsResult] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)` })
          .from(sites)
          .where(eq(sites.orgId, orgId))
          .limit(1),
        db
          .select({ count: sql<number>`count(*)` })
          .from(devices)
          .where(eq(devices.orgId, orgId))
          .limit(1),
        db
          .select({ count: sql<number>`count(*)` })
          .from(tickets)
          .where(
            and(
              eq(tickets.orgId, orgId),
              eq(tickets.partnerId, tech.partnerId),
              inArray(tickets.status, OPEN_TICKET_STATUSES),
              isNull(tickets.deletedAt)
            )
          )
          .limit(1),
        listOrgTicketsForAddin({ orgId, partnerId: tech.partnerId, submitterEmail: email }),
      ]);

      orgSummary = {
        name: orgRow.name,
        siteCount: Number(siteCountRows[0]?.count ?? 0),
        deviceCount: Number(deviceCountRows[0]?.count ?? 0),
        openTicketCount: Number(openTicketCountRows[0]?.count ?? 0),
      };
      openTickets = ticketsResult.openTickets;
      recentTickets = ticketsResult.recentTickets;
    }
  }

  return {
    itemGeneration: input.itemGeneration,
    org,
    contacts: addressMatches,
    threadMatchedTicket,
    openTickets,
    recentTickets,
    orgSummary,
    inboundPathConfigured,
  };
}

const ORG_SEARCH_LIMIT = 20;

/**
 * POST /office-addin/orgs/search backing query. `ilike` on org name, scoped
 * to the partner AND app-layer-narrowed to `tech.accessibleOrgIds`. The
 * `accessibleOrgIds === null` branch is defensive only — per the
 * `OfficeAddinTechAuth` doc, this partner-scope path never produces null
 * today (a partner-wide 'all' grant still arrives as a concrete org list) —
 * and skipping the narrowing is the correct behavior if it ever does.
 */
export async function searchOrgsForAddin(
  query: string,
  tech: OfficeAddinTechAuth
): Promise<Array<{ id: string; name: string }>> {
  const conditions = [eq(organizations.partnerId, tech.partnerId), ilike(organizations.name, `%${query}%`)];
  if (tech.accessibleOrgIds !== null) {
    conditions.push(inArray(organizations.id, tech.accessibleOrgIds));
  }
  const rows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(...conditions))
    .limit(ORG_SEARCH_LIMIT);
  return rows;
}
