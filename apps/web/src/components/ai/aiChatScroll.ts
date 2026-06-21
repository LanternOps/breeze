/**
 * Auto-scroll pinning logic for the Breeze AI chat panel (#1713).
 *
 * Standard chat UX: keep the viewport anchored to the bottom while new messages
 * stream in, but stop yanking the user down once they scroll up to read history.
 * We decide that purely from how far the scroll container is from its bottom.
 */

// A user is considered "pinned to the bottom" while within this many pixels of
// the end. A small slack absorbs sub-pixel rounding and the height growth of an
// in-flight streamed line, so a normal reader at the bottom keeps following.
export const BOTTOM_PIN_THRESHOLD_PX = 80;

/**
 * Whether the panel should auto-scroll to the bottom on the next content change.
 *
 * @param distanceFromBottom `scrollHeight - scrollTop - clientHeight` of the
 *   scroll container (0 = exactly at the bottom; larger = scrolled up).
 * @param threshold pin slack in pixels; defaults to {@link BOTTOM_PIN_THRESHOLD_PX}.
 */
export function shouldAutoScroll(
  distanceFromBottom: number,
  threshold: number = BOTTOM_PIN_THRESHOLD_PX,
): boolean {
  // Guard against NaN (e.g. a not-yet-laid-out container in tests) by treating
  // an unmeasurable distance as "pinned" so the first paint still anchors.
  if (!Number.isFinite(distanceFromBottom)) return true;
  return distanceFromBottom <= threshold;
}
