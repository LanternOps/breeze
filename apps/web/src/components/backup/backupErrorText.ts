// Reaper- and worker-generated error text is sometimes prefixed with an
// internal routing tag, e.g. `[stale-backup-reaper] snapshot lease expired`.
// That tag is implementation detail, not something a user should have to
// decode, so strip it wherever an error message reaches the UI. Display-only
// — the underlying errorLog data is never mutated.
const INTERNAL_TAG_PREFIX = /^\[[a-z0-9]+(?:-[a-z0-9]+)*\]\s+/;

export function stripInternalTagPrefix(message: string): string {
  return message.replace(INTERNAL_TAG_PREFIX, '');
}

/** Cut error text down for a table cell. Keep the full text in the cell's title. */
export function truncateErrorSummary(message: string): string {
  return message.length > 60 ? `${message.slice(0, 57)}...` : message;
}
