import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Card } from '../Card';
import { chromeString } from '../chrome';
import { IdentityHeader } from '../IdentityHeader';
import { applyPlaceholders } from '../placeholders';
import { orderActions, outcomeMessage, type PromptCardProps } from '../PromptCard';

/*
 * `remote.session@1` (#10190 W06, spec 3.5): the remote-session indicator, a
 * pill at the top of the screen that the person can click. It replaces the
 * legacy click-through `SessionBanner` for an agent that sends this kind.
 *
 *   - Collapsed: the title only ("Remote session in progress"). The window
 *     never activates (Rust never focuses an indicator) and nothing in it
 *     takes keyboard focus.
 *   - Expanded (a click on the pill): the identity header, the facts the
 *     agent sent (technician, organisation, access, started at `{time:}`) and
 *     exactly the actions it sent: `end_session` only when the policy allows
 *     it, `report_problem`. Expanding and collapsing are renderer-local (P7):
 *     no wire action; the window is resized through `onExpandedChange`.
 *   - End session: the click is a wire action; the agent answers with a
 *     `prompt_update` that swaps the actions to `end_confirm` (proceed) /
 *     `keep_session` (safe, default). That confirm comes only from the agent.
 *     While it is up, Keep session leads the tab order and holds focus, and
 *     Esc keeps the session.
 *   - Report a problem: a wire action. After the agent's `accepted`, Rust
 *     opens the main window's Request Support flow for this session
 *     (lib.rs `open_request_support`); this card cannot surface it.
 *   - Esc otherwise collapses the pill. Nothing hides it, the close box and
 *     Alt+F4 included (Rust keeps the window: prompt.rs `Dismiss::Kept`): the
 *     person must always be able to see that a remote session is running.
 *   - A failed action (rejected, timed out, not sent) opens the pill to show
 *     the notice. If the window cannot grow, the pill collapses back, so its
 *     actions are never clipped out of reach.
 *
 * Drawn by the shared `Card`, like every prompt and message card.
 */
export function SessionCard({
  view,
  nowMs,
  onAction,
  error,
  identity = null,
  logoUrl = null,
  onExpandedChange,
}: PromptCardProps) {
  const fill = (text: string) => applyPlaceholders(text, nowMs, view.locale, view.countdownDeadlineUnixMs);
  const actions = view.closed ? [] : orderActions(view.actions);
  // The agent's confirm step carries the one safe action (keep_session).
  const safe = actions.find((a) => a.role === 'safe') ?? null;
  const confirming = safe !== null;
  const pending = view.pendingActionId !== null;

  const [expanded, setExpanded] = useState(confirming);
  // A confirm step (also one replayed onto a collapsed pill) is always shown.
  useEffect(() => {
    if (confirming) setExpanded(true);
  }, [confirming]);

  // A failed or rejected action (or one that could not be sent) is never
  // hidden in the collapsed pill: open it to show the notice.
  const notice = error || view.lastError || outcomeMessage(view.lastOutcome);
  useEffect(() => {
    if (notice) setExpanded(true);
  }, [notice]);

  // The window follows the pill. It is built collapsed, so a collapsed first
  // paint needs no resize. If the window cannot grow, the pill collapses
  // back, so its actions are never clipped out of reach (Esc still keeps the
  // session on the confirm step).
  const resize = useRef(onExpandedChange);
  resize.current = onExpandedChange;
  const painted = useRef(false);
  useEffect(() => {
    const first = !painted.current;
    painted.current = true;
    if (first && !expanded) return;
    Promise.resolve(resize.current?.(expanded)).catch((err: unknown) => {
      console.warn(`[prompt] could not ${expanded ? 'expand' : 'collapse'} the session pill ${view.promptId}`, err);
      if (expanded) setExpanded(false);
    });
  }, [expanded, view.promptId]);

  // Keep session holds focus while the confirm is up.
  const safeButton = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (confirming && expanded) safeButton.current?.focus();
  }, [confirming, expanded, view.promptId]);

  // Esc: keep the session on the confirm step, else collapse. Never hide.
  const latest = useRef({ safe, pending, expanded, onAction });
  latest.current = { safe, pending, expanded, onAction };
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      const cur = latest.current;
      if (cur.safe) {
        if (!cur.pending) cur.onAction(cur.safe.id, 'keyboard');
        return;
      }
      if (cur.expanded) setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const titleId = `prompt-title-${view.promptId}`;
  const detailsId = `prompt-details-${view.promptId}`;

  return (
    <Card
      variant="prompt"
      className={`prompt-card prompt-pill is-${view.state}${expanded ? ' is-expanded' : ''}`}
      role="dialog"
      labelledBy={titleId}
      dir={view.direction}
      lang={view.locale}
      testId="prompt-card"
      kind={view.kind}
      activation="none"
      header={expanded ? <IdentityHeader identity={identity} logoUrl={logoUrl} locale={view.locale} /> : null}
      title={
        <h1 className="prompt-title prompt-pill-title" id={titleId}>
          <button
            type="button"
            className="prompt-pill-toggle"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((v) => !v)}
          >
            <span className="prompt-pill-dot" aria-hidden />
            {fill(view.copy.title)}
          </button>
        </h1>
      }
      body={
        expanded ? (
          <div className="prompt-body" id={detailsId}>
            {view.copy.body && <p>{fill(view.copy.body)}</p>}
            {view.copy.stateDetail && <p className="prompt-state-detail">{fill(view.copy.stateDetail)}</p>}
            {view.facts.length > 0 && (
              <dl className="prompt-facts">
                {view.facts.map((f, i) => (
                  <div key={i} className="prompt-fact">
                    <dt>{f.label}</dt>
                    <dd>{fill(f.value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        ) : null
      }
    >
      {expanded && notice && (
        <div className="prompt-notice" role="alert">
          {notice}
        </div>
      )}
      {expanded && pending && <div className="prompt-working">{chromeString('chrome.working', view.locale)}</div>}
      {expanded && actions.length > 0 && (
        <div className="prompt-actions" data-testid="session-actions">
          {actions.map((a) => (
            <button
              key={a.id}
              ref={a.role === 'safe' ? safeButton : undefined}
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
      {expanded && (
        <button type="button" className="helper-btn prompt-pill-less" onClick={() => setExpanded(false)}>
          {chromeString('chrome.showLess', view.locale)}
        </button>
      )}
    </Card>
  );
}
