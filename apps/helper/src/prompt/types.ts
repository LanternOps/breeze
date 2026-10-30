/**
 * What the Rust side hands a prompt card and the Notifications tab
 * (`apps/helper/src-tauri/src/ipc/prompt.rs` `PromptView`). The copy is
 * already rendered by the agent; Assist only fills the two renderer-owned
 * placeholders (`{remaining}`, `{time:<unixMs>}`) and owns the chrome.
 *
 * Assist has no `@breeze/shared` dependency (see lib/messageMarkdown.tsx), so
 * these mirror the Rust view, not the shared Zod schema.
 */

import type { MessageView } from '../components/MessageCard';

export type PromptState = 'pending' | 'waiting' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'failed';
export type PromptPresentation = 'modal' | 'card' | 'indicator' | 'list_only';
export type ActionRole = 'safe' | 'proceed' | 'neutral';
export type ActionVia = 'click' | 'keyboard';
export type ActionOutcome = 'accepted' | 'rejected_stale' | 'rejected_invalid' | 'timed_out';

export interface PromptActionSpec {
  id: string;
  label: string;
  role: ActionRole;
}

export interface PromptCopy {
  title: string;
  body?: string;
  consequence?: string;
  /** Operator (MSP) text, operator-class kinds only; rendered verbatim as text. */
  operatorNote?: string;
  stateDetail?: string;
}

export interface PromptFact {
  label: string;
  value: string;
}

export interface PromptView {
  promptId: string;
  kind: string;
  kindVersion: number;
  state: PromptState;
  presentation: PromptPresentation;
  copy: PromptCopy;
  facts: PromptFact[];
  actions: PromptActionSpec[];
  defaultActionId: string | null;
  /** A pending decision: Esc and the close box choose `safeActionId`. */
  decision: boolean;
  safeActionId: string | null;
  /** The `{remaining}` deadline (Unix ms), if the prompt has one. */
  countdownDeadlineUnixMs: number | null;
  expiryText: string | null;
  locale: string;
  direction: 'ltr' | 'rtl';
  /** An action is on its way to the agent. */
  pendingActionId: string | null;
  lastOutcome: ActionOutcome | null;
  /** Resolved or expired: kept in the list, without actions. */
  closed: boolean;
  /** Has a card window right now. */
  card: boolean;
  /** Why the last attempt to act could not be sent (e.g. the close box with no agent session). */
  lastError: string | null;
  /**
   * Rust's change counter when this view was taken. A window keeps the view
   * with the highest version, so an earlier pull that lands late never
   * overwrites a newer one.
   */
  version: number;
}

/**
 * The payload of every prompt event (`prompt-updated`, `prompt-list-updated`,
 * `prompt-identity-updated`): a change counter and nothing else (Rust
 * `VersionNotice`). A `listen()` hears these emits in every window, so a
 * window that hears one pulls what it may see through its label-checked
 * command (`get_prompt_view`, `get_notification_list`, `get_prompt_identity`).
 */
export interface VersionNotice {
  version: number;
}

/**
 * The one notification list (#10190 W04; Rust `NotificationListView`):
 * this session's prompt entries and its endpoint message cards, each newest
 * first. `version` only grows; the window keeps the highest one it has seen.
 */
export interface NotificationListView {
  version: number;
  prompts: PromptView[];
  messages: MessageView[];
}
