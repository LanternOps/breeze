/**
 * Shared {{variable}} substitution for ticket templates (auto-reply emails and
 * canned responses). Pure and context-agnostic: callers escape values for their
 * output format (the auto-reply path HTML-escapes; the composer inserts plain text).
 * Unknown tokens render to '' so a raw {{foo}} never reaches a customer.
 * Substitution is single-pass — values are NOT re-scanned for tokens.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    // Read the own-property value (prototype-safe), coercing a missing key to ''.
    // The ?? also satisfies noUncheckedIndexedAccess (index access is string | undefined).
    const value = Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : undefined;
    return value ?? '';
  });
}

export type TicketTemplateContext = 'autoreply' | 'canned';

export interface TicketTemplateVariable {
  key: string;
  label: string;
  contexts: TicketTemplateContext[];
}

const BOTH: TicketTemplateContext[] = ['autoreply', 'canned'];
const CANNED_ONLY: TicketTemplateContext[] = ['canned'];

export const TICKET_TEMPLATE_VARIABLES: readonly TicketTemplateVariable[] = [
  { key: 'ticket_number', label: 'Ticket number', contexts: BOTH },
  { key: 'ticket_subject', label: 'Ticket subject', contexts: BOTH },
  { key: 'requester_name', label: 'Requester name', contexts: BOTH },
  { key: 'requester_email', label: 'Requester email', contexts: BOTH },
  { key: 'org_name', label: 'Organization name', contexts: BOTH },
  { key: 'partner_name', label: 'Company name', contexts: BOTH },
  { key: 'agent_name', label: 'Your name', contexts: CANNED_ONLY },
  { key: 'current_status', label: 'Current status', contexts: CANNED_ONLY },
  { key: 'current_priority', label: 'Current priority', contexts: CANNED_ONLY },
];

export function variablesForContext(ctx: TicketTemplateContext): TicketTemplateVariable[] {
  return TICKET_TEMPLATE_VARIABLES.filter((v) => v.contexts.includes(ctx));
}
