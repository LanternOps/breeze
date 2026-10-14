import type { PortalHourBlockDto, PortalHourBlockResponse } from '@breeze/shared';

interface PortalResponseState {
  statusCode?: number;
  code?: string;
}

export interface TicketsPageDecision {
  ticketsDisabled: boolean;
  usageStrictlyDisabled: boolean;
  redirectHome: boolean;
}

export function decideTicketsPage(
  ticketsResponse: PortalResponseState,
  usageResponse: PortalResponseState,
): TicketsPageDecision {
  const ticketsDisabled =
    ticketsResponse.statusCode === 403 &&
    ticketsResponse.code === 'PORTAL_TICKETS_DISABLED';
  const usageStrictlyDisabled = usageResponse.statusCode === 403;

  return {
    ticketsDisabled,
    usageStrictlyDisabled,
    redirectHome: ticketsDisabled && usageResponse.statusCode !== 200,
  };
}

/**
 * The Support hours card is fetched only when the MSP turned the flag on AND
 * the Support usage section itself loaded — the endpoint sits behind both, so
 * asking otherwise is a guaranteed 403 on every page view.
 */
export function shouldLoadHourBlock(
  branding: { enableHourBlock?: boolean },
  usageResponse: PortalResponseState,
): boolean {
  return branding.enableHourBlock === true && usageResponse.statusCode === 200;
}

/**
 * What the panel gets. A 403 is the flag having flipped between the branding
 * read and this one: quietly no card. Any other failure is reported — a
 * balance that vanishes without a word reads as "no hours left".
 */
export function hourBlockPanelState(
  response: { data?: PortalHourBlockResponse; statusCode?: number } | null,
): { hourBlock: PortalHourBlockDto | null; hourBlockStartsOn: string | null; hourBlockError: string | undefined } {
  const none = { hourBlock: null, hourBlockStartsOn: null, hourBlockError: undefined };
  if (!response) return none;
  if (response.data !== undefined) {
    return {
      hourBlock: response.data.hourBlock,
      hourBlockStartsOn: response.data.startsOn,
      hourBlockError: undefined,
    };
  }
  if (response.statusCode === 403) return none;
  return { ...none, hourBlockError: 'Your support hours could not be loaded right now.' };
}
