import { PromptCard, type PromptCardProps } from '../PromptCard';

/*
 * `notice.info@1` (#10190 W04, spec 3.2): an informational card plus a list
 * entry. Safe mode, the macOS permission notice (with `open_settings`, a
 * neutral action whose prompt_action the agent answers by opening System
 * Settings) and "remote session ended". The copy and the actions come from
 * the agent; the card draws them like any prompt.
 *
 * Non-activating: the window is never focused (Rust refuses `steal` for this
 * kind, `prompt.rs` plan_window), and inside it the card does not move
 * keyboard focus either. It is a plain `dialog`, not an `alertdialog`, so a
 * screen reader is not interrupted. It stays keyboard-reachable: the safe
 * action is the first tab stop and Esc chooses it.
 */
export function NoticeCard(props: PromptCardProps) {
  return <PromptCard {...props} activation="none" />;
}
