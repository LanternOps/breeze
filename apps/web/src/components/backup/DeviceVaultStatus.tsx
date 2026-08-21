import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Clock, HardDrive, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { formatTime } from './backupDashboardHelpers';
import AlphaBadge from '../shared/AlphaBadge';
import { useTranslation } from 'react-i18next';
import { asList } from '@/lib/asList';
import '../../lib/i18n';

// ── Types ──────────────────────────────────────────────────────────

type VaultStatus = 'syncing' | 'completed' | 'failed' | 'never';

// Mirrors the API contract (toVaultResponse in routes/backup/vault.ts): the
// server returns `vaultType` and a free-form `lastSyncStatus`, NOT `type` /
// `status`. Reading the wrong names made the panel show "Never synced" for every
// vault regardless of its real state (#3531 follow-up caught in review).
type DeviceVault = {
  id: string;
  vaultPath: string;
  vaultType: string;
  lastSyncStatus?: string | null;
  lastSyncAt?: string | null;
  lastSyncError?: string | null;
};

const statusConfig: Record<VaultStatus, { icon: typeof CheckCircle2; className: string; label: string }> = {
  syncing: { icon: RefreshCw, className: 'text-primary bg-primary/10', label: 'Syncing' },
  completed: { icon: CheckCircle2, className: 'text-success bg-success/10', label: 'Completed' },
  failed: { icon: XCircle, className: 'text-destructive bg-destructive/10', label: 'Failed' },
  never: { icon: Clock, className: 'text-muted-foreground bg-muted', label: 'Never synced' },
};

// The server writes lastSyncStatus as one of completed/ok/success, failed/error,
// pending/running, or null. Normalize to the four badge states.
function normalizeVaultStatus(raw?: string | null): VaultStatus {
  switch (raw) {
    case 'completed':
    case 'ok':
    case 'success':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'pending':
    case 'running':
    case 'syncing':
      return 'syncing';
    default:
      return 'never';
  }
}

// ── Component ─────────────────────────────────────────────────────

export default function DeviceVaultStatus({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('backup');
  const [vault, setVault] = useState<DeviceVault | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // #3531: a failed status load or sync used to be swallowed, so a broken backup
  // vault looked "never configured" and a failed sync looked complete. Surface it.
  //
  // Stored as a KIND rather than a translated string so this state does not
  // depend on `t`. `t` changes identity whenever the locale changes, and any
  // callback that closed over it would be recreated — which, for the reset
  // effect below, made a language switch indistinguishable from a device switch
  // and silently cleared an in-flight sync.
  const [errorKind, setErrorKind] = useState<'load' | 'sync' | null>(null);
  // Monotonic request id (same-visit ordering) + a monotonic VISIT id. The visit
  // id, not the deviceId string, is what identifies "this selection of this
  // device": going A -> B -> A returns to the same id but is a different visit,
  // and a sync still in flight from the first visit must not write into the
  // second one.
  const requestIdRef = useRef(0);
  const visitRef = useRef(0);
  const deviceIdRef = useRef(deviceId);

  // `silent` skips the loading blank — used for the post-sync refresh so a
  // successful Sync Now doesn't flash the whole card away.
  const fetchVault = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    // A caller captured for a now-previous device must not even start: it would
    // otherwise take the newest request id and clobber the current load.
    if (deviceIdRef.current !== deviceId) return;
    const requestId = ++requestIdRef.current;
    const visit = visitRef.current;
    // A non-silent (initial / deviceId-change) load resets to loading so the
    // previous device's card and Sync button aren't left operable mid-flight.
    if (!silent) setLoading(true);
    setErrorKind(null);
    // Invalid once a newer request started OR the visit changed under us.
    const invalid = () => requestIdRef.current !== requestId || visitRef.current !== visit;
    try {
      const response = await fetchWithAuth(`/backup/vault?deviceId=${deviceId}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      const data = asList(payload);
      const list = Array.isArray(data) ? data : [];
      if (invalid()) return;
      setVault(list[0] ?? null);
    } catch {
      if (invalid()) return;
      // A transport/HTTP failure on load surfaces as an error card rather than
      // the "no vault configured" empty state. (A well-formed 200 with an empty
      // list is still a legitimate "no vault" — asList already warns on drift.)
      setErrorKind('load');
    } finally {
      if (!invalid()) setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    // A new visit. Set the live deviceId BEFORE fetching so the entry guard
    // admits this visit's own load (and rejects stragglers from the previous).
    visitRef.current += 1;
    deviceIdRef.current = deviceId;
    // Drop the PREVIOUS device's card before loading this one. The parent does
    // not key this component per device, so without this a failed load for
    // device B left device A's vault rendered under B's heading — including a
    // live Sync Now button still bound to A's `vault.id`, which would queue a
    // sync against the wrong device. `error && !vault` also never reached the
    // error state while that stale vault was present. Same reason `syncing` is
    // cleared: it is component-wide, so an in-flight sync for A otherwise left
    // B's button disabled and spinning.
    setVault(null);
    setSyncing(false);
    fetchVault();
  }, [fetchVault, deviceId]);

  const handleSync = useCallback(async () => {
    if (!vault) return;
    // The VISIT this sync belongs to. `syncing`/`errorKind` are component-wide
    // and the component is not remounted per device, so a settle that lands
    // after the operator moved on — including moving away and back to the same
    // device — must not write into the current card.
    const visit = visitRef.current;
    const sameVisit = () => visitRef.current === visit;
    setSyncing(true);
    setErrorKind(null);
    try {
      // The sanctioned mutation path (CLAUDE.md "Web Mutation Handlers"):
      // runAction owns the toast and treats a 200 `{success:false}` body as a
      // failure, which a bare `response.ok` check would have passed as success.
      await runAction({
        request: () => fetchWithAuth(`/backup/vault/${vault.id}/sync`, { method: 'POST' }),
        errorFallback: t('deviceVaultStatus.failedToStartSync'),
        successMessage: t('deviceVaultStatus.syncStarted'),
      });
      if (!sameVisit()) return;
      await fetchVault({ silent: true });
    } catch (err) {
      // 401 is session expiry: runAction deliberately stays silent and the app
      // redirects, so an inline error here would flash against a navigation.
      if (err instanceof ActionError && err.status === 401) return;
      if (!sameVisit()) return;
      // Otherwise keep the inline banner ALONGSIDE runAction's toast: the toast
      // auto-dismisses while the card keeps showing a stale Last Sync/Status,
      // and that stale value is exactly what #3531 reported as misleading.
      // Same toast-plus-inline precedent as BackupProfilesTab's 409 branch.
      setErrorKind('sync');
    } finally {
      if (sameVisit()) setSyncing(false);
    }
  }, [fetchVault, vault, t]);

  const error =
    errorKind === 'load'
      ? t('deviceVaultStatus.failedToLoadStatus')
      : errorKind === 'sync'
        ? t('deviceVaultStatus.failedToStartSync')
        : null;

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('deviceVaultStatus.loadingVaultStatus')} </div>
    );
  }

  // A load failure with no vault yet is an ERROR state, distinct from the
  // legitimate "no vault configured" empty state below.
  if (error && !vault) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-center">
        <XCircle className="mx-auto h-8 w-8 text-destructive/60" />
        <p className="mt-2 text-sm text-destructive">{error}</p>
        {/* Without a retry the panel would stay failed until remount (a transient
            load failure is otherwise unrecoverable — the Sync button is hidden). */}
        <button
          type="button"
          onClick={() => void fetchVault()}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted"
        >
          <RefreshCw className="h-3 w-3" /> {t('deviceVaultStatus.retry')}
        </button>
      </div>
    );
  }

  if (!vault) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-center">
        <HardDrive className="mx-auto h-8 w-8 text-muted-foreground/40" />
        <p className="mt-2 text-sm text-muted-foreground">{t('deviceVaultStatus.noLocalVaultConfiguredForThisDevice')}</p>
      </div>
    );
  }

  const normalizedStatus = normalizeVaultStatus(vault.lastSyncStatus);
  const sCfg = statusConfig[normalizedStatus];
  const StatusIcon = sCfg.icon;

  return (
    <div className="rounded-lg border bg-card p-4 shadow-xs">
      <div className="flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          <HardDrive className="h-4 w-4" />
          {t('deviceVaultStatus.localVault')} <AlphaBadge />
        </h4>
        <button
          type="button"
          onClick={handleSync}
          disabled={syncing}
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {t('deviceVaultStatus.syncNow')} </button>
      </div>
      {error && (
        <p className="mt-2 flex items-center gap-1 text-xs text-destructive">
          <XCircle className="h-3 w-3 shrink-0" /> {error}
        </p>
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('deviceVaultStatus.path')}</p>
          <p className="mt-0.5 truncate font-mono text-xs text-foreground">{vault.vaultPath}</p>
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('deviceVaultStatus.type')}</p>
          <p className="mt-0.5 text-xs capitalize text-foreground">{vault.vaultType}</p>
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('deviceVaultStatus.lastSync')}</p>
          <p className="mt-0.5 text-xs text-foreground">{formatTime(vault.lastSyncAt)}</p>
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('deviceVaultStatus.status')}</p>
          <span className={cn('mt-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', sCfg.className)}>
            <StatusIcon className={cn('h-3 w-3', normalizedStatus === 'syncing' && 'animate-spin')} />
            {sCfg.label}
          </span>
        </div>
      </div>
      {/* The card used to end with `snapshotCount` — but the vault list endpoint
          (toVaultResponse in routes/backup/vault.ts) never returns that field,
          so it read "0 snapshots stored" for every vault regardless of how many
          it actually held. Same class of untrue status as the badge above.
          Replaced with the server's real `lastSyncError`, which the API DOES
          return and which nothing was showing. */}
      {vault.lastSyncError && (
        <p className="mt-2 flex items-start gap-1 text-xs text-destructive">
          <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-words">{vault.lastSyncError}</span>
        </p>
      )}
    </div>
  );
}
