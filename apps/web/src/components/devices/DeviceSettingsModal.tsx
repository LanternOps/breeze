import { useState, useEffect } from 'react';
import { X, Loader2, Plus, Tag, Trash2 } from 'lucide-react';
import type { Device } from './DeviceList';
import { fetchWithAuth } from '../../stores/auth';

type Site = {
  id: string;
  name: string;
};

type DeviceSettingsModalProps = {
  device: Device;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  onAction?: (action: string, device: Device) => void;
};

export default function DeviceSettingsModal({ device, isOpen, onClose, onSaved, onAction }: DeviceSettingsModalProps) {
  const [displayName, setDisplayName] = useState(device.hostname);
  const [siteId, setSiteId] = useState(device.siteId);
  const [tags, setTags] = useState<string[]>(device.tags ?? []);
  const [newTag, setNewTag] = useState('');
  const [sites, setSites] = useState<Site[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!isOpen) return;
    // Reset form to current device values when opened
    setDisplayName(device.hostname);
    setSiteId(device.siteId);
    setTags(device.tags ?? []);
    setNewTag('');
    setError(undefined);

    // Fetch sites for the dropdown
    fetchWithAuth('/orgs/sites')
      .then(res => res.ok ? res.json() : Promise.reject(new Error('Failed to load sites')))
      .then(data => setSites(data.data ?? data.sites ?? data ?? []))
      .catch(() => setSites([]));
  }, [isOpen, device]);

  if (!isOpen) return null;

  const handleAddTag = () => {
    const trimmed = newTag.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
    }
    setNewTag('');
  };

  const handleRemoveTag = (tag: string) => {
    setTags(tags.filter(t => t !== tag));
  };

  const handleTagKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(undefined);

    try {
      const body: Record<string, unknown> = {};
      if (displayName !== device.hostname) body.displayName = displayName;
      if (siteId !== device.siteId) body.siteId = siteId;
      const tagsChanged = JSON.stringify(tags) !== JSON.stringify(device.tags ?? []);
      if (tagsChanged) body.tags = tags;

      if (Object.keys(body).length === 0) {
        onClose();
        return;
      }

      const res = await fetchWithAuth(`/devices/${device.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save settings');
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold">Device Settings</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5">
          {/* Display Name */}
          <div>
            <label htmlFor="displayName" className="block text-sm font-medium mb-1.5">
              Display Name
            </label>
            <input
              id="displayName"
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder={device.hostname}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Hostname: {device.hostname}
            </p>
          </div>

          {/* Site */}
          <div>
            <label htmlFor="siteId" className="block text-sm font-medium mb-1.5">
              Site
            </label>
            <select
              id="siteId"
              value={siteId}
              onChange={e => setSiteId(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              {sites.length === 0 && (
                <option value={siteId}>{device.siteName}</option>
              )}
              {sites.map(site => (
                <option key={site.id} value={site.id}>{site.name}</option>
              ))}
            </select>
          </div>

          {/* Tags */}
          <div>
            <label className="block text-sm font-medium mb-1.5">Tags</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {tags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
                >
                  <Tag className="h-3 w-3" />
                  {tag}
                  <button
                    type="button"
                    onClick={() => handleRemoveTag(tag)}
                    className="ml-0.5 rounded-full hover:bg-primary/20 p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newTag}
                onChange={e => setNewTag(e.target.value)}
                onKeyDown={handleTagKeyDown}
                className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="Add a tag..."
              />
              <button
                type="button"
                onClick={handleAddTag}
                disabled={!newTag.trim()}
                className="flex items-center gap-1 rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                Add
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Danger Zone */}
          {onAction && (
            <div className="rounded-md border border-destructive/40 p-4">
              <h3 className="text-sm font-semibold text-destructive">Danger Zone</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Decommissioning will permanently remove this device from your fleet.
              </p>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onAction('decommission', device);
                }}
                disabled={saving}
                className="mt-3 inline-flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Trash2 className="h-4 w-4" />
                Decommission Device
              </button>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Save Changes'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
