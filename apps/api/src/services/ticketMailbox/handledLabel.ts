/**
 * Validation for the per-mailbox Gmail "mark handled" label name (#7949).
 * Dependency-free so the settings route can validate without loading the Gmail
 * client.
 */

/** Gmail system label names that must never be the handled label: a system
 *  label (e.g. TRASH) as the target would silently dispose of ticketed mail.
 *  CATEGORY_* is covered by the prefix check. */
const RESERVED_LABEL_NAMES = new Set([
  'INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'CHAT',
]);

/** Longest handled label name Breeze accepts (also a DB CHECK). */
export const HANDLED_LABEL_MAX_LENGTH = 100;

/** The configured handled label cannot be used (empty, too long, or a Gmail
 *  system label). Not retryable: the same name fails the same way every time. */
export class HandledLabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandledLabelError';
  }
}

/** Whether `name` may be stored and used as the handled label. */
export function isUsableHandledLabelName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed !== name || name.length > HANDLED_LABEL_MAX_LENGTH) return false;
  const upper = trimmed.toUpperCase();
  return !RESERVED_LABEL_NAMES.has(upper) && !upper.startsWith('CATEGORY_');
}

export function assertUsableHandledLabelName(name: string): void {
  if (!isUsableHandledLabelName(name)) {
    throw new HandledLabelError(`Handled label "${name}" is not usable; it must be a user label name of 1 to ${HANDLED_LABEL_MAX_LENGTH} characters, not a Gmail system label`);
  }
}
