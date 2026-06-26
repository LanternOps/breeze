import { useState } from 'react';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { enrichCatalogItemRequest, type CatalogItemType, type EnrichResult } from '../../lib/api/catalog';

interface CatalogEnrichButtonProps {
  /** Bias the AI toward this item type (passed as `hint`). */
  hint?: CatalogItemType;
  disabled?: boolean;
  /** Disambiguates data-testids when multiple instances mount on one page. */
  idSuffix: string;
  /** Host maps the draft into its form and stashes provenance for save. */
  onApply: (result: EnrichResult) => void;
}

export default function CatalogEnrichButton({ hint, disabled, idSuffix, onApply }: CatalogEnrichButtonProps) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [guidance, setGuidance] = useState<string | null>(null);

  const run = async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    try {
      const result = await runAction<EnrichResult>({
        request: () => enrichCatalogItemRequest(q, hint),
        errorFallback: "Couldn't auto-fill — enter details manually.",
        parseSuccess: (data) => (data as { data: EnrichResult }).data,
      });
      onApply(result);
      setGuidance(result.priceGuidance);
    } catch (err) {
      // runAction already toasted any ActionError; only cover the non-ActionError case.
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
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={() => void run()}
          disabled={disabled || busy || !query.trim()}
          data-testid={`catalog-enrich-btn-${idSuffix}`}
          className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {busy ? 'Filling…' : '✨ Auto-fill from web'}
        </button>
      </div>
      {guidance && (
        <p data-testid={`catalog-enrich-guidance-${idSuffix}`} className="text-xs text-muted-foreground">
          AI estimate: {guidance} — enter your price below.
        </p>
      )}
    </div>
  );
}
