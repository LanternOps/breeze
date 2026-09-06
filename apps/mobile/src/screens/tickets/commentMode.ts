/**
 * Visibility mode for the mobile ticket comment composer.
 *
 * Deliberately a leaf module: it imports nothing from react-native (not even
 * the theme barrel, which pulls `useColorScheme` in), so it is reachable from
 * the node-only Vitest config that the mobile app runs. Same reasoning as
 * `ticketCopy.ts` — the screen itself can never be imported by a test, so every
 * decision that matters has to live out here where it can be asserted.
 */

export type CommentMode = 'reply' | 'internal';

/**
 * Tab order, left to right. Reply first mirrors the web composer even though
 * mobile starts on the second tab — the toggle should not appear to have moved
 * between the two apps just because the default differs.
 */
export const COMMENT_MODES: readonly CommentMode[] = ['reply', 'internal'];

/**
 * Mobile defaults to INTERNAL. This is a deliberate divergence from the web
 * composer (`apps/web/src/components/tickets/TicketComposer.tsx`), which
 * defaults to 'reply'.
 *
 * The two failure modes are not symmetric:
 *
 *   - Wrong on the public side: a public comment on a ticket with a submitter
 *     email makes `ticketNotifyWorker` mail the requester
 *     (`apps/api/src/jobs/ticketNotifyWorker.ts:491`, the
 *     `event.payload.isPublic && !event.payload.inbound` branch). The mail is
 *     already gone by the time the technician notices. There is no recall, and
 *     deleting the comment does not unsend it.
 *
 *   - Wrong on the internal side: the note is invisible to the customer until
 *     someone re-posts it as a reply. Cost: one extra tap.
 *
 * A phone is where the mis-tap happens — one-handed, in a van, on a screen with
 * no hover state and no undo — so the safe default belongs here even though the
 * desk-bound web app can reasonably keep the other one. Flip this single
 * constant if that judgement ever changes; nothing else encodes the default.
 */
export const DEFAULT_COMMENT_MODE: CommentMode = 'internal';

/** The `isPublic` flag the API takes for a mode. The only mapping there is. */
export function isPublicForMode(mode: CommentMode): boolean {
  return mode === 'reply';
}

/** Tab copy, matching the web composer's `reply` / `internalNote` strings. */
export function modeTabLabel(mode: CommentMode): string {
  return mode === 'reply' ? 'Reply' : 'Internal note';
}

/**
 * Submit button copy. Names the consequence ("Send reply") rather than the
 * mechanism ("Post comment"), so the last thing read before the tap says
 * whether a customer is about to get an email.
 */
export function submitLabel(mode: CommentMode): string {
  return mode === 'reply' ? 'Send reply' : 'Add internal note';
}

/**
 * Placeholder copy. Mobile has no requester name on `TicketDetail`, so the
 * reply variant says "the requester" where web interpolates the name.
 */
export function composerPlaceholder(mode: CommentMode): string {
  return mode === 'reply' ? 'Reply to the requester…' : 'Add an internal note…';
}

/** Banner shown beside the tabs while internal is active (web parity). */
export const internalBannerText = 'Internal: not visible to requester';

/** Exactly the argument set `addTicketComment` takes, after the mode is applied. */
export interface CommentSubmission {
  content: string;
  isPublic: boolean;
  attachmentIds: string[];
}

/**
 * Build the `addTicketComment` arguments for a mode.
 *
 * The point of routing the submit through here is that `isPublic` is never a
 * literal at the call site: the screen previously passed a hardcoded `true`,
 * and a hardcoded boolean is exactly the kind of thing no test can see. Content
 * is trimmed here so the screen does not trim in one place and send from
 * another; an empty trimmed body is legal as long as attachments came with it
 * (the API's `addTicketCommentSchema` refines "text OR at least one
 * attachment"), so this does NOT reject it — the screen's `canSend` owns that
 * guard.
 */
export function buildCommentSubmission(input: {
  mode: CommentMode;
  text: string;
  attachmentIds: readonly string[];
}): CommentSubmission {
  return {
    content: input.text.trim(),
    isPublic: isPublicForMode(input.mode),
    attachmentIds: [...input.attachmentIds],
  };
}
