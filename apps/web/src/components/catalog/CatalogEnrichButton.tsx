import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { enrichCatalogItemRequest, type CatalogItemType, type EnrichResult } from '../../lib/api/catalog';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

interface CatalogEnrichButtonProps {
  /** Bias the AI toward this item type (passed as `hint`). */
  hint?: CatalogItemType;
  disabled?: boolean;
  /** Disambiguates data-testids when multiple instances mount on one page. */
  idSuffix: string;
  /** Called with the enrichment result. The host maps draft fields into its form;
   *  it may stash provenance for persistence (drawer) or discard it (quote line). */
  onApply: (result: EnrichResult) => void;
  /** One-line explanation of what auto-fill will touch in THIS host's form.
   *  Shown until the first result arrives (the result summary then takes over). */
  helpText?: string;
  /** Trailing hint after "AI estimate: …". Hosts that pre-fill price themselves
   *  pass their own wording (or null to omit). Default matches the drawer flow. */
  guidanceSuffix?: string | null;
}

export default function CatalogEnrichButton({
  hint, disabled, idSuffix, onApply, helpText,
  guidanceSuffix = '— enter your price below.',
}: CatalogEnrichButtonProps) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [guidance, setGuidance] = useState<string | null>(null);

  const run = async () => {
    const q = query.trim();
    if (!q || busy) return;
    setGuidance(null); // clear stale guidance from a prior query before retrying
    setBusy(true);
    try {
      const result = await runAction<EnrichResult>({
        request: () => enrichCatalogItemRequest(q, hint),
        errorFallback: "Couldn't auto-fill — enter details manually.",
        parseSuccess: (data) => (data as { data: EnrichResult }).data,
        onUnauthorized: UNAUTHORIZED,
      });
      onApply(result);
      setGuidance(result.priceGuidance);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      // runAction already toasted any non-401 ActionError; only cover the non-ActionError case.
      if (!(err instanceof ActionError)) {
        showToast({ message: "Couldn't auto-fill — enter details manually.", type: 'error' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          placeholder="Product name or SKU"
          disabled={disabled || busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void run(); } }}
          data-testid={`catalog-enrich-input-${idSuffix}`}
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={() => void run()}
          disabled={disabled || busy || !query.trim()}
          aria-busy={busy}
          data-testid={`catalog-enrich-btn-${idSuffix}`}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {busy ? 'Searching the web…' : '✨ Auto-fill from web'}
        </button>
      </div>
      {busy && (
        <p role="status" data-testid={`catalog-enrich-busy-${idSuffix}`} className="text-xs text-muted-foreground">
          Looking up product details — usually 5–15 seconds.
        </p>
      )}
      {!busy && guidance && (
        <p data-testid={`catalog-enrich-guidance-${idSuffix}`} className="text-xs text-muted-foreground">
          AI estimate: {guidance}{guidanceSuffix ? ` ${guidanceSuffix}` : ''}
        </p>
      )}
      {!busy && !guidance && helpText && (
        <p data-testid={`catalog-enrich-help-${idSuffix}`} className="text-xs text-muted-foreground">
          {helpText}
        </p>
      )}
    </div>
  );
}
