import { useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useOrgStore } from '@/stores/orgStore';
import { useTranslation } from 'react-i18next';

/**
 * Shown when the org context itself failed to load (the /orgs/organizations or
 * /orgs/partners fetch errored), so pages can tell a broken context apart from
 * an empty one. The store records the failure in `orgStore.error`; nothing else
 * surfaces it, which is exactly how a fetch failure used to render as a blank
 * page. Retry re-runs the resolution (partners first if we never got them, so
 * the auto-select can follow).
 */
export function OrgLoadFailedState({ error }: { error?: string | null }) {
  const { t } = useTranslation('common');
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const store = useOrgStore.getState();
      if (store.partners.length === 0) await store.fetchPartners();
      else await store.fetchOrganizations();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      data-testid="org-load-failed-state"
      className="flex flex-col items-center rounded-lg border border-dashed px-6 py-12 text-center"
    >
      <AlertTriangle className="h-8 w-8 text-destructive" aria-hidden="true" />
      <h2 className="mt-3 text-base font-semibold">{t('layout.orgLoadFailed.title')}</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        {error || t('layout.orgLoadFailed.description')}
      </p>
      <button
        type="button"
        onClick={() => void retry()}
        disabled={retrying}
        className="mt-5 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60"
      >
        {retrying ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        {t('layout.orgLoadFailed.retry')}
      </button>
    </div>
  );
}
