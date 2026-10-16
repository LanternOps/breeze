import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { deviceScriptsHash } from '@/lib/deviceScriptsLink';
import RestorePointBadge from '../restorePoints/RestorePointBadge';

/**
 * Device "System Restore" tab (#4609 W08): every System Restore checkpoint
 * Breeze requested for this device and what the device reported.
 *
 * Read-only (a GET list), so there is no mutation handler and `runAction`
 * does not apply. The list records requests and observations; it never
 * promises that a restore point exists or can be restored.
 */

const PAGE_SIZE = 50;

interface Attempt {
  requestId: string;
  trigger: string;
  status: string;
  requestedAt: string;
  attemptedAt: string | null;
  message: string | null;
  existingPointAgeMinutes: number | null;
  frequencyMinutes: number | null;
  scriptExecutionId: string | null;
}

interface Page {
  attempts: Attempt[];
  nextBefore?: string;
}

class UnauthorizedError extends Error {}

async function fetchPage(deviceId: string, before?: string): Promise<Page> {
  const qs = `limit=${PAGE_SIZE}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
  const res = await fetchWithAuth(`/devices/${deviceId}/restore-point-attempts?${qs}`);
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as Partial<Page> | null;
  // A 200 with an unexpected body must be an error, not an empty ledger:
  // "nothing recorded" is a claim about the device.
  if (!body || !Array.isArray(body.attempts)) throw new Error('Unexpected response shape');
  if (body.nextBefore !== undefined && typeof body.nextBefore !== 'string') {
    throw new Error('Unexpected nextBefore type');
  }
  return { attempts: body.attempts as Attempt[], nextBefore: body.nextBefore };
}

export default function DeviceRestorePointAttempts({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('restorePoints');
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [nextBefore, setNextBefore] = useState<string | undefined>();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  // Guards against a slow response for a previous device landing after a switch.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setState('loading');
    setMoreError(false);
    // An in-flight load-more from the previous generation will not reset this.
    setLoadingMore(false);
    try {
      const page = await fetchPage(deviceId);
      if (mine !== generation.current) return;
      setAttempts(page.attempts);
      setNextBefore(page.nextBefore);
      setState('ready');
    } catch (err) {
      if (mine !== generation.current) return;
      if (err instanceof UnauthorizedError) {
        void navigateTo('/login', { replace: true });
        return;
      }
      console.error('[restore-point-attempts] load failed', { deviceId, err });
      setState('error');
    }
  }, [deviceId]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await fetchPage(deviceId, nextBefore);
      if (mine !== generation.current) return;
      setAttempts((prev) => {
        const seen = new Set(prev.map((a) => a.requestId));
        return [...prev, ...page.attempts.filter((a) => !seen.has(a.requestId))];
      });
      setNextBefore(page.nextBefore);
    } catch (err) {
      if (mine !== generation.current) return;
      if (err instanceof UnauthorizedError) {
        void navigateTo('/login', { replace: true });
        return;
      }
      console.error('[restore-point-attempts] load more failed', { deviceId, err });
      setMoreError(true);
    } finally {
      if (mine === generation.current) setLoadingMore(false);
    }
  };

  const triggerLabel = (trigger: string) =>
    t(/* i18n-dynamic */ `list.trigger.${trigger}`, { defaultValue: trigger });

  return (
    <div className="space-y-4 rounded-lg border bg-card p-6 shadow-xs">
      <div>
        <h3 className="text-lg font-semibold">{t('list.title')}</h3>
        <p data-testid="restore-point-attempts-disclaimer" className="mt-1 text-sm text-muted-foreground">
          {t('list.disclaimer')}
        </p>
      </div>

      {state === 'loading' && (
        <div
          data-testid="restore-point-attempts-loading"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('list.loading')}
        </div>
      )}

      {state === 'error' && (
        <div
          data-testid="restore-point-attempts-error"
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          <p>{t('list.loadError')}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t('list.retry')}
          </button>
        </div>
      )}

      {state === 'ready' && attempts.length === 0 && (
        <p data-testid="restore-point-attempts-empty" className="text-sm text-muted-foreground">
          {t('list.empty')}
        </p>
      )}

      {state === 'ready' && attempts.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs font-medium text-muted-foreground">
                <th className="py-2 pr-4">{t('list.columns.requested')}</th>
                <th className="py-2 pr-4">{t('list.columns.trigger')}</th>
                <th className="py-2">{t('list.columns.outcome')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {attempts.map((a) => (
                <tr key={a.requestId} data-testid={`restore-point-attempt-row-${a.requestId}`}>
                  <td className="whitespace-nowrap py-2 pr-4 text-muted-foreground">
                    {formatDateTime(a.requestedAt)}
                  </td>
                  <td className="py-2 pr-4">
                    <span>{triggerLabel(a.trigger)}</span>
                    {a.trigger === 'script' && a.scriptExecutionId && (
                      <a
                        href={`#${deviceScriptsHash(a.scriptExecutionId)}`}
                        className="ml-2 text-xs text-primary hover:underline"
                      >
                        {t('list.viewScriptRun')}
                      </a>
                    )}
                  </td>
                  <td className="py-2">
                    <RestorePointBadge outcome={a} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {state === 'ready' && nextBefore && (
        <div className="space-y-2">
          {moreError && (
            <p data-testid="restore-point-attempts-more-error" role="alert" className="text-sm text-destructive">
              {t('list.loadMoreError')}
            </p>
          )}
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMore()}
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
          >
            {loadingMore ? t('list.loadingMore') : t('list.loadMore')}
          </button>
        </div>
      )}
    </div>
  );
}
