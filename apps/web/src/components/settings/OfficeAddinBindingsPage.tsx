import '@/lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { handleActionError, runAction } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';

type Binding = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  entraTenantId: string;
  mfaVerifiedAt: string;
  createdAt: string;
};

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

function formatDate(value: string): string {
  return formatDateTime(value);
}

/**
 * Partner admin surface for the Outlook tech add-in's Entra identity → Breeze
 * technician bindings (Task 13, spec §2.2/§9). Lists active bindings for the
 * caller's own partner and lets a partner-wide admin (or system scope) revoke
 * one — revoking signs the technician out of the add-in everywhere (the API
 * also tears down every live techaddin: Redis session).
 */
export default function OfficeAddinBindingsPage() {
  const { t } = useTranslation('settings');
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<Binding | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetchWithAuth('/office-addin/bindings');
      if (response.status === 401) {
        UNAUTHORIZED();
        return;
      }
      if (!response.ok) throw new Error('load failed');
      const body = (await response.json()) as { bindings?: Binding[] };
      setBindings(body.bindings ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openConfirm = (binding: Binding) => setConfirmTarget(binding);
  const closeConfirm = () => setConfirmTarget(null);

  const confirmRevoke = async () => {
    if (!confirmTarget) return;
    setRevoking(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/office-addin/bindings/${confirmTarget.id}`, { method: 'DELETE' }),
        errorFallback: t('officeAddinBindings.revokeFailed'),
        successMessage: t('officeAddinBindings.revoked'),
        onUnauthorized: UNAUTHORIZED,
      });
      setConfirmTarget(null);
      await load();
    } catch (error) {
      handleActionError(error, t('officeAddinBindings.revokeFailed'));
    } finally {
      setRevoking(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('officeAddinBindings.loading')}</p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{t('officeAddinBindings.loadFailed')}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('officeAddinBindings.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('officeAddinBindings.title')}</h1>
        <p className="text-muted-foreground">{t('officeAddinBindings.description')}</p>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y" data-testid="office-addin-bindings-table">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('officeAddinBindings.user')}</th>
              <th className="px-4 py-3">{t('officeAddinBindings.entraTenant')}</th>
              <th className="px-4 py-3">{t('officeAddinBindings.boundOn')}</th>
              <th className="px-4 py-3">{t('officeAddinBindings.mfaVerified')}</th>
              <th className="px-4 py-3 text-right">{t('officeAddinBindings.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {bindings.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-muted-foreground">
                  {t('officeAddinBindings.empty')}
                </td>
              </tr>
            ) : (
              bindings.map((binding) => (
                <tr key={binding.id} className="transition hover:bg-muted/40">
                  <td className="px-4 py-3 text-sm">
                    <div className="font-medium">{binding.userName}</div>
                    <div className="text-xs text-muted-foreground">{binding.userEmail}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{binding.entraTenantId}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(binding.createdAt)}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(binding.mfaVerifiedAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      data-testid={`revoke-binding-${binding.id}`}
                      onClick={() => openConfirm(binding)}
                      className="rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                    >
                      {t('officeAddinBindings.revoke')}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {confirmTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('officeAddinBindings.confirmTitle')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('officeAddinBindings.confirmBody', { name: confirmTarget.userName })}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={closeConfirm}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t('officeAddinBindings.cancel')}
              </button>
              <button
                type="button"
                data-testid="confirm-revoke-binding"
                onClick={() => void confirmRevoke()}
                disabled={revoking}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('officeAddinBindings.confirmRevoke')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
