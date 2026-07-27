// The billing editors' shared save-grammar: quiet blur-to-save cues (dirty
// border / green "saved" pulse / SR-only announcements) used by both the quote
// editor modules and the invoice editor. Extracted from quoteEditorShared so the
// invoice editor stops carrying stale byte-similar local copies — one styling
// contract, one place it evolves.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';

// A transient "Saved" cue for blur-to-save fields. Returns the on-flag (drives
// the SR live region + green border pulse) and a trigger; clears its timer on
// unmount so a late fire can't setState a gone node.
export function useSavedFlash(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const flash = useCallback(() => {
    setOn(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), 1500);
  }, []);
  return [on, flash];
}

// Visually-hidden polite live region — announces a transient "Saved" to screen
// readers without taking visual space, pairing with the dirty-border clearing
// that sighted users see. The single per-field announcer (no toast), so SR users
// hear "Saved" once, not twice. testId lets tests assert the cue fired.
export function SrSaved({ show, label, testId }: { show: boolean; label: string; testId?: string }) {
  // role="status" already implies aria-live="polite" — don't double it.
  return <span role="status" className="sr-only" data-testid={testId}>{show ? label : ''}</span>;
}

// A field's save-state signal: amber BORDER while the edit is unsaved, a brief
// green border pulse when it lands, nothing at rest. Border-color (not a ring):
// the focus ring occupies the box-shadow channel, so a ring-based dirty signal
// was painted over by focus on exactly the field being edited — the one moment
// the signal matters. Border-color composes with the focus ring, never reflows
// (the border is always present, only its color changes), and uses the
// warning-strong indicator token (>=3:1 non-text on a light card). Pair with a
// constant `transition-colors` on the field.
export function fieldRing(dirty: boolean, saved: boolean): string {
  return dirty ? 'border-warning-strong' : saved ? 'border-success' : '';
}

// Seamless (document-styled) field border: at rest the border is invisible so
// the value reads as document text; hover/focus reveal the field. A state color
// (dirty amber / saved green / error red) REPLACES the base set rather than
// stacking on it, so two border-color utilities never compete. The
// focus-visible ring is unconditional: the revealed border alone is a sub-3:1
// change against the page background, invisible to a keyboard user tabbing
// through — and the ring lives in the box-shadow channel, so it composes with
// the border-color save signal instead of painting over it.
export function seamless(state: string): string {
  return `${state || 'border-transparent hover:border-border focus:border-border'} focus-visible:ring-2 focus-visible:ring-ring`;
}

// The amber dirty border (fieldRing) is a COLOR-only signal — a screen-reader
// user tabbing through a pricing-table row gets no equivalent cue that a field
// holds an unsaved edit. `unsavedHintId` builds a stable id for a field's
// SR-only "Unsaved" description; wire it to the field's `aria-describedby`
// while dirty and render `<UnsavedFieldHint id={that id} show={dirty} />`
// immediately after the field. Deliberately NOT a visible badge (per-field
// badges across a long pricing table were noisy) and NOT an aria-live
// announcement (a live region would fire on every keystroke) — just parity for
// AT users at the moment they land on the field, same as sighted users see the
// border the moment they look at it. `prefix` namespaces the ids per surface
// ('quote-line' / 'invoice-line') so the two editors can't collide.
export function unsavedHintId(prefix: string, lineId: string, field: string): string {
  return `${prefix}-${field}-unsaved-${lineId}`;
}

export function UnsavedFieldHint({ id, show }: { id: string; show: boolean }) {
  const { t } = useTranslation('billing');
  if (!show) return null;
  return <span id={id} className="sr-only">{t('billingUi.unsaved')}</span>;
}
