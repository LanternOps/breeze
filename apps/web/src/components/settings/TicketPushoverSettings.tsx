import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';

const KEY_PATTERN = /^[A-Za-z0-9]{30}$/;

/**
 * The signed-in user's own Pushover user key for ticket assignments. The key is
 * write-only: the API seals it and only ever reports whether one is set.
 */
export default function TicketPushoverSettings() {
  const { t } = useTranslation('settings');
  const [keySet, setKeySet] = useState<boolean | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth('/users/me/ticket-pushover');
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { userKeySet: boolean };
        if (!cancelled) setKeySet(body.userKeySet);
      } catch {
        if (!cancelled) setError(t('ticketPushover.loadFailed'));
      }
    })();
    return () => { cancelled = true; };
  }, [t]);

  const save = async (method: 'PUT' | 'DELETE') => {
    setError(undefined);
    setSuccess(undefined);
    if (method === 'PUT' && !KEY_PATTERN.test(draft.trim())) {
      setError(t('ticketPushover.invalidKey'));
      return;
    }
    setBusy(true);
    try {
      const body = await runAction<{ userKeySet: boolean }>({
        request: () => fetchWithAuth('/users/me/ticket-pushover', {
          method,
          ...(method === 'PUT'
            ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userKey: draft.trim() }) }
            : {}),
        }),
        errorFallback: t('ticketPushover.saveFailed'),
        parseSuccess: (data) => {
          const v = data as { userKeySet?: unknown };
          if (typeof v?.userKeySet !== 'boolean') throw new Error('unexpected response');
          return { userKeySet: v.userKeySet };
        },
      });
      setKeySet(body.userKeySet);
      setDraft('');
      setSuccess(body.userKeySet ? t('ticketPushover.saved') : t('ticketPushover.removed'));
    } catch (err) {
      setError(err instanceof ActionError ? err.message : t('ticketPushover.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="ticket-pushover-settings">
      <h2 className="text-lg font-semibold">{t('ticketPushover.title')}</h2>
      <p className="text-sm text-muted-foreground mt-1 mb-4">{t('ticketPushover.description')}</p>
      <p className="text-sm mb-3" data-testid="ticket-pushover-status">
        {keySet === null ? '' : keySet ? t('ticketPushover.statusSet') : t('ticketPushover.statusNotSet')}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="password"
          autoComplete="off"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('ticketPushover.placeholder')}
          maxLength={30}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          data-testid="ticket-pushover-key"
        />
        <button
          type="button"
          onClick={() => void save('PUT')}
          disabled={busy || draft.trim() === ''}
          className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
          data-testid="ticket-pushover-save"
        >
          {t('ticketPushover.save')}
        </button>
        {keySet && (
          <button
            type="button"
            onClick={() => void save('DELETE')}
            disabled={busy}
            className="h-10 rounded-md border px-4 text-sm font-medium disabled:opacity-50"
            data-testid="ticket-pushover-remove"
          >
            {t('ticketPushover.remove')}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
      {success && <p className="mt-2 text-sm text-emerald-600">{success}</p>}
    </div>
  );
}
