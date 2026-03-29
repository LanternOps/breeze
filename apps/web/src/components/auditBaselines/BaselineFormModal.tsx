import { useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

export type Baseline = {
  id: string;
  orgId: string;
  name: string;
  osType: 'windows' | 'macos' | 'linux';
  profile: 'cis_l1' | 'cis_l2' | 'custom';
  settings: Record<string, unknown>;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

type Props = {
  baseline?: Baseline | null;
  onClose: () => void;
  onSaved: () => void;
};

const OS_OPTIONS = [
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
] as const;

const PROFILE_OPTIONS = [
  { value: 'cis_l1', label: 'CIS Level 1' },
  { value: 'cis_l2', label: 'CIS Level 2' },
  { value: 'custom', label: 'Custom' },
] as const;

export default function BaselineFormModal({ baseline, onClose, onSaved }: Props) {
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const [name, setName] = useState(baseline?.name ?? '');
  const [osType, setOsType] = useState<Baseline['osType']>(baseline?.osType ?? 'windows');
  const [profile, setProfile] = useState<Baseline['profile']>(baseline?.profile ?? 'cis_l1');
  const [isActive, setIsActive] = useState(baseline?.isActive ?? true);
  const [settingsJson, setSettingsJson] = useState(
    baseline?.settings ? JSON.stringify(baseline.settings, null, 2) : ''
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);

    let settings: Record<string, unknown> | undefined;
    if (profile === 'custom' && settingsJson.trim()) {
      try {
        settings = JSON.parse(settingsJson);
      } catch {
        setError('Invalid JSON in settings');
        return;
      }
    } else if (settingsJson.trim()) {
      try {
        settings = JSON.parse(settingsJson);
      } catch {
        setError('Invalid JSON in settings');
        return;
      }
    }

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name,
        osType,
        profile,
        isActive,
      };
      if (baseline?.id) body.id = baseline.id;
      if (currentOrgId) body.orgId = currentOrgId;
      if (settings) body.settings = settings;

      const response = await fetchWithAuth('/audit-baselines', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save baseline');
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={true} onClose={onClose} title={baseline ? 'Edit Baseline' : 'New Baseline'} className="max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">
            {baseline ? 'Edit Baseline' : 'New Baseline'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className="text-sm font-medium" htmlFor="bl-name">
              Name
            </label>
            <input
              id="bl-name"
              type="text"
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
              placeholder="e.g. Windows CIS L1 Baseline"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium" htmlFor="bl-os">
                OS Type
              </label>
              <select
                id="bl-os"
                value={osType}
                onChange={(e) => setOsType(e.target.value as Baseline['osType'])}
                className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
              >
                {OS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium" htmlFor="bl-profile">
                Profile
              </label>
              <select
                id="bl-profile"
                value={profile}
                onChange={(e) => setProfile(e.target.value as Baseline['profile'])}
                className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
              >
                {PROFILE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              id="bl-active"
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border"
            />
            <label className="text-sm font-medium" htmlFor="bl-active">
              Active
            </label>
            <span className="text-xs text-muted-foreground">
              (Only one baseline per OS type can be active)
            </span>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium" htmlFor="bl-settings">
                Settings (JSON)
              </label>
              {profile !== 'custom' && (
                <span className="text-xs text-muted-foreground">
                  Leave empty to use template defaults
                </span>
              )}
            </div>
            <textarea
              id="bl-settings"
              rows={8}
              value={settingsJson}
              onChange={(e) => setSettingsJson(e.target.value)}
              className="mt-1 block w-full rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-primary"
              placeholder={profile === 'custom' ? '{\n  "key": "value"\n}' : 'Optional — template defaults will be used'}
            />
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className={cn(
                'inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90',
                'disabled:cursor-not-allowed disabled:opacity-60'
              )}
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {baseline ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
    </Dialog>
  );
}
