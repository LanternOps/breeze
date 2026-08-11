import { useCallback, useEffect, useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { PERMISSION_GRANTS } from '@breeze/shared';
import type { UserPreferences } from '../../stores/auth';
import { fetchWithAuth } from '../../stores/auth';
import { usePermissions } from '@/lib/permissions';
import { saveUserPreferences } from '@/lib/userPreferences';

/** Mirrors GET /remote/providers — id/name/enabled only, never a template or password. */
type ProviderSummary = { id: string; name: string; enabled: boolean };
type ProviderDirectory = { providers: ProviderSummary[]; defaultProviderId: string | null };

type RemoteToolSettingsProps = {
  preferences?: UserPreferences | null;
  onSaved?: (preferences: UserPreferences) => void;
};

/** Sentinel for "no personal preference — follow the tenant default". */
const USE_DEFAULT = '';

export default function RemoteToolSettings({ preferences, onSaved }: RemoteToolSettingsProps) {
  const { can } = usePermissions();
  // The chooser is gated on the SAME permission GET /remote/providers requires,
  // so a technician who cannot launch a session is never shown a preference
  // that could not take effect. Deliberately NOT keyed off an empty provider
  // list: "you may not use remote access" and "your tenant has configured no
  // providers" are different states and get different UI below.
  const mayUseRemoteAccess = can(PERMISSION_GRANTS.REMOTE_ACCESS.resource, PERMISSION_GRANTS.REMOTE_ACCESS.action);

  const [directory, setDirectory] = useState<ProviderDirectory | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<string>(preferences?.remoteAccessProviderId ?? USE_DEFAULT);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();

  useEffect(() => {
    setSelected(preferences?.remoteAccessProviderId ?? USE_DEFAULT);
  }, [preferences?.remoteAccessProviderId]);

  useEffect(() => {
    if (!mayUseRemoteAccess) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth('/remote/providers');
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as ProviderDirectory;
        if (!cancelled) setDirectory(body);
      } catch {
        // A failed load must not silently render as "no tools configured" —
        // that reads as a tenant misconfiguration rather than a fetch problem.
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [mayUseRemoteAccess]);

  const handleChange = useCallback(async (value: string) => {
    const previous = selected;
    setSelected(value);
    setError(undefined);
    setSuccess(undefined);
    try {
      setIsSaving(true);
      // Empty string clears the preference back to the tenant default.
      const saved = await saveUserPreferences(
        { remoteAccessProviderId: value === USE_DEFAULT ? undefined : value },
        'Failed to save your preferred remote tool',
      );
      onSaved?.(saved);
      setSuccess('Preferred remote tool saved.');
      setTimeout(() => setSuccess(undefined), 4000);
    } catch (err) {
      setSelected(previous);
      setError(err instanceof Error ? err.message : 'Failed to save your preferred remote tool');
    } finally {
      setIsSaving(false);
    }
  }, [onSaved, selected]);

  if (!mayUseRemoteAccess) return null;

  const enabled = (directory?.providers ?? []).filter((p) => p.enabled);
  const defaultName = directory?.defaultProviderId
    ? directory.providers.find((p) => p.id === directory.defaultProviderId)?.name
    : undefined;

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="remote-tool-settings">
      <div className="flex items-center gap-2">
        <MonitorSmartphone className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-lg font-semibold">Preferred remote tool</h2>
      </div>
      <p className="text-sm text-muted-foreground mt-1 mb-4">
        Which remote-access tool Connect uses for you. Only affects your own sessions.
      </p>

      {loadFailed ? (
        <p className="text-sm text-destructive">
          Couldn&apos;t load the available remote tools. Reload the page to try again.
        </p>
      ) : !directory ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : enabled.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No remote tools are configured for your organization yet.
        </p>
      ) : (
        <>
          <label htmlFor="remote-tool-preference" className="sr-only">Preferred remote tool</label>
          <select
            id="remote-tool-preference"
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
            value={selected}
            disabled={isSaving}
            onChange={(e) => void handleChange(e.target.value)}
          >
            <option value={USE_DEFAULT}>
              {defaultName ? `Use organization default (${defaultName})` : 'Use organization default'}
            </option>
            {enabled.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {/* A preference naming a provider that is no longer enabled would
              otherwise vanish from the select with no explanation. */}
          {selected !== USE_DEFAULT && !enabled.some((p) => p.id === selected) && (
            <p className="text-sm text-muted-foreground mt-2">
              Your saved tool is no longer available, so sessions use the organization default.
            </p>
          )}
        </>
      )}

      {success && (
        <div className="mt-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600">
          {success}
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}
