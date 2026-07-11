import { useCallback, useEffect, useState } from 'react';
import { Cloud, CloudOff, HardDriveDownload, Clock, AlertTriangle } from 'lucide-react';

import { fetchDeviceOneDriveState, type OneDriveDeviceState } from '../../lib/api/onedrive';
import { formatRelativeTime } from '../../lib/utils';

type DeviceOneDriveTabProps = {
  deviceId: string;
};

// The three Known Folder Move targets the agent reports on. Any folder absent
// from `kfmFolderStates` is treated as `unknown` rather than dropped.
const KFM_FOLDERS = ['Desktop', 'Documents', 'Pictures'] as const;

const KFM_BADGES: Record<string, { label: string; className: string }> = {
  redirected: { label: 'Redirected', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  not_redirected: { label: 'Not redirected', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  unknown: { label: 'Unknown', className: 'bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300' },
};

/**
 * Entitled libraries arrive as raw `TenantAutoMount` registry composites
 * (`tenantId=…&siteId=…&webUrl=<encoded>&version=1`). Decode the `webUrl=`
 * segment into a readable `host/path` label; the full composite stays in the
 * row's `title` attribute so the exact value is still inspectable.
 */
function entitledLabel(composite: string): string {
  const match = /webUrl=([^&]*)/.exec(composite);
  if (!match || !match[1]) return composite;
  try {
    return decodeURIComponent(match[1]).replace(/^https?:\/\//i, '');
  } catch {
    return composite;
  }
}

function StatusChip({
  icon,
  label,
  className,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  className: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${className}`}
    >
      {icon}
      {label}
    </span>
  );
}

export function DeviceOneDriveTab({ deviceId }: DeviceOneDriveTabProps) {
  const [state, setState] = useState<OneDriveDeviceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchDeviceOneDriveState(deviceId);
      setState(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load OneDrive state');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div
        data-testid="device-onedrive-error"
        className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300"
      >
        {error}
      </div>
    );
  }

  if (loading) {
    return (
      <div data-testid="device-onedrive-loading" className="px-4 py-12 text-center text-sm text-muted-foreground">
        Loading OneDrive state…
      </div>
    );
  }

  if (state === null) {
    return (
      <div
        data-testid="device-onedrive-empty"
        className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground"
      >
        No OneDrive state reported yet — the agent reports on its next heartbeat after a policy applies.
      </div>
    );
  }

  const lastReported = new Date(state.lastReportedAt);
  const lastReportedLabel = Number.isNaN(lastReported.getTime())
    ? state.lastReportedAt
    : formatRelativeTime(lastReported);

  return (
    <div className="space-y-6">
      {/* Status header chips */}
      <div data-testid="device-onedrive-header" className="flex flex-wrap items-center gap-2">
        {state.signedIn ? (
          <StatusChip
            testId="device-onedrive-signedin"
            icon={<Cloud className="h-3.5 w-3.5" />}
            label="Signed in"
            className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
          />
        ) : (
          <StatusChip
            testId="device-onedrive-signedin"
            icon={<CloudOff className="h-3.5 w-3.5" />}
            label="Not signed in"
            className="bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300"
          />
        )}
        <StatusChip
          testId="device-onedrive-fod"
          icon={<HardDriveDownload className="h-3.5 w-3.5" />}
          label={`Files On-Demand: ${state.filesOnDemandOn ? 'On' : 'Off'}`}
          className={
            state.filesOnDemandOn
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
              : 'bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300'
          }
        />
        <StatusChip
          testId="device-onedrive-version"
          icon={<Cloud className="h-3.5 w-3.5" />}
          label={`OneDrive ${state.oneDriveVersion ?? 'unknown'}`}
          className="bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300"
        />
        <StatusChip
          testId="device-onedrive-lastreported"
          icon={<Clock className="h-3.5 w-3.5" />}
          label={`Reported ${lastReportedLabel}`}
          className="bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300"
        />
      </div>

      {/* Known Folder Move */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Known Folder Move</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {KFM_FOLDERS.map((folder) => {
            const stateVal = state.kfmFolderStates[folder] ?? 'unknown';
            const badge = KFM_BADGES[stateVal] ?? KFM_BADGES.unknown;
            return (
              <div key={folder} className="rounded-md border bg-card px-3 py-2">
                <div className="text-xs text-muted-foreground">{folder}</div>
                <span
                  data-testid={`onedrive-kfm-${folder}`}
                  className={`mt-1 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${badge.className}`}
                >
                  {badge.label}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Libraries */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Entitled libraries</h3>
          {state.entitledLibraries.length === 0 ? (
            <p className="text-sm text-muted-foreground">None entitled.</p>
          ) : (
            <ul className="space-y-1">
              {state.entitledLibraries.map((composite, idx) => (
                <li
                  key={composite}
                  data-testid={`onedrive-entitled-${idx}`}
                  title={composite}
                  className="truncate rounded-md border bg-card px-3 py-2 text-sm"
                >
                  {entitledLabel(composite)}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Mounted paths</h3>
          {state.mountedLibraries.length === 0 ? (
            <p className="text-sm text-muted-foreground">None mounted.</p>
          ) : (
            <ul className="space-y-1">
              {state.mountedLibraries.map((path, idx) => (
                <li
                  key={path}
                  data-testid={`onedrive-mounted-${idx}`}
                  className="truncate rounded-md border bg-card px-3 py-2 text-sm"
                >
                  {path}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Drift */}
      {state.driftEntries.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Drift</h3>
          <div className="space-y-1">
            {state.driftEntries.map((entry, idx) => (
              <div
                key={entry.libraryId}
                data-testid={`onedrive-drift-${idx}`}
                className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-medium">{entry.displayName}</div>
                  <div className="text-xs">{entry.reason}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export default DeviceOneDriveTab;
