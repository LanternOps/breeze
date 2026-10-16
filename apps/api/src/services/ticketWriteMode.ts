/**
 * Ticket write modes (#8313; spec
 * docs/superpowers/specs/api-platform/2026-10-10-ticket-migration-windows-design.md
 * §4.1).
 *
 * The five ticketService writes the Partner API uses (createTicket,
 * updateTicketFields, changeTicketStatus, assignTicket, addTicketComment) take
 * an optional last argument. `live` is today's behaviour and the default.
 * `import` is reachable only through the import writer
 * (services/ticketImport/importWriter.ts) while a migration window is open: it
 * accepts historic values, starts no SLA clock, produces no side effect beyond
 * the rows themselves, and stamps every row with the window id.
 *
 * Three guards keep import mode off live paths (spec §9):
 *   - an `OpenWindow` is branded, and only `lockOpenWindowForWrite`
 *     (services/ticketImport/windowLock.ts) mints one;
 *   - the `kind: 'import'` literal is confined to services/ticketImport/
 *     (ticketImport/importModeConfinement.test.ts);
 *   - every side effect in the five functions goes through
 *     `ticketSideEffects(mode)` (ticketService.sideEffects.test.ts).
 */

declare const openWindowBrand: unique symbol;

/**
 * A migration window locked FOR SHARE in the current transaction, with every
 * write-time check passed (spec §4.4). Only `lockOpenWindowForWrite` can mint
 * one; holding it means the window stays open until the transaction ends.
 */
export type OpenWindow = {
  readonly [openWindowBrand]: true;
  readonly id: string;
  readonly partnerId: string;
  readonly principalId: string;
  /** The principal's display name, for author and audit fields. */
  readonly principalName: string;
  readonly orgIds: ReadonlySet<string>;
};

export type TicketWriteMode =
  | { kind: 'live' }
  /** `at` is when the source says the write happened (UTC). */
  | { kind: 'import'; window: OpenWindow; at: Date };

export type ImportTicketWriteMode = Extract<TicketWriteMode, { kind: 'import' }>;

export const LIVE_TICKET_WRITE: TicketWriteMode = Object.freeze({ kind: 'live' }) as TicketWriteMode;

export function isImportWrite(mode: TicketWriteMode): mode is ImportTicketWriteMode {
  return mode.kind === 'import';
}
