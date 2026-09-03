import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Power, PowerOff, RefreshCw, Lock, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
// Initializes the shared i18next singleton — see ThirdPartyCatalog.tsx for why
// this import must run before any island renders translated text.
import '../../lib/i18n';

interface AiKillStateRow {
  killed: boolean;
  epoch: number;
  reason: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

const MIN_REASON_LENGTH = 3;

/**
 * Platform-admin UI for the global AI kill switch (#4208, follow-up to #3828 /
 * PR #4168). The API + MFA + audit surface already existed
 * (`routes/admin/aiKillState.ts`); this is the first UI on top of it. Prior to
 * this, production had zero platform admins so a direct SQL `UPDATE` was the
 * only operational path (`docs/deploy/ai-kill-switch.md`) — that runbook
 * fallback still works and remains documented, this just adds a console path
 * once an admin exists.
 */
export default function AiKillSwitch() {
  const { t } = useTranslation('admin');
  const [row, setRow] = useState<AiKillStateRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [requiresPlatformAdmin, setRequiresPlatformAdmin] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchState = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth('/admin/ai-kill-state');
      if (!response.ok) {
        if (response.status === 403) {
          setRequiresPlatformAdmin(true);
          setRow(null);
          return;
        }
        throw new Error(t('admin.aiKillSwitch.errors.load'));
      }
      setRequiresPlatformAdmin(false);
      const body = await response.json();
      setRow(body.data as AiKillStateRow);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.aiKillSwitch.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchState();
  }, [fetchState]);

  const openConfirm = () => {
    setReason('');
    setConfirmOpen(true);
  };

  const closeConfirm = () => {
    setConfirmOpen(false);
    setReason('');
  };

  const mfaFriendly = (code: string) =>
    (code === 'MFA_REQUIRED' ? t('admin.aiKillSwitch.errors.mfaRequired') : undefined);

  const handleFlip = async () => {
    if (!row || reason.trim().length < MIN_REASON_LENGTH || submitting) return;
    const nextKilled = !row.killed;
    setSubmitting(true);
    try {
      const result = await runAction<{ killed: boolean; epoch: number }>({
        request: () => fetchWithAuth('/admin/ai-kill-state', {
          method: 'POST',
          body: JSON.stringify({ killed: nextKilled, reason: reason.trim() }),
        }),
        // The route responds `{ data: { killed, epoch } }` (routes/admin/aiKillState.ts) —
        // unwrap here so `result` itself is the flat snapshot.
        parseSuccess: (data) => (data as { data: { killed: boolean; epoch: number } }).data,
        successMessage: nextKilled
          ? t('admin.aiKillSwitch.notice.killed')
          : t('admin.aiKillSwitch.notice.restored'),
        errorFallback: t('admin.aiKillSwitch.errors.flip'),
        friendly: mfaFriendly,
      });
      // Apply the POST's own authoritative killed/epoch immediately — do NOT
      // wait on the fetchState() refetch below to reflect the new state. The
      // refetch's own try/catch never rethrows (it only sets `error`), so if
      // it fails right after this succeeds, the badge would otherwise still
      // show the PRE-flip state underneath the just-shown success toast — an
      // operator can't tell from the screen whether AI activity actually
      // stopped. Only provenance (updatedBy/updatedAt/reason) may lag until
      // the refetch below succeeds.
      setRow((prev) => (prev ? { ...prev, killed: result.killed, epoch: result.epoch } : prev));
      closeConfirm();
      await fetchState();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('admin.aiKillSwitch.errors.flip') });
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (requiresPlatformAdmin) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold flex items-center gap-2 mb-6">
          <Power className="w-6 h-6" /> {t('admin.aiKillSwitch.title')}
        </h1>
        <div
          data-testid="ai-kill-switch-requires-platform-admin"
          className="bg-blue-50 border border-blue-200 text-blue-900 px-6 py-8 rounded flex items-start gap-4"
        >
          <Lock className="w-6 h-6 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold mb-1">{t('admin.aiKillSwitch.platformAdmin.title')}</div>
            <div className="text-sm">{t('admin.aiKillSwitch.platformAdmin.description')}</div>
          </div>
        </div>
      </div>
    );
  }

  const canSubmit = reason.trim().length >= MIN_REASON_LENGTH && !submitting;

  return (
    <div className="p-6">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Power className="w-6 h-6" /> {t('admin.aiKillSwitch.title')}
          </h1>
          <p className="text-sm text-gray-600 mt-1 max-w-2xl">{t('admin.aiKillSwitch.description')}</p>
        </div>
        <button
          data-testid="ai-kill-switch-refresh"
          onClick={fetchState}
          className="px-3 py-2 text-sm border rounded hover:bg-gray-50 flex items-center gap-1"
        >
          <RefreshCw className="w-4 h-4" /> {t('admin.aiKillSwitch.refresh')}
        </button>
      </div>

      {error && <div className="bg-red-50 text-red-800 px-4 py-3 rounded mb-4">{error}</div>}

      {loading ? (
        <div className="text-center py-12 text-gray-500">{t('admin.aiKillSwitch.loading')}</div>
      ) : row ? (
        <div className="border rounded p-6 bg-white space-y-4 max-w-2xl">
          <div className="flex items-center gap-3">
            <span
              data-testid="ai-kill-switch-status-badge"
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium ${
                row.killed ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'
              }`}
            >
              {row.killed ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
              {row.killed ? t('admin.aiKillSwitch.status.killed') : t('admin.aiKillSwitch.status.active')}
            </span>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-gray-500">{t('admin.aiKillSwitch.fields.epoch')}</dt>
            <dd data-testid="ai-kill-switch-epoch" className="font-mono">{row.epoch}</dd>
            <dt className="text-gray-500">{t('admin.aiKillSwitch.fields.updatedBy')}</dt>
            <dd data-testid="ai-kill-switch-updated-by">{row.updatedBy ?? t('admin.aiKillSwitch.fields.none')}</dd>
            <dt className="text-gray-500">{t('admin.aiKillSwitch.fields.updatedAt')}</dt>
            <dd data-testid="ai-kill-switch-updated-at">
              {row.updatedAt ? new Date(row.updatedAt).toLocaleString() : t('admin.aiKillSwitch.fields.none')}
            </dd>
            <dt className="text-gray-500">{t('admin.aiKillSwitch.fields.lastReason')}</dt>
            <dd data-testid="ai-kill-switch-last-reason">{row.reason ?? t('admin.aiKillSwitch.fields.none')}</dd>
          </dl>

          <p className="text-xs text-gray-500">{t('admin.aiKillSwitch.impactNote')}</p>

          <button
            data-testid="ai-kill-switch-toggle"
            onClick={openConfirm}
            className={`px-4 py-2 text-sm rounded font-medium text-white flex items-center gap-2 ${
              row.killed ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            {row.killed ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
            {row.killed ? t('admin.aiKillSwitch.actions.restore') : t('admin.aiKillSwitch.actions.kill')}
          </button>
        </div>
      ) : null}

      {confirmOpen && row && (
        <div
          data-testid="ai-kill-switch-confirm-modal"
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
        >
          <div className="bg-white rounded-lg shadow-lg w-full max-w-md">
            <div className="px-6 py-4 border-b">
              <h2 className="text-lg font-medium">
                {row.killed
                  ? t('admin.aiKillSwitch.confirm.restoreTitle')
                  : t('admin.aiKillSwitch.confirm.killTitle')}
              </h2>
            </div>
            <div className="px-6 py-4 space-y-3">
              <p className="text-sm text-gray-600">
                {row.killed
                  ? t('admin.aiKillSwitch.confirm.restoreDescription')
                  : t('admin.aiKillSwitch.confirm.killDescription')}
              </p>
              <div>
                <label className="block text-sm font-medium mb-1">{t('admin.aiKillSwitch.confirm.reasonLabel')}</label>
                <textarea
                  data-testid="ai-kill-switch-confirm-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t('admin.aiKillSwitch.confirm.reasonPlaceholder')}
                  rows={3}
                  className="w-full border rounded px-3 py-2 text-sm"
                  autoFocus
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t px-6 py-3">
              <button
                data-testid="ai-kill-switch-confirm-cancel"
                onClick={closeConfirm}
                disabled={submitting}
                className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded"
              >
                {t('admin.aiKillSwitch.confirm.cancel')}
              </button>
              <button
                data-testid="ai-kill-switch-confirm-submit"
                onClick={handleFlip}
                disabled={!canSubmit}
                className={`px-3 py-2 text-sm rounded text-white flex items-center gap-2 disabled:opacity-50 ${
                  row.killed ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                {row.killed ? t('admin.aiKillSwitch.confirm.restoreSubmit') : t('admin.aiKillSwitch.confirm.killSubmit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
