import type { SiteCandidate } from '../../services/arrivalMatch';
import { formatMinutes } from '../../lib/timeFormat';

/**
 * Pure step logic and copy for the arrival sheet and the "still here?" stop
 * prompt. The RN component is a thin renderer over this.
 *
 * Copy rule: never say "tracking". The phone checks its own position and
 * suggests; nothing is recorded without a tap.
 */

export type TicketOption = { id: string; label: string };

export type SheetStep =
  | { step: 'pick-site'; candidates: SiteCandidate[]; highlighted: string | null }
  | {
      step: 'pick-ticket';
      site: SiteCandidate;
      tickets: TicketOption[];
      preselectedTicketId: string | null;
    }
  | { step: 'confirm-no-ticket'; site: SiteCandidate };

type TicketsForOrg = (orgId: string) => TicketOption[];

export const SITE_VISIT_LABEL = 'Site visit — no ticket';

export function afterSitePicked(site: SiteCandidate, ticketsForOrg: TicketsForOrg): SheetStep {
  const tickets = ticketsForOrg(site.orgId);
  if (tickets.length === 0) return { step: 'confirm-no-ticket', site };
  return {
    step: 'pick-ticket',
    site,
    tickets,
    // One open ticket is still a confirming tap, just a preselected one.
    preselectedTicketId: tickets.length === 1 ? tickets[0].id : null,
  };
}

export function initialStep(
  candidates: SiteCandidate[],
  preselect: string | null,
  ticketsForOrg: TicketsForOrg
): SheetStep {
  if (candidates.length === 1) return afterSitePicked(candidates[0], ticketsForOrg);
  // Several sites in range is always a picker, never an auto-pick.
  return { step: 'pick-site', candidates, highlighted: preselect };
}

function distanceLabel(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 10) * 10} m`;
}

export function candidateRowLabel(c: SiteCandidate): string {
  return `${c.orgName} — ${c.siteName} · ${distanceLabel(c.distanceM)}`;
}

export function arrivalCopy(step: SheetStep): { title: string; primary: string; secondary: string } {
  if (step.step === 'pick-site') {
    return { title: "You're near:", primary: 'Continue', secondary: 'Not now' };
  }
  return {
    title: `Looks like you're at ${step.site.orgName} — ${step.site.siteName}.`,
    primary: 'Start timer',
    secondary: 'Not now',
  };
}

/** Tickets the technician can start against: this org's, and not closed or resolved. */
export function openTicketsForOrg(
  tickets: Array<{
    id: string;
    orgId: string;
    status: string;
    internalNumber: string | null;
    subject: string;
  }>,
  orgId: string
): TicketOption[] {
  return tickets
    .filter((t) => t.orgId === orgId && t.status !== 'closed' && t.status !== 'resolved')
    .map((t) => ({
      id: t.id,
      label: t.internalNumber ? `${t.internalNumber} · ${t.subject}` : t.subject,
    }));
}

export function stillHereCopy(input: { placeName: string; runningMinutes: number }): {
  title: string;
  primary: string;
  secondary: string;
} {
  return {
    title: `Still at ${input.placeName}? Timer has been running ${formatMinutes(input.runningMinutes)}.`,
    primary: 'Stop',
    secondary: 'Keep running',
  };
}
