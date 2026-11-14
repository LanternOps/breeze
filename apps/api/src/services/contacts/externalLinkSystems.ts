/**
 * Reserved `contact_external_links.system` namespaces (#8313 W4b; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.13). A ticket import marks the contacts it created with a link whose
 * system is `ticket-import:<sourceId>`, and lists and removes them as a set by
 * that system. A writer that takes the system from a caller (the CSV contact
 * importer, a future sync) must refuse it, or a caller could adopt an
 * existing contact into an import's set (and have it removed with it), or
 * match an import's contact by its link.
 */
export const TICKET_IMPORT_LINK_SYSTEM_PREFIX = 'ticket-import:';

/** The system a ticket import source marks its created contacts with. */
export function ticketImportLinkSystem(sourceId: string): string {
  return `${TICKET_IMPORT_LINK_SYSTEM_PREFIX}${sourceId}`;
}

/** True for a system only the ticket import may write (case and surrounding space ignored). */
export function isReservedContactLinkSystem(system: string | null | undefined): boolean {
  return typeof system === 'string' && system.trim().toLowerCase().startsWith(TICKET_IMPORT_LINK_SYSTEM_PREFIX);
}

export class ReservedContactLinkSystemError extends Error {
  constructor(system: string) {
    super(`The external system "${system.slice(0, 64)}" is reserved for ticket imports`);
    this.name = 'ReservedContactLinkSystemError';
  }
}

/** Throws when a caller-supplied system is reserved. */
export function assertContactLinkSystemAllowed(system: string): void {
  if (isReservedContactLinkSystem(system)) throw new ReservedContactLinkSystemError(system);
}
