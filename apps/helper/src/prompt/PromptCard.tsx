import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { shouldAnnounce } from './a11y';
import { Card } from './Card';
import { remainingSeconds } from './countdown';
import { chromeString } from './chrome';
import { IdentityHeader } from './IdentityHeader';
import type { PromptIdentity } from './identity';
import { applyPlaceholders } from './placeholders';
import type { ActionOutcome, ActionRole, ActionVia, PromptActionSpec, PromptView } from './types';
import './prompt.css';

/*
 * One prompt card (#10190). The copy is agent-rendered and shown as text only
 * (never markup); Assist fills `{remaining}` / `{time:}` and owns the chrome.
 * Chrome strings come from the shared catalog (`chrome.ts`) in the prompt's
 * locale; the header is the synced MSP identity (`IdentityHeader`).
 *
 * Keyboard: the safe action comes first in the tab order and holds focus on
 * mount (focus inside a non-activating window does not take OS focus), except
 * on a non-activating card (`activation="none"`, notices), which never moves
 * focus. Esc chooses the safe action on a pending decision and hides the card
 * otherwise.
 *
 * Drawn by the shared `Card` (W04), like the endpoint message card.
 */

const ROLE_ORDER: Record<ActionRole, number> = { safe: 0, proceed: 1, neutral: 2 };

/** Safe first, then proceed, then neutral; stable within a role. */
export function orderActions(actions: PromptActionSpec[]): PromptActionSpec[] {
  return actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => ROLE_ORDER[x.a.role] - ROLE_ORDER[y.a.role] || x.i - y.i)
    .map(({ a }) => a);
}

const OUTCOME_TEXT: Partial<Record<ActionOutcome, string>> = {
  rejected_stale: 'That choice is no longer available.',
  rejected_invalid: 'That choice could not be applied.',
  timed_out: "No answer from your IT provider's agent. Try again.",
};

export function outcomeMessage(outcome: ActionOutcome | null): string | null {
  return outcome ? (OUTCOME_TEXT[outcome] ?? null) : null;
}

export interface PromptCardProps {
  view: PromptView;
  nowMs: number;
  onAction: (actionId: string, via: ActionVia) => void;
  onHide: () => void;
  /** Why the last action could not be sent (no agent session, ...). */
  error?: string | null;
  /** The MSP identity from `prompt_branding_sync`; null shows the generic name. */
  identity?: PromptIdentity | null;
  logoUrl?: string | null;
  /**
   * `focus` (default): the safe action takes keyboard focus inside the card.
   * `none`: an informational card (kinds/notice.tsx) that never moves focus
   * and is a plain dialog, not an alertdialog.
   */
  activation?: 'focus' | 'none';
  /**
   * The remote-session pill (kinds/session.tsx, W06) expanded or collapsed:
   * the window grows or shrinks to fit. Renderer-local, never a wire action.
   * A rejected promise means the window did not change size. Other kinds
   * ignore it.
   */
  onExpandedChange?: (expanded: boolean) => Promise<void> | void;
}

export function PromptCard({
  view,
  nowMs,
  onAction,
  onHide,
  error,
  identity = null,
  logoUrl = null,
  activation = 'focus',
}: PromptCardProps) {
  const deadline = view.countdownDeadlineUnixMs;
  const fill = (text: string) => applyPlaceholders(text, nowMs, view.locale, deadline);
  const actions = view.closed ? [] : orderActions(view.actions);
  const pending = view.pendingActionId !== null;
  const firstAction = useRef<HTMLButtonElement | null>(null);

  // The safe action (first in order) holds focus from the first paint,
  // unless the card is non-activating.
  useLayoutEffect(() => {
    if (activation === 'focus') firstAction.current?.focus();
  }, [view.promptId, activation]);

  // Esc: the safe action on a pending decision, hide everywhere else. A layout
  // effect, so a key pressed the moment the card paints is not missed.
  const latest = useRef({ view, onAction, onHide });
  latest.current = { view, onAction, onHide };
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      const { view: v, onAction: act, onHide: hide } = latest.current;
      if (v.decision) {
        if (v.safeActionId && v.pendingActionId === null) act(v.safeActionId, 'keyboard');
        return;
      }
      hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Countdown announcements at 60 / 30 / 10 s only.
  const seconds = deadline != null ? remainingSeconds(deadline, nowMs) : null;
  const prevSeconds = useRef<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (seconds !== null && deadline != null && shouldAnnounce(prevSeconds.current, seconds)) {
      setAnnouncement(chromeString('chrome.remainingAnnounce', view.locale, { seconds }));
    }
    prevSeconds.current = seconds;
  }, [seconds, deadline, nowMs, view.locale]);

  const notice = error || view.lastError || outcomeMessage(view.lastOutcome);
  const titleId = `prompt-title-${view.promptId}`;

  return (
    <Card
      variant="prompt"
      className={`prompt-card is-${view.state}`}
      role={view.decision && activation === 'focus' ? 'alertdialog' : 'dialog'}
      labelledBy={titleId}
      dir={view.direction}
      lang={view.locale}
      testId="prompt-card"
      kind={view.kind}
      activation={activation}
      header={<IdentityHeader identity={identity} logoUrl={logoUrl} locale={view.locale} />}
      title={
        <h1 className="prompt-title" id={titleId}>
          {fill(view.copy.title)}
        </h1>
      }
      body={
      <div className="prompt-body">
        {view.copy.body && <p>{fill(view.copy.body)}</p>}
        {view.copy.stateDetail && <p className="prompt-state-detail">{fill(view.copy.stateDetail)}</p>}
        {view.copy.consequence && <p className="prompt-consequence">{fill(view.copy.consequence)}</p>}
        {view.copy.operatorNote && (
          // Operator text: verbatim, in its own block, never a placeholder target.
          <p className="prompt-operator-note" data-testid="prompt-operator-note" aria-label="Note from your IT provider">
            {view.copy.operatorNote}
          </p>
        )}
        {view.facts.length > 0 && (
          <dl className="prompt-facts">
            {view.facts.map((f, i) => (
              <div key={i} className="prompt-fact">
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {view.expiryText && <p className="prompt-expiry">{fill(view.expiryText)}</p>}
      </div>
      }
    >
      {notice && (
        <div className="prompt-notice" role="alert">
          {notice}
        </div>
      )}
      {pending && <div className="prompt-working">{chromeString('chrome.working', view.locale)}</div>}
      {actions.length > 0 && (
        <div className="prompt-actions">
          {actions.map((a, i) => (
            <button
              key={a.id}
              ref={i === 0 ? firstAction : undefined}
              type="button"
              className={`helper-btn prompt-action is-${a.role}`}
              disabled={pending}
              // detail 0 = activated from the keyboard (Enter / Space).
              onClick={(e) => onAction(a.id, e.detail === 0 ? 'keyboard' : 'click')}
            >
              {fill(a.label)}
            </button>
          ))}
        </div>
      )}
      <div className="prompt-sr-only" aria-live="polite" data-testid="prompt-announce">
        {announcement}
      </div>
    </Card>
  );
}
