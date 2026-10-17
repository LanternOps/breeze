/** Within this many px of the bottom counts as "reading the latest". */
export const STICK_THRESHOLD_PX = 80;

export function distanceFromBottom(m: {
  contentOffsetY: number;
  contentHeight: number;
  layoutHeight: number;
}): number {
  return m.contentHeight - (m.contentOffsetY + m.layoutHeight);
}

/**
 * Whether the conversation list should scroll to the end after its content
 * changed. Sending a message always follows (#8889: it used to be skipped when
 * the user had scrolled up); streaming growth follows only while the user is
 * still near the bottom, so reading earlier messages is never yanked away.
 */
export function shouldAutoFollow(s: { sentNewUserMessage: boolean; nearBottom: boolean }): boolean {
  return s.sentNewUserMessage || s.nearBottom;
}

/**
 * Detects a freshly sent user message by comparing the newest user message in
 * the list (not just the tail — an empty assistant placeholder may be appended
 * in the same render) against the one seen last time. Returns the id to carry
 * forward; an empty list resets it.
 */
export function detectSentUserMessage(
  messages: ReadonlyArray<{ id: string; role: string }>,
  prevUserId: string | null,
): { sent: boolean; userId: string | null } {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return { sent: messages[i].id !== prevUserId, userId: messages[i].id };
    }
  }
  return { sent: false, userId: null };
}

export function isNearBottom(distance: number): boolean {
  return distance <= STICK_THRESHOLD_PX;
}
