// Shared plumbing for the quote editor's split modules (QuoteEditor hub +
// QuoteLineRows / QuoteBlockCard / QuoteContractBlockEditor). Extracted when
// the pre-split QuoteEditor.tsx approached 4,000 lines. The save-language
// itself (dirty border / saved pulse / SR cues) now lives in shared/saveCues,
// where the invoice editor uses the same implementation — this module keeps the
// quote-specific pieces and re-exports the rest so quote call sites are stable.
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { navigateTo } from '@/lib/navigation';
import {
  SrSaved as SharedSrSaved,
  unsavedHintId as sharedUnsavedHintId,
} from '../shared/saveCues';
import type { QuoteLineRecurrence } from './quoteTypes';

export { useSavedFlash, fieldRing, seamless, UnsavedFieldHint } from '../shared/saveCues';

export const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

// "Show cost & margin" governs EVERY internal-economics surface — the per-line
// cost/markup bands AND the rail's Margin panel — so one toggle honestly means
// "no margin on screen" (a tech screen-sharing with a client must be able to
// trust it). Collapsed by default; the choice persists per browser so daily
// margin-watchers aren't re-toggling on every quote. The implementation is
// billingUi's useShowMargin — ONE storage key and persistence rule across
// every quote and invoice surface — re-exported here under a name matching
// the quote editor's `showInternal` vocabulary.
export { useShowMargin as useShowInternalMargin } from '../billingUi';

/** Builders for the editor's pending-scope keys. The producer (QuoteEditor's
 *  runScoped) and the consumers (BlockCard/EditableLineRow's isPending) live
 *  in different modules; a hand-typed key that drifts on either side fails
 *  SILENTLY as "never pending" — no disabled state, no double-submit guard —
 *  so both sides must build keys through these. */
export const pendingKey = {
  /** Block-level mutations: content save, remove-block. */
  block: (blockId: string) => `block:${blockId}`,
  /** The add-line flows of one block (catalog pick, SKU, manual form). */
  addLine: (blockId: string) => `add-line:${blockId}`,
  /** Whole-line mutations: remove, move, image attach. */
  line: (lineId: string) => `line:${lineId}`,
  /** One field's blur-save on a line (scopes the busy state to that input). */
  lineField: (lineId: string, field: string) => `line:${lineId}:${field}`,
};

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

// Quote-flavored SrSaved: same shared live region, with the quote editor's
// default "Saved" label so the many existing call sites don't each pass one.
export function SrSaved({ show, label, testId }: { show: boolean; label?: string; testId?: string }) {
  const { t } = useTranslation('billing');
  return <SharedSrSaved show={show} label={label ?? t('quotes.editor.status.saved')} testId={testId} />;
}

// Quote-prefixed ids for the SR-only "Unsaved" field descriptions.
export function unsavedHintId(lineId: string, field: string): string {
  return sharedUnsavedHintId('quote-line', lineId, field);
}
