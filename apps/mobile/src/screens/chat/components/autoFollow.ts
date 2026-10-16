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
