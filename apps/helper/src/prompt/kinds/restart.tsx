import { useLayoutEffect } from 'react';

import { PromptCard, type PromptCardProps } from '../PromptCard';
import type { PromptView } from '../types';

/*
 * The restart cards (#10190 W05, spec 3.3). The agent renders every string
 * (operator title / body / Restart-now label, the catalog's Postpone label
 * and consequence); Assist fills `{remaining}` and `{time:<unixMs>}` and draws
 * them through the shared card like any prompt.
 *
 * `restart.prompt@1` (`restart:<campaign>`), never activating (Rust refuses
 * `steal` for it, `prompt.rs` `never_activates`):
 *   - Postpone offered: a pending decision. Postpone is the safe default:
 *     first in the tab order, focused inside the card, and Esc / the close box
 *     choose it.
 *   - Postpone not offered (policy off, budget used, too close to the
 *     deadline): still a pending decision, with OK as the safe default beside
 *     Restart now. Restart now is never the default anywhere.
 *   An accepted Postpone or OK collapses the card to its list entry, and the
 *   next warning rung brings it back (Rust: `collapses_after_accepted`,
 *   `resurfaces_on_reshow`).
 *   Defence in depth: should a restart card ever arrive that is not a
 *   decision, nothing in it is focused (so Enter cannot restart the computer)
 *   and Esc only hides it.
 *
 * `restart.final@1` (`restart:<campaign>:final`): the closing card while the
 * OS countdown runs. It may take focus once (Rust: rate limited per
 * FOCUS_INTERVAL_MS); OK is its only action.
 *
 * Both state what happens if the person does nothing in `copy.consequence`;
 * the expiry line would say it again, so it is dropped when a consequence is
 * present.
 */

function statedOnce(view: PromptView): PromptView {
  return view.copy.consequence && view.expiryText ? { ...view, expiryText: null } : view;
}

export function RestartPromptCard(props: PromptCardProps) {
  const { view } = props;
  const decision = view.decision;

  // A card that stops being a decision must not leave Restart now holding
  // keyboard focus, even when the person had tabbed to it: Enter would then
  // restart the computer. Runs after the card's own focus effect.
  useLayoutEffect(() => {
    if (decision) return;
    const el = document.activeElement;
    if (el instanceof HTMLElement && el.classList.contains('prompt-action')) el.blur();
  }, [decision]);

  return <PromptCard {...props} view={statedOnce(view)} activation={decision ? 'focus' : 'none'} />;
}

export function RestartFinalCard(props: PromptCardProps) {
  return <PromptCard {...props} view={statedOnce(props.view)} />;
}
