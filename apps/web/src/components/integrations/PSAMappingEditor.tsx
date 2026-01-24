import { useCallback, useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type MappingRow = {
  id: string;
  breezeField: string;
  required: boolean;
  psaField: string;
  defaultValue: string;
  options: string[];
};

const defaultMappings: MappingRow[] = [
  {
    id: 'map-1',
    breezeField: 'Account name',
    required: true,
    psaField: 'Company',
    defaultValue: '',
    options: ['Company', 'Organization', 'Account']
  },
  {
    id: 'map-2',
    breezeField: 'Ticket summary',
    required: true,
    psaField: 'Subject',
    defaultValue: '',
    options: ['Subject', 'Summary', 'Title']
  },
  {
    id: 'map-3',
    breezeField: 'Priority',
    required: true,
    psaField: 'Priority',
    defaultValue: 'P3',
    options: ['Priority', 'Urgency', 'Severity']
  },
  {
    id: 'map-4',
    breezeField: 'Assigned team',
    required: false,
    psaField: 'Service board',
    defaultValue: 'NOC',
    options: ['Service board', 'Queue', 'Team']
  },
  {
    id: 'map-5',
    breezeField: 'Asset type',
    required: false,
    psaField: 'Configuration type',
    defaultValue: 'Endpoint',
    options: ['Configuration type', 'Asset class', 'Device type']
  }
];

export default function PSAMappingEditor() {
  const [mappings, setMappings] = useState<MappingRow[]>(defaultMappings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  const fetchMappings = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/psa/mappings');
      if (response.status === 404) {
        // No mappings saved yet, use defaults
        return;
      }
      if (!response.ok) {
        throw new Error('Failed to load PSA mappings');
      }
      const data = await response.json();
      const savedMappings = data.mappings ?? data.data ?? data ?? [];
      if (Array.isArray(savedMappings) && savedMappings.length > 0) {
        setMappings(savedMappings);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load PSA mappings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMappings();
  }, [fetchMappings]);

  const updateMapping = (id: string, field: 'psaField' | 'defaultValue', value: string) => {
    setMappings(prev => prev.map(row => (row.id === id ? { ...row, [field]: value } : row)));
    setSuccess(undefined);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(undefined);
    setSuccess(undefined);

    try {
      const response = await fetchWithAuth('/psa/mappings', {
        method: 'PUT',
        body: JSON.stringify({ mappings })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save PSA mappings');
      }

      setSuccess('PSA mappings saved successfully.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save PSA mappings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading PSA mappings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">PSA field mapping</h2>
          <p className="text-sm text-muted-foreground">
            Align Breeze fields with PSA fields for consistent sync.
          </p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Save className="h-4 w-4" />
          {saving ? 'Saving...' : 'Save mapping'}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {success && (
        <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {success}
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm font-semibold text-muted-foreground">
          Breeze fields
        </div>
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm font-semibold text-muted-foreground">
          PSA fields
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {mappings.map(row => (
          <div
            key={row.id}
            className="grid gap-4 rounded-lg border bg-background p-4 lg:grid-cols-[1fr_1fr]"
          >
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{row.breezeField}</p>
                {row.required && (
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                    Required
                  </span>
                )}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Choose how this maps in your PSA.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground">PSA field</label>
                <select
                  value={row.psaField}
                  onChange={event => updateMapping(row.id, 'psaField', event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {row.options.map(option => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Default value</label>
                <input
                  type="text"
                  value={row.defaultValue}
                  onChange={event => updateMapping(row.id, 'defaultValue', event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
