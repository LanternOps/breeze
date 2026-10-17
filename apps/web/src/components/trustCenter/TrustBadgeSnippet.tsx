import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { showToast } from '@/components/shared/Toast';
import { trustPublicUrl } from '@/lib/api/trustPage';

/** Escape text for interpolation into an HTML attribute value. */
export function escapeHtmlAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface Props {
  publicPath: string;
  badgePath: string;
  published: boolean;
}

/** Read-only embed snippet for the public badge, with a copy button. */
export default function TrustBadgeSnippet({ publicPath, badgePath, published }: Props) {
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.trust.badge.${key}`, vars ?? {}),
    [t],
  );
  const snippet = `<a href="${trustPublicUrl(publicPath)}"><img src="${trustPublicUrl(badgePath)}" alt="${escapeHtmlAttr(tr('alt'))}"></a>`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      showToast({ type: 'success', message: tr('copied') });
    } catch (err) {
      console.error('[TrustBadgeSnippet] clipboard write failed', err);
      showToast({ type: 'error', message: tr('copyFailed') });
    }
  };

  return (
    <section className="rounded-lg border bg-card p-4" data-testid="trust-badge-section">
      <h3 className="text-sm font-semibold">{tr('title')}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{tr('description')}</p>
      {!published && <p className="mt-1 text-xs text-muted-foreground">{tr('unpublishedNote')}</p>}
      <label className="mt-3 block text-xs font-medium text-muted-foreground" htmlFor="trust-badge-snippet">
        {tr('snippet')}
      </label>
      <textarea
        id="trust-badge-snippet"
        readOnly
        rows={3}
        value={snippet}
        className="mt-1 w-full rounded-md border bg-background p-2 font-mono text-xs"
        data-testid="trust-badge-snippet"
      />
      <button
        type="button"
        onClick={() => void copy()}
        className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        data-testid="trust-badge-copy"
      >
        {tr('copy')}
      </button>
    </section>
  );
}
