// Ticket type (#7900): fixed ITIL core set. Labels come from i18n only
// (`tickets:ticketType.<type>`); the keys here are API values, never copy.
import { TICKET_TYPES, type TicketType } from '@breeze/shared';
import { NEUTRAL_CHIP_TEXT } from './ticketConfig';

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

/** Tailwind classes for the type chip. A type is not a status, so every type
 *  is the same neutral chip; the label carries the meaning (colour on the
 *  board is reserved for status). Text clears 4.5:1 (ticketChipContrast.test.tsx). */
export const TICKET_TYPE_CHIP_CLASS: Record<TicketType, string> = {
  incident: `bg-muted ${NEUTRAL_CHIP_TEXT}`,
  service_request: `bg-muted ${NEUTRAL_CHIP_TEXT}`,
  problem: `bg-muted ${NEUTRAL_CHIP_TEXT}`,
  change: `bg-muted ${NEUTRAL_CHIP_TEXT}`,
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
