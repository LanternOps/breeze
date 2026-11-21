// Purchase date, edited in place in the Details tab's System section. It feeds
// the Hardware Lifecycle report. A vendor-sourced date (the manufacturer's ship
// date) says so; saving any date makes it manual, and clearing sends null.
import { useState } from 'react';
import { Check, Loader2, Pencil, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '@/lib/runAction';
import { parseDateOnly } from '@/lib/dateOnly';
import { formatDate } from '@/lib/dateTimeFormat';

export default function PurchaseDateRow({
  deviceId,
  value,
  source,
  onSaved,
}: {
  deviceId: string;
  value: string | null;
  source: 'manual' | 'vendor' | null;
  onSaved: (value: string | null) => void;
}) {
  const { t } = useTranslation('devices');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const next = draft || null;
    if (next === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/devices/${deviceId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ purchaseDate: next }),
          }),
        errorFallback: t('deviceInfoTab.purchaseDateSaveFailed'),
        successMessage: t('deviceInfoTab.purchaseDateSaved'),
      });
      onSaved(next);
      setEditing(false);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      setError(err instanceof Error ? err.message : t('deviceInfoTab.purchaseDateSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="device-purchase-date" className="py-2">
      <div className="flex items-center justify-between gap-4">
        <dt className="text-sm text-muted-foreground">
          {editing ? <label htmlFor="device-purchase-date-input">{t('deviceInfoTab.purchaseDate')}</label> : t('deviceInfoTab.purchaseDate')}
        </dt>
        <dd className="flex items-center gap-2 text-right text-sm font-medium">
          {editing ? (
            <>
              <input
                id="device-purchase-date-input"
                type="date"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save();
                  if (e.key === 'Escape') setEditing(false);
                }}
                autoFocus
                className="h-8 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                aria-label={t('deviceInfoTab.save')}
                title={t('deviceInfoTab.save')}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-primary hover:bg-primary/10"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                aria-label={t('deviceInfoTab.cancel')}
                title={t('deviceInfoTab.cancel')}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              {value ? (
                <span>
                  {formatDate(parseDateOnly(value), { year: 'numeric', month: 'short', day: 'numeric', fallback: value })}
                  {source === 'vendor' && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">{t('deviceInfoTab.purchaseDateFromVendor')}</span>
                  )}
                </span>
              ) : (
                <span className="italic text-muted-foreground">{t('deviceInfoTab.purchaseDateNotSet')}</span>
              )}
              <button
                type="button"
                onClick={() => {
                  setDraft(value ?? '');
                  setError(null);
                  setEditing(true);
                }}
                aria-label={t('deviceInfoTab.editPurchaseDate')}
                title={t('deviceInfoTab.editPurchaseDate')}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </dd>
      </div>
      {editing && (
        <p className="mt-1 text-right text-xs text-muted-foreground">
          {source === 'vendor' && draft === (value ?? '') ? t('deviceInfoTab.purchaseDateVendorHint') : t('deviceInfoTab.purchaseDateHelp')}
        </p>
      )}
      {error && <p role="alert" className="mt-1 text-right text-sm text-destructive">{error}</p>}
    </div>
  );
}
