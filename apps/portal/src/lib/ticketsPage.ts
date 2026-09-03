interface PortalResponseState {
  statusCode?: number;
  code?: string;
}

export interface TicketsPageDecision {
  ticketsDisabled: boolean;
  usageStrictlyDisabled: boolean;
  redirectToDevices: boolean;
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
    redirectToDevices: ticketsDisabled && usageResponse.statusCode !== 200,
  };
}
