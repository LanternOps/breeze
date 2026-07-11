import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Plus, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type KnownGuest = {
  id: string;
  macAddress: string;
  label: string;
  notes: string | null;
  createdAt: string;
};

const macRegex = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

export default function KnownGuestsSettings() {
  const { t } = useTranslation('settings');
  const [guests, setGuests] = useState<KnownGuest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mac, setMac] = useState('');
  const [label, setLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchGuests = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchWithAuth('/partner/known-guests');
      if (!response.ok) {
        setError(t('knownGuestsSettings.errors.load'));
        return;
      }
      const data = await response.json();
      setGuests(data.data ?? []);
    } catch {
      setError(t('knownGuestsSettings.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { fetchGuests(); }, [fetchGuests]);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!macRegex.test(mac)) { setError(t('knownGuestsSettings.errors.invalidMac')); return; }
    if (!label.trim()) { setError(t('knownGuestsSettings.errors.labelRequired')); return; }
    setSaving(true);
    setError(null);
    try {
      const response = await fetchWithAuth('/partner/known-guests', {
        method: 'POST',
        body: JSON.stringify({ macAddress: mac, label: label.trim(), notes: notes.trim() || undefined })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setError(data?.error ?? t('knownGuestsSettings.errors.add'));
      } else {
        setMac(''); setLabel(''); setNotes('');
        await fetchGuests();
      }
    } catch {
      setError(t('knownGuestsSettings.errors.add'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      const response = await fetchWithAuth(`/partner/known-guests/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        setError(t('knownGuestsSettings.errors.remove'));
        return;
      }
      await fetchGuests();
    } catch {
      setError(t('knownGuestsSettings.errors.remove'));
    }
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <h2 className="text-lg font-semibold">{t('knownGuestsSettings.title')}</h2>
      <p className="text-sm text-muted-foreground mt-1">
        {t('knownGuestsSettings.description')}
      </p>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      <form onSubmit={handleAdd} className="mt-4 flex flex-wrap gap-3">
        <input
          type="text"
          placeholder={t('knownGuestsSettings.placeholders.mac')}
          value={mac}
          onChange={e => setMac(e.target.value)}
          className="h-9 w-48 rounded-md border bg-background px-3 text-sm font-mono focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <input
          type="text"
          placeholder={t('knownGuestsSettings.placeholders.label')}
          value={label}
          onChange={e => setLabel(e.target.value)}
          className="h-9 flex-1 min-w-48 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <input
          type="text"
          placeholder={t('knownGuestsSettings.placeholders.notes')}
          value={notes}
          onChange={e => setNotes(e.target.value)}
          className="h-9 flex-1 min-w-48 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {t('common:actions.add')}
        </button>
      </form>

      <div className="mt-4 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('knownGuestsSettings.columns.macAddress')}</th>
              <th className="px-4 py-3">{t('knownGuestsSettings.columns.label')}</th>
              <th className="px-4 py-3">{t('knownGuestsSettings.columns.notes')}</th>
              <th className="px-4 py-3 text-right">{t('common:labels.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">{t('common:states.loading')}</td></tr>
            ) : guests.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">{t('knownGuestsSettings.empty')}</td></tr>
            ) : guests.map(guest => (
              <tr key={guest.id} className="hover:bg-muted/40">
                <td className="px-4 py-3 font-mono text-sm">{guest.macAddress}</td>
                <td className="px-4 py-3 text-sm">{guest.label}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{guest.notes ?? '\u2014'}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => handleRemove(guest.id)}
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-destructive/30 text-destructive hover:bg-destructive/10 ml-auto"
                    title={t('common:actions.remove')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
