// Shared plumbing for the quote editor's split modules (QuoteEditor hub +
// QuoteLineRows / QuoteBlockCard / QuoteContractBlockEditor). Extracted when
// QuoteEditor.tsx crossed 4,000 lines — one save-language implementation, one
// place for the field-state styling contract.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { navigateTo } from '@/lib/navigation';
import type { QuoteLineRecurrence } from './quoteTypes';

export const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

export type LineUpdate = Partial<{
  name: string | null;
  description: string | null;
  quantity: number;
  unitPrice: number;
  taxable: boolean;
  recurrence: QuoteLineRecurrence;
  unitCost: number | null;
  sku: string | null;
  partNumber: string | null;
  imageId: string | null;
  depositEligible: boolean;
}>;


// Per-field blur-saves are confirmed by the amber dirty-ring clearing (sighted)
// plus the SrSaved live region (screen readers) — NOT a toast. Toasts are
// reserved for action-level events the user can't otherwise see (Line added,
// Section removed, Proposal sent, Draft deleted), which fire their own
// runAction successMessage. Per-field toasts were a storm during editing and
// double-announced alongside SrSaved, so they were removed.

// A transient "Saved" cue for the right-rail blur-to-save fields (terms, tax).
// BlockCard and EditableLineRow replicate this same pattern inline rather than
// calling the hook. Returns the on-flag (drives the SR live region) and a
// trigger; clears its timer on unmount so a late fire can't setState a gone node.
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
// readers without taking visual space, pairing with the dirty-ring clearing that
// sighted users see. The single per-field announcer (no toast), so SR users hear
// "Saved" once, not twice. testId lets tests assert the cue fired.
export function SrSaved({ show, label, testId }: { show: boolean; label?: string; testId?: string }) {
  const { t } = useTranslation('billing');
  // role="status" already implies aria-live="polite" — don't double it.
  return <span role="status" className="sr-only" data-testid={testId}>{show ? (label ?? t('quotes.editor.status.saved')) : ''}</span>;
}

// A field's save-state signal: amber BORDER while the edit is unsaved, a brief
// green border pulse when it lands, nothing at rest. Border-color (not a ring):
// the focus ring occupies the box-shadow channel, so a ring-based dirty signal
// was painted over by focus on exactly the field being edited — the one moment
// the signal matters. Border-color composes with the focus ring, never reflows
// (the border is always present, only its color changes), and uses the
// warning-strong indicator token (>=3:1 non-text on a light card).
export function fieldRing(dirty: boolean, saved: boolean): string {
  return dirty ? 'border-warning-strong' : saved ? 'border-success' : '';
}

// Seamless (document-styled) field border: at rest the border is invisible so
// the value reads as document text; hover/focus reveal the field. A state color
// (dirty amber / saved green / error red) REPLACES the base set rather than
// stacking on it, so two border-color utilities never compete.
export function seamless(state: string): string {
  return state || 'border-transparent hover:border-border focus:border-border';
}
