// Single source of truth for the machine-readable `code` field that rides
// alongside API error responses (see apps/api/src/lib/jsonError.ts) and the
// client-side translation seam in apps/web/src/lib/runAction.ts.
//
// Values are the on-the-wire strings (SCREAMING_SNAKE): the API emits them in
// `{ error, code }` and the web resolves `errors:<CODE>` from them. Keeping the
// key and value identical means there is exactly one string to grep for across
// api + web + locale JSON, and no indirection to get wrong.
//
// This is ADDITIVE infrastructure only (Phase-3 Task 3): adopting these codes
// on individual routes is Task 4's job, done in waves. Nothing here changes an
// existing `error` prose string.
//
// Adding a code: add the line here, then add the matching key to BOTH
// apps/web/src/locales/en/errors.json and .../pt-BR/errors.json (the locale
// parity test enforces that the two files stay in sync).

export const ERROR_CODES = {
  NOT_FOUND: 'NOT_FOUND',
  ACCESS_DENIED: 'ACCESS_DENIED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  CONFLICT: 'CONFLICT',
  LIMIT_REACHED: 'LIMIT_REACHED',
  MFA_REQUIRED: 'MFA_REQUIRED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EXPIRED: 'EXPIRED',
  AGENT_EXECUTION_FAILED: 'AGENT_EXECUTION_FAILED',
  DEVICE_UNREACHABLE: 'DEVICE_UNREACHABLE',
  DEVICE_OFFLINE: 'DEVICE_OFFLINE',
  AGENT_TIMEOUT: 'AGENT_TIMEOUT',
  PATH_NOT_FOUND: 'PATH_NOT_FOUND',
  PATH_CONFLICT: 'PATH_CONFLICT',
  AGENT_COMMAND_REJECTED: 'AGENT_COMMAND_REJECTED',
  SCHEME_NOT_ALLOWED: 'SCHEME_NOT_ALLOWED',
  INVALID_CUSTOM_FIELD_VALUE: 'INVALID_CUSTOM_FIELD_VALUE',
  RACE_LOST: 'RACE_LOST',
  RE_ENROLLMENT_REQUIRED: 'RE_ENROLLMENT_REQUIRED',
  SOFTWARE_INVENTORY_LOCK_TIMEOUT: 'SOFTWARE_INVENTORY_LOCK_TIMEOUT',
  TICKET_TRIAGE_DISABLED: 'TICKET_TRIAGE_DISABLED',
  TICKET_TRIAGE_UNAVAILABLE: 'TICKET_TRIAGE_UNAVAILABLE',
  TICKET_TRIAGE_PRIORITY_MISMATCH: 'TICKET_TRIAGE_PRIORITY_MISMATCH',
  TICKET_TRIAGE_CATEGORY_MISMATCH: 'TICKET_TRIAGE_CATEGORY_MISMATCH',
  MAILBOX_RECONSENT_REQUIRED: 'MAILBOX_RECONSENT_REQUIRED',
  ASSIGNEE_NOT_FOUND: 'ASSIGNEE_NOT_FOUND',
  ASSIGNEE_PARTNER_MISMATCH: 'ASSIGNEE_PARTNER_MISMATCH',
  ACCESS_REVIEW_SELF_DECISION: 'ACCESS_REVIEW_SELF_DECISION',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
