import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { shouldAnnounce } from './a11y';
import { formatRemaining, remainingSeconds } from './countdown';
import { applyPlaceholders } from './placeholders';
import type { ActionOutcome, ActionRole, ActionVia, PromptActionSpec, PromptView } from './types';
import './prompt.css';

/*
 * One prompt card (#10190). The copy is agent-rendered and shown as text only
 * (never markup); Assist fills `{remaining}` / `{time:}` and owns the chrome.
 * English chrome strings for W02; the shared catalog localizes them in W03.
 *
 * Keyboard: the safe action comes first in the tab order and holds focus on
 * mount (focus inside a non-activating window does not take OS focus). Esc
 * chooses the safe action on a pending decision and hides the card otherwise.
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

export function PromptCard({
  view,
  nowMs,
  onAction,
  onHide,
  error,
}: {
  view: PromptView;
  nowMs: number;
  onAction: (actionId: string, via: ActionVia) => void;
  onHide: () => void;
  /** Why the last action could not be sent (no agent session, ...). */
  error?: string | null;
}) {
  const deadline = view.countdownDeadlineUnixMs;
  const fill = (text: string) => applyPlaceholders(text, nowMs, view.locale, deadline);
  const actions = view.closed ? [] : orderActions(view.actions);
  const pending = view.pendingActionId !== null;
  const firstAction = useRef<HTMLButtonElement | null>(null);

  // The safe action (first in order) holds focus from the first paint.
  useLayoutEffect(() => {
    firstAction.current?.focus();
  }, [view.promptId]);

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
      setAnnouncement(`${formatRemaining(deadline, nowMs)} remaining`);
    }
    prevSeconds.current = seconds;
  }, [seconds, deadline, nowMs]);

  const notice = error || view.lastError || outcomeMessage(view.lastOutcome);
  const titleId = `prompt-title-${view.promptId}`;

  return (
    <div
      className={`prompt-card is-${view.state}`}
      role={view.decision ? 'alertdialog' : 'dialog'}
      aria-labelledby={titleId}
      dir={view.direction}
      lang={view.locale}
      data-testid="prompt-card"
    >
      {/* W03 replaces this with the MSP identity header (prompt_branding_sync). */}
      <div className="prompt-identity" data-testid="prompt-identity">
        From your IT provider
      </div>
      <h1 className="prompt-title" id={titleId}>
        {fill(view.copy.title)}
      </h1>
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
      {notice && (
        <div className="prompt-notice" role="alert">
          {notice}
        </div>
      )}
      {pending && <div className="prompt-working">Working…</div>}
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
    </div>
  );
}
