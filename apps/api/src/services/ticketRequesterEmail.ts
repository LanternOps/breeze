/**
 * How two tickets' requester emails (`tickets.submitter_email`) compare:
 * trimmed and lower-cased; an empty one is none. One rule, shared by the
 * native merge's requester key (ticketMerge/execute.ts `requesterKey`) and
 * the import's resume report (ticketImport/sourceChanges.ts). A leaf module:
 * it imports nothing.
 */
export function normalizeRequesterEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized ? normalized : null;
}
