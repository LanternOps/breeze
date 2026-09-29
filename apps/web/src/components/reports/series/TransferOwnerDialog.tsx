import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '@/lib/runAction';
import { Dialog } from '../../shared/Dialog';
import { fetchSeriesOwnerCandidates, transferSeriesOwner } from './seriesApi';
import type { PartnerUserOption } from './types';

type Load = { state: 'loading' } | { state: 'ready'; users: PartnerUserOption[] } | { state: 'forbidden' } | { state: 'failed' };

/** Spec §3.4 transfer-owner: every child's execution scope is re-captured server-side. */
export function TransferOwnerDialog({
  open,
  onClose,
  seriesId,
  currentOwnerId,
  onTransferred,
}: {
  open: boolean;
  onClose: () => void;
  seriesId: string;
  currentOwnerId: string | null;
  onTransferred: () => void;
}) {
  const { t } = useTranslation('reports');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [chosen, setChosen] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoad({ state: 'loading' });
    setChosen('');
    fetchSeriesOwnerCandidates()
      .then((result) => {
        if (!live) return;
        setLoad(result === 'forbidden' ? { state: 'forbidden' } : { state: 'ready', users: result });
      })
      .catch((err: unknown) => {
        if (!live) return;
        console.error('[TransferOwnerDialog] users load failed', err);
        setLoad({ state: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [open]);

  const users = load.state === 'ready' ? load.users : [];
  const others = users.filter((u) => u.id !== currentOwnerId);
  const chosenUser = users.find((u) => u.id === chosen);

  const confirm = async () => {
    if (!chosenUser) return;
    setSaving(true);
    try {
      await transferSeriesOwner(seriesId, chosenUser.id, {
        errorFallback: t('reports.series.transferOwner.failed'),
        successMessage: t('reports.series.transferOwner.transferred', { name: chosenUser.name || chosenUser.email }),
      });
      onTransferred();
      onClose();
    } catch (err) {
      handleActionError(err, t('reports.series.transferOwner.failed'));
    } finally {
      setSaving(false);
    }
  };

  const message =
    load.state === 'forbidden' ? t('reports.series.transferOwner.forbidden')
      : load.state === 'failed' ? t('reports.series.transferOwner.loadFailed')
        : load.state === 'ready' && others.length === 0 ? t('reports.series.transferOwner.noCandidates')
          : null;

  return (
    <Dialog open={open} onClose={onClose} title={t('reports.series.transferOwner.title')} maxWidth="md" className="p-6">
      <div data-testid="series-transfer-owner-dialog" className="space-y-4">
        <h2 className="text-lg font-semibold">{t('reports.series.transferOwner.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('reports.series.transferOwner.description')}</p>
        {load.state === 'loading' && <Loader2 className="h-5 w-5 animate-spin text-primary" />}
        {message && <p data-testid="series-transfer-owner-message" role="status" className="text-sm">{message}</p>}
        {load.state === 'ready' && others.length > 0 && (
          <label className="block space-y-1 text-sm">
            <span className="font-medium">{t('reports.series.transferOwner.label')}</span>
            <select
              data-testid="series-transfer-owner-select"
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t('reports.series.transferOwner.placeholder')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id} disabled={u.id === currentOwnerId}>
                  {u.id === currentOwnerId
                    ? t('reports.series.transferOwner.current', { name: u.name || u.email })
                    : u.name || u.email}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-md border px-4 text-sm hover:bg-muted">
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            data-testid="series-transfer-owner-confirm"
            disabled={!chosenUser || saving}
            onClick={() => void confirm()}
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {t('reports.series.transferOwner.confirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
