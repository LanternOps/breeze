import { useState } from 'react';

import { chromeString } from '../chrome';
import { PromptCard, type PromptCardProps } from '../PromptCard';
import type { PromptFact } from '../types';

/*
 * `elevation.request@1` (#10190 W07, Task 7.3, spec 3.4): the elevation
 * request cards. The agent renders every string (catalog `elevation`
 * namespace) and the facts (program, publisher, command line, and on a deny
 * the server-sanitized reason); Assist fills `{time:<unixMs>}` /
 * `{remaining}` and draws them through the shared card.
 *
 *   - `pending`, the first question. Only when UAC is not on the secure
 *     desktop (`PromptOnSecureDesktop` = 0); otherwise the SYSTEM helper asks
 *     natively. A modal decision that may take focus (it answers what the
 *     person just did): Cancel is the safe default, first in the tab order and
 *     focused, and Esc / the close box choose it. Send request is never the
 *     default.
 *   - `waiting`: the request is with IT until the server's expiry, shown as a
 *     clock time. A non-activating card with Cancel request (safe) and Hide
 *     (neutral). Hide is a wire action the agent answers `accepted` without a
 *     change; Rust then collapses the card to its list entry
 *     (`prompt.rs` `collapses_after_accepted`). Esc and the close box hide it
 *     too; neither ever cancels the request.
 *   - `approved` / `denied` / `expired` / `failed` / `cancelled`: the outcome,
 *     with no actions. It stays on screen until the agent closes it after its
 *     8 s linger; the outcome stays in the Notifications list.
 *
 * A command line can be very long: once the request is sent (waiting and the
 * outcomes), a fact value longer than FACT_PREVIEW_CHARS code points is cut
 * with an ellipsis and a Show more / Show less toggle. The first question
 * (`pending`) is the consent surface and never cuts a fact: the person sees
 * the whole command line before Send request. Values are plain text and
 * never placeholder targets.
 */

/** Code points shown of a long fact value before Show more. */
export const FACT_PREVIEW_CHARS = 120;

function ElevationFacts({ facts, locale, cut }: { facts: PromptFact[]; locale: string; cut: boolean }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return (
    <dl className="prompt-facts">
      {facts.map((f, i) => {
        const chars = Array.from(f.value);
        const long = cut && chars.length > FACT_PREVIEW_CHARS;
        const expanded = open.has(i);
        const valueId = `elevation-fact-${i}`;
        return (
          <div key={i} className="prompt-fact">
            <dt>{f.label}</dt>
            <dd>
              <span id={valueId} data-testid={`elevation-fact-value-${i}`}>
                {long && !expanded ? `${chars.slice(0, FACT_PREVIEW_CHARS).join('')}…` : f.value}
              </span>
              {long && (
                <button
                  type="button"
                  className="prompt-fact-more"
                  aria-expanded={expanded}
                  aria-controls={valueId}
                  onClick={() => toggle(i)}
                >
                  {chromeString(expanded ? 'chrome.showLess' : 'chrome.showMore', locale)}
                </button>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function ElevationCard(props: PromptCardProps) {
  // Only the first question is a decision; every other state is a card
  // beside the person's work that never moves keyboard focus.
  return (
    <PromptCard
      {...props}
      activation={props.view.decision ? 'focus' : 'none'}
      renderFacts={(facts, locale) => (
        <ElevationFacts key={props.view.promptId} facts={facts} locale={locale} cut={props.view.state !== 'pending'} />
      )}
    />
  );
}
