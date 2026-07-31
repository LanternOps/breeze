import type { KeyboardEvent } from "react";

/**
 * Keyboard activation for a disclosure header rendered as `role="button"`
 * rather than a native `<button>`.
 *
 * Feature-tab cards put action buttons (delete, add) *inside* the clickable
 * header. A native `<button>` wrapper would nest interactive elements and
 * React logs `In HTML, <button> cannot be a descendant of <button>. This will
 * cause a hydration error.` on every render — so headers use a
 * `role="button" tabIndex={0}` div plus this handler to keep Enter/Space
 * activation that a native button would have given for free.
 *
 * The `event.target !== event.currentTarget` guard is what makes the nested
 * buttons work: a keydown that originated on a child control is left alone so
 * pressing Enter on "Delete" deletes instead of collapsing the card.
 */
export function handleToggleKeyDown(
  event: KeyboardEvent<HTMLElement>,
  onToggle: () => void,
) {
  if (event.target !== event.currentTarget) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onToggle();
}
