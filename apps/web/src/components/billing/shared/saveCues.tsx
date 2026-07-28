// The shared save-grammar: quiet blur-to-save cues (dirty border / green "saved"
// pulse / SR-only announcements). Extracted from quoteEditorShared, which had
// been copied into the invoice editor and the contract editor; both copies had
// since drifted, and the contract one still carried the ring-based version this
// file exists to replace.
//
// Every consumer now routes here — the quote modules via the thin
// `quoteEditorShared` adapters (which only inject the quote's default label and
// id prefix), the invoice editor and `contracts/ContractEditor` directly. One
// styling contract, one place it evolves. Adding a fourth copy is how the last
// three diverged; extend this file instead.
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
// the signal matters. Border-color composes with the focus ring instead.
//
// PRECONDITION: the field must already carry a `border` WIDTH utility. These are
// border-COLOR classes only, and Tailwind 4's preflight leaves `border-width: 0`
// on every element (this app's `@layer base` re-declares only `border-color`) —
// so on an element without one, the cue renders nothing at all and does so
// silently. That is not hypothetical: it is how the rich-text block card lost
// its cue in the ring→border migration. Given the width, the border is always
// present and only its color changes, so the signal never reflows. Pair with a
// constant `transition-colors` (NOT `transition-shadow` — border-color is not in
// the shadow property set, so the amber→green change would snap).
//
// Amber uses `warning-strong` (~4.6:1 on light, >=3:1 dark) because plain
// `--warning` is ~2.3:1, below the 3:1 non-text minimum. The green branch uses
// plain `--success` (~4.5:1 light / ~4.0:1 dark), which also clears it — and it
// is a transient confirmation backed by SrSaved, so it is not load-bearing.
export function fieldRing(dirty: boolean, saved: boolean): string {
  return dirty ? 'border-warning-strong' : saved ? 'border-success' : '';
}

// Seamless (document-styled) field border: at rest the border is invisible so
// the value reads as document text; hover/focus reveal the field. A state color
// REPLACES the base set rather than stacking on it, so two border-color
// utilities never compete. The focus-visible ring is unconditional: the revealed
// border alone is a sub-3:1 change against the page background, invisible to a
// keyboard user tabbing through — and the ring lives in the box-shadow channel,
// so it composes with the border-color save signal instead of painting over it.
//
// `invalid` is a parameter rather than something callers branch around, because
// branching around it is what callers did — `invalid ? 'border-destructive' :
// seamless(...)` reads as a legal refactor, but it drops the focus ring from the
// one field a keyboard user is actively trying to fix (these inputs all set
// `focus:outline-hidden`, so nothing else supplies an indicator). Taking the
// error state here means the bypass has no reason to exist.
export function seamless(state: string, invalid = false): string {
  const border = invalid
    ? 'border-destructive'
    : state || 'border-transparent hover:border-border focus:border-border';
  return `${border} focus-visible:ring-2 focus-visible:ring-ring`;
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
