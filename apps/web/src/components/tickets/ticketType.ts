// Ticket type (#7900): fixed ITIL core set. Labels come from i18n only
// (`tickets:ticketType.<type>`); the keys here are API values, never copy.
import { TICKET_TYPES, type TicketType } from '@breeze/shared';

export type { TicketType };

/** Display/nav order. Mirrors the shared enum so a new value cannot be missed. */
export const TICKET_TYPE_ORDER: readonly TicketType[] = TICKET_TYPES;

export function isTicketType(value: unknown): value is TicketType {
  return typeof value === 'string' && (TICKET_TYPES as readonly string[]).includes(value);
}

/** i18n key (namespace `tickets`) of a type's display label. */
export function ticketTypeLabelKey(type: TicketType): string {
  return `ticketType.${type}`;
}

/** Tailwind classes for the type chip; neutral for incident (the default). */
export const TICKET_TYPE_CHIP_CLASS: Record<TicketType, string> = {
  incident: 'bg-muted text-muted-foreground',
  service_request: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  problem: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  change: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
};

const TYPE_PREFIX = 'type=';

/**
 * The `type=` segment of a tickets-page hash (`#<selection>&sort=<s>&type=<t>`),
 * or null when absent/invalid. Shared by TicketsPage.parseHash and the sidebar
 * so both agree on what a typed hash means. Unknown values are ignored, never
 * thrown on: the hash is user-editable input.
 */
export function ticketTypeFromHash(hash: string): TicketType | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of raw.split('&')) {
    if (!part.startsWith(TYPE_PREFIX)) continue;
    const value = part.slice(TYPE_PREFIX.length);
    if (isTicketType(value)) return value;
  }
  return null;
}

/** Return `hash` with its type segment set (or removed when `type` is null). */
export function withTypeSegment(hash: string, type: TicketType | null): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = raw.split('&').filter((p) => p && !p.startsWith(TYPE_PREFIX));
  if (type) parts.push(`${TYPE_PREFIX}${type}`);
  return parts.length > 0 ? `#${parts.join('&')}` : '';
}
