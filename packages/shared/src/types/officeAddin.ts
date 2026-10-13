// ============================================
// Office add-in tech-persona wire shapes
// ============================================
//
// Response shapes for the tech-persona `/office-addin/*` surface, shared
// between the producing side (`apps/api/src/services/officeAddin/emailContext.ts`
// plus `ticketService.ts` / `threadMatcher.ts` / `timeEntryService.ts`) and the
// consuming client (`apps/outlook-addin/src/tech/api.ts`). One definition here
// replaces the previously hand-mirrored copies on each side.

import type { TicketType } from '../validators/tickets';

export type ContactCandidateKind = 'portal_user' | 'contact';
export type ContactCandidateProvenance = 'address_match' | 'domain_org';

export interface ContactCandidate {
  kind: ContactCandidateKind;
  id: string;
  name: string | null;
  email: string;
  orgId: string;
  provenance: ContactCandidateProvenance;
}

export interface MatchedTicket {
  id: string;
  partnerId: string;
  orgId: string;
  status: string;
  emailThreadKey: string | null;
  internalNumber: string | null;
}

export interface AddinTicketSummary {
  id: string;
  internalNumber: string | null;
  subject: string;
  status: string;
  priority: string | null;
  /**
   * #7900: the ITIL type. Optional on the wire type because an add-in may talk
   * to an API that predates the field; current APIs always send it.
   */
  ticketType?: TicketType;
  updatedAt: string;
  submitterEmail: string | null;
  matchesSubmitter: boolean;
}

export interface AddinOrgSummary {
  name: string;
  siteCount: number;
  deviceCount: number;
  openTicketCount: number;
}

/** POST /office-addin/email-context 200 body. */
export interface EmailContextResult {
  itemGeneration: number;
  org: { id: string; name: string } | null;
  contacts: ContactCandidate[];
  threadMatchedTicket: MatchedTicket | null;
  openTickets: AddinTicketSummary[];
  recentTickets: AddinTicketSummary[];
  orgSummary: AddinOrgSummary | null;
  inboundPathConfigured: boolean;
}

/** The running-timer projection (`toRunningTimerResponse()` in
 *  `routes/officeAddin/time.ts`). */
export interface AddinRunningTimerEntry {
  id: string;
  ticketId: string | null;
  ticketInternalNumber: string | null;
  startedAt: string;
  description: string | null;
}

/** The full time-entry selection (`entrySelection()` in
 *  `services/timeEntryService.ts`), dates serialized as ISO strings. */
export interface AddinTimeEntry {
  id: string;
  partnerId: string;
  orgId: string | null;
  ticketId: string | null;
  userId: string;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
  description: string | null;
  isBillable: boolean;
  hourlyRate: string | null;
  /** Currency the entry's money is expressed in (server-stamped snapshot); null only for standalone, money-less entries. */
  currencyCode: string | null;
  billingStatus: string;
  isApproved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  ticketNumber: string | null;
  ticketSubject: string | null;
  userName: string | null;
  /**
   * #8196: set when the entry was recorded but held from billing pending
   * customer approval (`billingStatus` is `awaiting_approval`). Absent/null
   * when nothing is held.
   */
  approvalHold?: { requestId: string; trigger: 'budget' | 'after_hours' } | null;
}
