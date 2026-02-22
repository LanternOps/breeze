import { useCallback, useEffect, useState, type FormEvent } from 'react';
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
  const [guests, setGuests] = useState<KnownGuest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mac, setMac] = useState('');
  const [label, setLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchGuests = useCallback(async () => {
    setLoading(true);
    const response = await fetchWithAuth('/partner/known-guests');
    if (!response.ok) { setError('Failed to load known guests'); setLoading(false); return; }
    const data = await response.json();
    setGuests(data.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { fetchGuests(); }, [fetchGuests]);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!macRegex.test(mac)) { setError('Invalid MAC format (XX:XX:XX:XX:XX:XX)'); return; }
    if (!label.trim()) { setError('Label is required'); return; }
    setSaving(true);
    setError(null);
    const response = await fetchWithAuth('/partner/known-guests', {
      method: 'POST',
      body: JSON.stringify({ macAddress: mac, label: label.trim(), notes: notes.trim() || undefined })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      setError(data?.error ?? 'Failed to add guest');
    } else {
      setMac(''); setLabel(''); setNotes('');
      await fetchGuests();
    }
    setSaving(false);
  };

  const handleRemove = async (id: string) => {
    const response = await fetchWithAuth(`/partner/known-guests/${id}`, { method: 'DELETE' });
    if (!response.ok) { setError('Failed to remove guest'); return; }
    await fetchGuests();
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <h2 className="text-lg font-semibold">Known Guests</h2>
      <p className="text-sm text-muted-foreground mt-1">
        Devices on this whitelist are automatically approved across all your managed organizations.
        Use this for technician laptops or other known visitor devices.
      </p>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      <form onSubmit={handleAdd} className="mt-4 flex flex-wrap gap-3">
        <input
          type="text"
          placeholder="AA:BB:CC:DD:EE:FF"
          value={mac}
          onChange={e => setMac(e.target.value)}
          className="h-9 w-48 rounded-md border bg-background px-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <input
          type="text"
          placeholder="Label (e.g. John's laptop)"
          value={label}
          onChange={e => setLabel(e.target.value)}
          className="h-9 flex-1 min-w-48 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <input
          type="text"
          placeholder="Notes (optional)"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          className="h-9 flex-1 min-w-48 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          Add
        </button>
      </form>

      <div className="mt-4 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">MAC Address</th>
              <th className="px-4 py-3">Label</th>
              <th className="px-4 py-3">Notes</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">Loading...</td></tr>
            ) : guests.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">No known guests yet.</td></tr>
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
                    title="Remove"
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
