/**
 * Unsent ticket composer text per ticket, for this page session. Moving to
 * another ticket (j/k, the next-ticket offer, back to the queue) unmounts the
 * composer; a half-written reply must be there again on return, never silently
 * dropped. The mode travels with the text: an internal note restored as a
 * public reply would email the requester on Send.
 *
 * Web sign-out is same-document, so this memory outlives it. auth.ts's
 * logout() calls clearTicketComposerDrafts() directly rather than through a
 * logout hook: session expiry and the throttle mask's Sign Out reach logout()
 * without running the hooks, and the next person to sign in on this tab must
 * not find the last one's drafts. This module imports nothing from auth.ts.
 */

export type TicketComposerMode = 'reply' | 'internal';

export interface TicketComposerDraft {
  content: string;
  mode: TicketComposerMode;
  /**
   * File NAMES (never contents) of the attachments the draft had. Files cannot
   * outlive the composer, so a restored draft uses these to tell the user which
   * attachments to add again instead of posting without them silently. Cleared
   * with the text on sign-out.
   */
  attachmentNames?: string[];
}

const draftsByKey = new Map<string, TicketComposerDraft>();

export function getTicketComposerDraft(key: string): TicketComposerDraft | undefined {
  return draftsByKey.get(key);
}

export function setTicketComposerDraft(key: string, draft: TicketComposerDraft): void {
  draftsByKey.set(key, draft);
}

export function deleteTicketComposerDraft(key: string): void {
  draftsByKey.delete(key);
}

export function clearTicketComposerDrafts(): void {
  draftsByKey.clear();
}
