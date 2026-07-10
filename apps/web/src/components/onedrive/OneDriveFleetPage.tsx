import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Cloud, ShieldCheck } from 'lucide-react';

import SecurityStatCard from '../security/SecurityStatCard';
import { ResponsiveTable, DataCard, CardField } from '../shared/ResponsiveTable';
import { formatRelativeTime } from '../../lib/utils';
import { cn } from '@/lib/utils';
import { fetchOneDriveFleetState, type OneDriveFleetRow } from '../../lib/api/onedrive';

// The three Known Folder Move targets the agent reports on — a device is
// "fully protected" only when all three are redirected. Any other value (or an
// absent folder) leaves a gap.
const KFM_FOLDER_COUNT = 3;

// Row filters, one per stat tile (Devices reporting → all). "kfm-gap" is every
// device that is NOT fully protected; "drift" is every device with drift
// entries. Clicking the active tile toggles back to "all".
type FleetFilter = 'all' | 'signed-in' | 'kfm-gap' | 'drift';

// Keyboard focus ring for the stat-card shortcut buttons; hover + pressed
// styling lives on the card itself (SecurityStatCard interactive/active).
const STAT_BUTTON =
  'block h-full w-full rounded-lg text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/** Count of KFM folders currently redirected — the numerator of "x/3 redirected". */
function kfmRedirectedCount(row: OneDriveFleetRow): number {
  return Object.values(row.kfmFolderStates).filter((v) => v === 'redirected').length;
}

function isFullyProtected(row: OneDriveFleetRow): boolean {
  return kfmRedirectedCount(row) >= KFM_FOLDER_COUNT;
}

function matchesFilter(row: OneDriveFleetRow, filter: FleetFilter): boolean {
  switch (filter) {
    case 'signed-in':
      return row.signedIn;
    case 'kfm-gap':
      return !isFullyProtected(row);
    case 'drift':
      return row.driftEntries.length > 0;
    case 'all':
    default:
      return true;
  }
}

function SignedInBadge({ signedIn }: { signedIn: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
        signedIn
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
          : 'bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300',
      )}
    >
      {signedIn ? 'Signed in' : 'Not signed in'}
    </span>
  );
}

function lastReportedLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatRelativeTime(d);
}

export function OneDriveFleetPage() {
  const [devices, setDevices] = useState<OneDriveFleetRow[]>([]);
  const [stats, setStats] = useState<{ total: number; signedIn: number; kfmProtected: number; withDrift: number } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FleetFilter>('all');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchOneDriveFleetState()
      .then((res) => {
        if (cancelled) return;
        setDevices(res.devices);
        setStats(res.stats);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load OneDrive fleet state');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  // Clicking the active tile returns to the unfiltered view (toggle).
  const toggleFilter = (next: FleetFilter) => setFilter((cur) => (cur === next ? 'all' : next));

  const filtered = useMemo(() => devices.filter((d) => matchesFilter(d, filter)), [devices, filter]);

  const total = stats?.total ?? 0;
  const kfmWarning = stats !== null && stats.kfmProtected < stats.signedIn;

  const renderDriftCount = (row: OneDriveFleetRow) => {
    const n = row.driftEntries.length;
    return (
      <span
        data-testid={`onedrive-fleet-drift-${row.deviceId}`}
        className={cn('tabular-nums', n > 0 && 'font-medium text-amber-600')}
      >
        {n}
      </span>
    );
  };

  const table = (
    <table className="min-w-full divide-y">
      <thead className="bg-muted/40">
        <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <th className="px-4 py-3">Device</th>
          <th className="px-4 py-3">OneDrive</th>
          <th className="px-4 py-3">Files On-Demand</th>
          <th className="px-4 py-3">Known Folder Move</th>
          <th className="px-4 py-3">Mounted</th>
          <th className="px-4 py-3">Entitled</th>
          <th className="px-4 py-3">Drift</th>
          <th className="px-4 py-3">Last reported</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {filtered.map((row) => (
          <tr key={row.deviceId} data-testid={`onedrive-fleet-row-${row.deviceId}`} className="hover:bg-muted/40">
            <td className="whitespace-nowrap px-4 py-3 text-sm font-medium">
              <a className="hover:text-foreground hover:underline" href={`/devices/${row.deviceId}#onedrive`}>
                {row.hostname}
              </a>
            </td>
            <td className="px-4 py-3 text-sm"><SignedInBadge signedIn={row.signedIn} /></td>
            <td className="px-4 py-3 text-sm">{row.filesOnDemandOn ? 'On' : 'Off'}</td>
            <td className="px-4 py-3 text-sm tabular-nums">{kfmRedirectedCount(row)}/{KFM_FOLDER_COUNT} redirected</td>
            <td className="px-4 py-3 text-sm tabular-nums">{row.mountedLibraries.length}</td>
            <td className="px-4 py-3 text-sm tabular-nums">{row.entitledLibraries.length}</td>
            <td className="px-4 py-3 text-sm">{renderDriftCount(row)}</td>
            <td className="whitespace-nowrap px-4 py-3 text-sm text-muted-foreground">{lastReportedLabel(row.lastReportedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const cards = filtered.map((row) => (
    <DataCard key={row.deviceId}>
      <div className="flex items-center justify-between gap-2">
        <a className="min-w-0 flex-1 truncate text-sm font-semibold hover:underline" href={`/devices/${row.deviceId}#onedrive`}>
          {row.hostname}
        </a>
        <SignedInBadge signedIn={row.signedIn} />
      </div>
      <div className="mt-3 space-y-2 border-t pt-3">
        <CardField label="Files On-Demand"><span className="text-sm">{row.filesOnDemandOn ? 'On' : 'Off'}</span></CardField>
        <CardField label="Known Folder Move">
          <span className="text-sm tabular-nums">{kfmRedirectedCount(row)}/{KFM_FOLDER_COUNT} redirected</span>
        </CardField>
        <CardField label="Mounted"><span className="text-sm tabular-nums">{row.mountedLibraries.length}</span></CardField>
        <CardField label="Entitled"><span className="text-sm tabular-nums">{row.entitledLibraries.length}</span></CardField>
        <CardField label="Drift">{renderDriftCount(row)}</CardField>
        <CardField label="Last reported"><span className="text-sm text-muted-foreground">{lastReportedLabel(row.lastReportedAt)}</span></CardField>
      </div>
    </DataCard>
  ));

  return (
    <div className="space-y-4">
      {/* 1 → 2 → 4 columns: the 2-col step keeps the cards comfortable around
          tablet widths; h-full keeps the row's card heights even. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <button
          type="button"
          data-testid="onedrive-stat-total"
          className={STAT_BUTTON}
          aria-pressed={filter === 'all'}
          onClick={() => setFilter('all')}
        >
          <SecurityStatCard
            icon={Cloud}
            label="Devices reporting"
            value={stats?.total ?? '—'}
            detail={stats ? 'devices with OneDrive state' : undefined}
            loading={loading}
            interactive
            active={filter === 'all'}
          />
        </button>
        <button
          type="button"
          data-testid="onedrive-stat-signed-in"
          className={STAT_BUTTON}
          aria-pressed={filter === 'signed-in'}
          onClick={() => toggleFilter('signed-in')}
        >
          <SecurityStatCard
            icon={CheckCircle2}
            label="Signed in"
            value={stats?.signedIn ?? '—'}
            variant="success"
            detail={stats ? `of ${stats.total} reporting` : undefined}
            loading={loading}
            interactive
            active={filter === 'signed-in'}
          />
        </button>
        <button
          type="button"
          data-testid="onedrive-stat-kfm"
          className={STAT_BUTTON}
          aria-pressed={filter === 'kfm-gap'}
          onClick={() => toggleFilter('kfm-gap')}
        >
          <SecurityStatCard
            icon={ShieldCheck}
            label="KFM protected"
            value={stats?.kfmProtected ?? '—'}
            variant={kfmWarning ? 'warning' : 'success'}
            detail={stats ? `of ${stats.signedIn} signed in` : undefined}
            loading={loading}
            interactive
            active={filter === 'kfm-gap'}
          />
        </button>
        <button
          type="button"
          data-testid="onedrive-stat-drift"
          className={STAT_BUTTON}
          aria-pressed={filter === 'drift'}
          onClick={() => toggleFilter('drift')}
        >
          <SecurityStatCard
            icon={AlertTriangle}
            label="Drift"
            value={stats?.withDrift ?? '—'}
            variant={stats && stats.withDrift > 0 ? 'danger' : 'success'}
            detail={stats ? 'devices with mount drift' : undefined}
            loading={loading}
            interactive
            active={filter === 'drift'}
          />
        </button>
      </div>

      {error && (
        <div
          data-testid="onedrive-fleet-error"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300"
        >
          <p>{error}</p>
          <button
            type="button"
            data-testid="onedrive-fleet-retry"
            className="mt-2 inline-flex items-center rounded-md border border-red-300 px-3 py-1 text-sm font-medium transition hover:bg-red-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary dark:border-red-800 dark:hover:bg-red-900/40"
            onClick={() => setRetryKey((k) => k + 1)}
          >
            Retry
          </button>
        </div>
      )}

      {loading && !error && (
        <div data-testid="onedrive-fleet-loading" className="px-4 py-12 text-center text-sm text-muted-foreground">
          Loading OneDrive fleet state…
        </div>
      )}

      {!loading && !error && total === 0 && (
        <div
          data-testid="onedrive-fleet-empty"
          className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground"
        >
          No devices are reporting OneDrive state yet. Enable the OneDrive Helper feature on a configuration policy and
          assign it to your devices — they report on the next heartbeat after the policy applies.
        </div>
      )}

      {!loading && !error && total > 0 && <ResponsiveTable table={table} cards={cards} />}
    </div>
  );
}

export default OneDriveFleetPage;
