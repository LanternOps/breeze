import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
import type { Baseline } from './types';

interface CisBaselineFormProps {
  baseline: Baseline | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function CisBaselineForm({ baseline, onClose, onSaved }: CisBaselineFormProps) {
  const [name, setName] = useState(baseline?.name ?? '');
  const [osType, setOsType] = useState(baseline?.osType ?? 'windows');
  const [level, setLevel] = useState(baseline?.level ?? 'l1');
  const [benchmarkVersion, setBenchmarkVersion] = useState(baseline?.benchmarkVersion ?? '');
  const [scheduleEnabled, setScheduleEnabled] = useState(baseline?.scanSchedule?.enabled ?? false);
  const [intervalHours, setIntervalHours] = useState(baseline?.scanSchedule?.intervalHours ?? 24);
  const [isActive, setIsActive] = useState(baseline?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [saving, onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);

    try {
      const body: Record<string, unknown> = {
        name,
        osType,
        level,
        benchmarkVersion,
        isActive,
        scanSchedule: {
          enabled: scheduleEnabled,
          intervalHours: scheduleEnabled ? intervalHours : undefined,
        },
      };
      if (baseline?.id) {
        body.id = baseline.id;
      }

      const res = await fetchWithAuth('/cis/baselines', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `${res.status} ${res.statusText}`);
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save baseline');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
    >
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{baseline ? 'Edit Baseline' : 'New Baseline'}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="bl-name" className="block text-sm font-medium mb-1.5">Name</label>
            <input
              id="bl-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div>
            <label htmlFor="bl-os" className="block text-sm font-medium mb-1.5">OS Type</label>
            <select
              id="bl-os"
              value={osType}
              onChange={(e) => setOsType(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="windows">Windows</option>
              <option value="macos">macOS</option>
              <option value="linux">Linux</option>
            </select>
          </div>

          <div>
            <label htmlFor="bl-level" className="block text-sm font-medium mb-1.5">Level</label>
            <select
              id="bl-level"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="l1">L1</option>
              <option value="l2">L2</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          <div>
            <label htmlFor="bl-version" className="block text-sm font-medium mb-1.5">Benchmark Version</label>
            <input
              id="bl-version"
              type="text"
              required
              value={benchmarkVersion}
              onChange={(e) => setBenchmarkVersion(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="e.g. 3.0.0"
            />
          </div>

          <div className="flex items-center gap-3">
            <input
              id="bl-schedule"
              type="checkbox"
              checked={scheduleEnabled}
              onChange={(e) => setScheduleEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <label htmlFor="bl-schedule" className="text-sm font-medium">Enable scheduled scans</label>
            {scheduleEnabled && (
              <input
                type="number"
                min={1}
                max={168}
                value={intervalHours}
                onChange={(e) => setIntervalHours(Number(e.target.value))}
                className="w-20 rounded-md border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            )}
            {scheduleEnabled && <span className="text-sm text-muted-foreground">hours</span>}
          </div>

          <div className="flex items-center gap-3">
            <input
              id="bl-active"
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <label htmlFor="bl-active" className="text-sm font-medium">Active</label>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
