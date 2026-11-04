/**
 * Refusals of the import framework's routes and stores (#8313 W4; spec
 * 2026-10-19 §5.7). The routes answer `{ error, code, details? }` with
 * `status`. The writer's own refusals stay `MigrationWindowError`.
 */
export type TicketImportErrorCode =
  | 'TICKET_IMPORT_MODULE_UNKNOWN'
  | 'TICKET_IMPORT_INVALID_URL'
  | 'TICKET_IMPORT_INVALID_OPTIONS'
  | 'TICKET_IMPORT_INVALID_CREDENTIALS'
  | 'TICKET_IMPORT_CREDENTIALS_REQUIRED'
  | 'TICKET_IMPORT_SOURCE_UNREACHABLE'
  | 'TICKET_IMPORT_SOURCE_NOT_FOUND'
  | 'TICKET_IMPORT_SOURCE_CHANGED'
  | 'TICKET_IMPORT_SOURCE_REVOKED'
  | 'TICKET_IMPORT_OWNER_REQUIRED'
  | 'TICKET_IMPORT_PRINCIPAL_NOT_FOUND'
  | 'TICKET_IMPORT_PRINCIPAL_INACTIVE'
  | 'TICKET_IMPORT_PRINCIPAL_SCOPE_MISSING'
  | 'TICKET_IMPORT_PRINCIPAL_HAS_KEY'
  | 'TICKET_IMPORT_PRINCIPAL_IN_USE'
  | 'TICKET_IMPORT_RUN_ACTIVE'
  | 'TICKET_IMPORT_MAPPING_LOCKED'
  | 'TICKET_IMPORT_MAPPING_INVALID'
  | 'TICKET_IMPORT_OBJECT_STORAGE_REQUIRED'
  | 'TICKET_IMPORT_WINDOW_NOT_FOUND'
  | 'TICKET_IMPORT_WINDOW_NOT_OPEN'
  | 'TICKET_IMPORT_WINDOW_PRINCIPAL_MISMATCH'
  | 'TICKET_IMPORT_ORGS_OUTSIDE_WINDOW'
  | 'TICKET_IMPORT_RUN_NOT_FOUND'
  | 'TICKET_IMPORT_RUN_NOT_QUEUED';

export class TicketImportError extends Error {
  constructor(
    public readonly code: TicketImportErrorCode,
    message: string,
    public readonly status: 400 | 403 | 404 | 409 | 502 | 503,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TicketImportError';
  }
}
