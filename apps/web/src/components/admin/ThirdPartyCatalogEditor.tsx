import { useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';

export type CatalogEditorInitial = {
  id?: string;
  source?: string;
  packageId?: string;
  vendor?: string;
  friendlyName?: string;
  category?: string;
  defaultSeverity?: string;
  breezeTested?: boolean;
  notes?: string | null;
  homepageUrl?: string | null;
};

interface Props {
  initial?: CatalogEditorInitial;
  onClose: () => void;
  onSaved: () => void;
}

const severities = ['critical', 'important', 'moderate', 'low', 'unknown'] as const;

export default function ThirdPartyCatalogEditor({ initial, onClose, onSaved }: Props) {
  const editing = Boolean(initial?.id);
  const [packageId, setPackageId] = useState(initial?.packageId ?? '');
  const [vendor, setVendor] = useState(initial?.vendor ?? '');
  const [friendlyName, setFriendlyName] = useState(initial?.friendlyName ?? '');
  const [defaultSeverity, setDefaultSeverity] = useState(initial?.defaultSeverity ?? 'unknown');
  const [breezeTested, setBreezeTested] = useState(initial?.breezeTested ?? false);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [homepageUrl, setHomepageUrl] = useState(initial?.homepageUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const canSubmit = packageId.trim() && vendor.trim() && friendlyName.trim();

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(undefined);
    try {
      const body = {
        source: 'third_party',
        packageId: packageId.trim(),
        vendor: vendor.trim(),
        friendlyName: friendlyName.trim(),
        defaultSeverity,
        breezeTested,
        notes: notes.trim() ? notes.trim() : null,
        homepageUrl: homepageUrl.trim() ? homepageUrl.trim() : null,
      };
      const url = editing
        ? `/third-party-catalog/${initial!.id}`
        : '/third-party-catalog';
      const response = await fetchWithAuth(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err?.error ?? `Save failed (${response.status})`);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-testid="catalog-editor-modal"
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
    >
      <div className="bg-white rounded-lg shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-medium">
            {editing ? 'Edit catalog entry' : 'Add catalog entry'}
          </h2>
          <button
            data-testid="catalog-editor-close"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {error && (
            <div className="bg-red-50 text-red-800 px-3 py-2 rounded text-sm">{error}</div>
          )}

          <div>
            <label className="block text-sm font-medium mb-1">Winget package ID</label>
            <input
              data-testid="catalog-editor-packageId"
              type="text"
              value={packageId}
              onChange={(e) => setPackageId(e.target.value)}
              placeholder="e.g. Mozilla.Firefox"
              className="w-full border rounded px-3 py-2 text-sm font-mono"
              disabled={editing}
            />
            {editing && (
              <p className="text-xs text-gray-500 mt-1">Package ID cannot be changed once saved.</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Vendor</label>
              <input
                data-testid="catalog-editor-vendor"
                type="text"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                placeholder="Mozilla"
                className="w-full border rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Friendly name</label>
              <input
                data-testid="catalog-editor-friendlyName"
                type="text"
                value={friendlyName}
                onChange={(e) => setFriendlyName(e.target.value)}
                placeholder="Mozilla Firefox"
                className="w-full border rounded px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Default severity</label>
              <select
                data-testid="catalog-editor-severity"
                value={defaultSeverity}
                onChange={(e) => setDefaultSeverity(e.target.value)}
                className="w-full border rounded px-3 py-2 text-sm"
              >
                {severities.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm">
                <input
                  data-testid="catalog-editor-tested"
                  type="checkbox"
                  checked={breezeTested}
                  onChange={(e) => setBreezeTested(e.target.checked)}
                />
                Breeze-tested
              </label>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Homepage URL</label>
            <input
              data-testid="catalog-editor-homepage"
              type="url"
              value={homepageUrl}
              onChange={(e) => setHomepageUrl(e.target.value)}
              placeholder="https://example.com"
              className="w-full border rounded px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Notes</label>
            <textarea
              data-testid="catalog-editor-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full border rounded px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-3">
          <button
            data-testid="catalog-editor-cancel"
            onClick={onClose}
            className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded"
          >
            Cancel
          </button>
          <button
            data-testid="catalog-editor-submit"
            onClick={submit}
            disabled={!canSubmit || saving}
            className="px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {editing ? 'Save changes' : 'Add package'}
          </button>
        </div>
      </div>
    </div>
  );
}
