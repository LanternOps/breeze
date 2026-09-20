import type { TicketTemplateVars } from '@breeze/shared';
import { renderPartnerEmail } from '../emailTemplates/renderPartnerEmail';

/** Legacy wrapper. New send paths call renderPartnerEmail directly. */
export function buildAutoresponseEmail(args: {
  internalNumber: string | null;
  subject: string;
  custom?: { subject: string | null; body: string | null };
  vars?: TicketTemplateVars;
}): { subject: string; html: string } {
  return renderPartnerEmail({
    id: 'ticket_autoresponse',
    custom: null,
    vars: {
      ticket_number: args.internalNumber ?? 'your request',
      ticket_subject: args.subject,
      ...args.vars,
    },
    internalNumber: args.internalNumber,
    ticketSubject: args.subject,
    inboundAutoresponseFallback: args.custom,
  });
}
