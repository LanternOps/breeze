import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import { showToast } from '../shared/Toast';

const PREFERENCES_URL = '/users/me/email-preferences';

/**
 * The signed-in user's own email subscriptions. Currently one toggle: the daily
 * connection health digest (default on). In-app notices are not affected.
 */
export default function EmailNotificationSettings() {
  const { t } = useTranslation('settings');
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    (async () => {
      try {
        const res = await fetchWithAuth(PREFERENCES_URL);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { connectionHealthDigest?: unknown };
        if (typeof body?.connectionHealthDigest !== 'boolean') throw new Error('unexpected response');
        if (!cancelled) setEnabled(body.connectionHealthDigest);
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  const handleToggle = useCallback(async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth(PREFERENCES_URL, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectionHealthDigest: next }),
        }),
        errorFallback: t('emailNotificationSettings.saveFailed'),
        successMessage: next
          ? t('emailNotificationSettings.enabledToast')
          : t('emailNotificationSettings.disabledToast'),
      });
    } catch (err) {
      setEnabled(previous);
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('emailNotificationSettings.saveFailed') });
      }
    } finally {
      setSaving(false);
    }
  }, [enabled, t]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="email-notification-settings">
      <div className="flex items-center gap-2">
        <Mail className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-lg font-semibold">{t('emailNotificationSettings.title')}</h2>
      </div>
      <p className="text-sm text-muted-foreground mt-1 mb-4">{t('emailNotificationSettings.description')}</p>

      {loadFailed && (
        <div className="mb-3 flex items-center gap-3 text-sm text-destructive" role="alert">
          <span>{t('emailNotificationSettings.loadFailed')}</span>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="rounded-md border px-2 py-1 text-xs font-medium text-foreground"
            data-testid="email-digest-retry"
          >
            {t('emailNotificationSettings.retry')}
          </button>
        </div>
      )}

      <label className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">{t('emailNotificationSettings.digestLabel')}</p>
          <p className="text-sm text-muted-foreground">{t('emailNotificationSettings.digestHelp')}</p>
        </div>
        <input
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={enabled}
          disabled={loading || saving || loadFailed}
          onChange={(e) => void handleToggle(e.target.checked)}
          data-testid="email-digest-toggle"
        />
      </label>
    </div>
  );
}
