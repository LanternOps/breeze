import { PromptCard, type PromptCardProps } from '../PromptCard';

/*
 * `remote.consent@1` (#10190 W06, spec 3.5): "a technician wants to start a
 * remote session". The legacy ConsentDialog moved onto the prompt contract:
 * the shared card (identity header from the branding sync, the agent-rendered
 * title and body, the technician facts the server allowed, the countdown
 * sentence) with Allow (proceed) and Deny (safe, the default).
 *
 * The rules the legacy dialog had, kept here and pinned by consent.test.tsx:
 *   - Deny is first in the tab order and holds keyboard focus from the first
 *     paint (the safe action leads; PromptCard's ordering and focus).
 *   - Esc and the close box choose Deny (a pending decision's safe action).
 *   - `{remaining}` counts down to 0:00 and never below; it is display only,
 *     the agent's timer decides what an unanswered prompt means.
 *   - The countdown is announced at 60, 30 and 10 s only.
 *
 * A modal that steals focus when Rust allows it (prompt.rs plan_window:
 * remote.consent is a focus-eligible kind, rate limited), centred on screen
 * (desktop.rs place_prompt). It is an alertdialog: it needs an answer.
 */
export function ConsentCard(props: PromptCardProps) {
  return <PromptCard {...props} activation="focus" />;
}
