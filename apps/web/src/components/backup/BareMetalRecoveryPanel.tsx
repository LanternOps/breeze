// Bare-metal recovery W04a: create a recovery code for a whole-machine
// snapshot and watch its status advance live. See spec
// docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md
// Sec8.1 and plan docs/superpowers/plans/backup/2026-09-10-bare-metal-w04a-recovery-codes-state-machine-checkin.md
// Task 7.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { cn } from '@/lib/utils';

type RecoveryIdentity = 'original' | 'new';

type RecoveryStatus =
  | 'created'
  | 'media_booted'
  | 'planned'
  | 'restoring'
  | 'validated'
  | 'rebooted'
  | 'checked_in'
  | 'completed'
  | 'failed'
  | 'refused';

const TERMINAL_STATUSES: ReadonlySet<RecoveryStatus> = new Set(['checked_in', 'completed', 'failed', 'refused']);

const TIMELINE_STATUSES: RecoveryStatus[] = [
  'created', 'media_booted', 'planned', 'restoring', 'validated', 'rebooted', 'checked_in',
];

interface RecoverySnapshotOption {
  id: string;
  deviceId: string | null;
  label: string | null;
  timestamp: string | null;
}

interface RecoverySummary {
  id: string;
  deviceId: string;
  snapshotId: string | null;
  identity: RecoveryIdentity;
  status: RecoveryStatus;
  overdue: boolean;
  codeExpiresAt: string;
  failureReason: string | null;
}

interface CreatedRecovery extends RecoverySummary {
  code: string;
}

const POLL_INTERVAL_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseSnapshotOptions(payload: unknown): RecoverySnapshotOption[] {
  const list = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const out: RecoverySnapshotOption[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    out.push({
      id: item.id,
      deviceId: toText(item.deviceId),
      label: toText(item.label),
      timestamp: toText(item.createdAt) ?? toText(item.timestamp),
    });
  }
  return out;
}

function parseRecoverySummary(payload: unknown): RecoverySummary | null {
  if (!isRecord(payload) || typeof payload.id !== 'string') return null;
  return {
    id: payload.id,
    deviceId: typeof payload.deviceId === 'string' ? payload.deviceId : '',
    snapshotId: toText(payload.snapshotId),
    identity: payload.identity === 'new' ? 'new' : 'original',
    status: (typeof payload.status === 'string' ? payload.status : 'created') as RecoveryStatus,
    overdue: payload.overdue === true,
    codeExpiresAt: toText(payload.codeExpiresAt) ?? '',
    failureReason: toText(payload.failureReason),
  };
}

function parseRecoveryList(payload: unknown): RecoverySummary[] {
  const list = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const out: RecoverySummary[] = [];
  for (const item of list) {
    const parsed = parseRecoverySummary(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export interface BareMetalRecoveryPanelProps {
  orgId?: string;
}

export default function BareMetalRecoveryPanel({ orgId }: BareMetalRecoveryPanelProps) {
  const { t } = useTranslation('backup');
  const [snapshots, setSnapshots] = useState<RecoverySnapshotOption[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState('');
  const [identity, setIdentity] = useState<RecoveryIdentity>('original');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createErrorReasons, setCreateErrorReasons] = useState<string[]>([]);
  const [created, setCreated] = useState<CreatedRecovery | null>(null);
  const [active, setActive] = useState<RecoverySummary | null>(null);

  const orgQuery = useMemo(() => (orgId ? `orgId=${encodeURIComponent(orgId)}&` : ''), [orgId]);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const onUnauthorized = useCallback(() => {
    navigateTo(loginPathWithNext());
  }, []);

  const loadInitialData = useCallback(async () => {
    try {
      const [snapshotsRes, recoveriesRes] = await Promise.all([
        fetchWithAuth(`/backup/snapshots?${orgQuery}bareMetalRestorable=true`),
        fetchWithAuth(`/backup/bmr/recoveries?${orgQuery}limit=20`),
      ]);
      if (snapshotsRes.ok) {
        setSnapshots(parseSnapshotOptions(await snapshotsRes.json().catch(() => null)));
      }
      if (recoveriesRes.ok) {
        const recoveries = parseRecoveryList(await recoveriesRes.json().catch(() => null));
        // The list is ordered most-recent-first: show the last recovery
        // regardless of status — a terminal one still needs to render (its
        // failure reason, or just settle the timeline) even though the
        // polling effect below will never start a timer for it.
        const mostRecent = recoveries[0];
        if (mostRecent) setActive(mostRecent);
      }
    } catch {
      // Best-effort background load — the create form still works even if
      // the initial snapshot/recovery lists fail to populate; the user just
      // sees an empty select / no history, not a hard error.
    }
  }, [orgQuery]);

  useEffect(() => {
    void loadInitialData();
  }, [loadInitialData]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const activeId = active?.id;
  const activeStatus = active?.status;

  useEffect(() => {
    if (!activeId || (activeStatus && TERMINAL_STATUSES.has(activeStatus))) {
      stopPolling();
      return;
    }
    stopPolling();
    pollTimer.current = setInterval(() => {
      void (async () => {
        try {
          const res = await fetchWithAuth(`/backup/bmr/recoveries/${activeId}?${orgQuery.slice(0, -1)}`);
          if (!res.ok) return;
          const summary = parseRecoverySummary(await res.json().catch(() => null));
          if (summary) setActive(summary);
        } catch {
          // A transient poll failure just leaves the current status showing
          // until the next tick — no need to surface a toast for this.
        }
      })();
    }, POLL_INTERVAL_MS);
    return stopPolling;
  }, [activeId, activeStatus, orgQuery, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  const handleCreate = useCallback(async () => {
    setCreateError(null);
    setCreateErrorReasons([]);
    if (!selectedSnapshotId) {
      setCreateError(t('bareMetalRecovery.selectSnapshotFirst'));
      return;
    }
    setCreating(true);
    try {
      const result = await runAction<CreatedRecovery>({
        request: () =>
          fetchWithAuth(`/backup/bmr/recoveries?${orgQuery.slice(0, -1)}`, {
            method: 'POST',
            body: JSON.stringify({ snapshotId: selectedSnapshotId, identity }),
          }),
        errorFallback: t('bareMetalRecovery.createFailed'),
        parseSuccess: (data) => {
          const summary = parseRecoverySummary(data);
          const code = isRecord(data) && typeof data.code === 'string' ? data.code : null;
          if (!summary || !code) throw new Error('malformed create response');
          return { ...summary, code };
        },
        onUnauthorized,
      });
      setCreated(result);
      setActive(result);
    } catch (err) {
      if (err instanceof ActionError) {
        const body = err.body;
        if (isRecord(body) && Array.isArray(body.reasons)) {
          setCreateErrorReasons(body.reasons.filter((r): r is string => typeof r === 'string'));
        }
        setCreateError(err.message);
      } else {
        handleActionError(err, t('bareMetalRecovery.createFailed'));
        setCreateError(t('bareMetalRecovery.createFailed'));
      }
    } finally {
      setCreating(false);
    }
  }, [selectedSnapshotId, identity, orgQuery, t, onUnauthorized]);

  // `completed` (identity: 'new' recoveries validated straight through,
  // never going via rebooted/checked_in — see canTransition on the server)
  // has no slot of its own in TIMELINE_STATUSES: treat it as "every step
  // reached" rather than falling through to timelineIndex -1 (nothing lit).
  const timelineIndex =
    active?.status === 'completed'
      ? TIMELINE_STATUSES.length - 1
      : active
        ? TIMELINE_STATUSES.indexOf(active.status)
        : -1;
  const isFailedOrRefused = active?.status === 'failed' || active?.status === 'refused';

  return (
    <div className="space-y-4 rounded-lg border p-4" data-testid="bare-metal-recovery-panel">
      <div>
        <h3 className="text-sm font-semibold">{t('bareMetalRecovery.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('bareMetalRecovery.description')}</p>
      </div>

      {!created && (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium" htmlFor="bare-metal-recovery-snapshot">
              {t('bareMetalRecovery.snapshotLabel')}
            </label>
            <select
              id="bare-metal-recovery-snapshot"
              className="w-full rounded border px-2 py-1 text-sm"
              value={selectedSnapshotId}
              onChange={(e) => setSelectedSnapshotId(e.target.value)}
            >
              <option value="">{t('bareMetalRecovery.selectSnapshotPlaceholder')}</option>
              {snapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {(s.label ?? s.id) + (s.timestamp ? ` — ${new Date(s.timestamp).toLocaleString()}` : '')}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="space-y-1">
            <legend className="mb-1 text-xs font-medium">{t('bareMetalRecovery.identityLabel')}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="bare-metal-recovery-identity"
                checked={identity === 'original'}
                onChange={() => setIdentity('original')}
              />
              {t('bareMetalRecovery.identityOriginal')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="bare-metal-recovery-identity"
                checked={identity === 'new'}
                onChange={() => setIdentity('new')}
              />
              {t('bareMetalRecovery.identityNew')}
            </label>
          </fieldset>

          {createError && (
            <div className="text-sm text-destructive" data-testid="bare-metal-recovery-create-error">
              <p>{createError}</p>
              {createErrorReasons.length > 0 && (
                <ul className="list-inside list-disc">
                  {createErrorReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            disabled={creating}
            onClick={() => void handleCreate()}
          >
            {creating ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : null}
            {t('bareMetalRecovery.createButton')}
          </button>
        </div>
      )}

      {created && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t('bareMetalRecovery.codeInstructions')}</p>
          <div
            className="rounded border bg-muted px-4 py-3 text-center font-mono text-2xl tracking-widest"
            data-testid="bare-metal-recovery-code"
          >
            {created.code}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('bareMetalRecovery.codeExpires', { time: new Date(created.codeExpiresAt).toLocaleTimeString() })}
          </p>
        </div>
      )}

      {active && (
        <div className="space-y-2" data-testid="bare-metal-recovery-status">
          {active.overdue && (
            <div
              className="flex items-center gap-2 rounded border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-800"
              data-testid="bare-metal-recovery-overdue-notice"
            >
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{t('bareMetalRecovery.overdueNotice')}</span>
            </div>
          )}

          {isFailedOrRefused ? (
            <div
              className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
              data-testid="bare-metal-recovery-failure"
            >
              <XCircle className="h-4 w-4 shrink-0 text-destructive" />
              <div>
                <p className="font-medium">
                  {active.status === 'failed' ? t('bareMetalRecovery.statusFailed') : t('bareMetalRecovery.statusRefused')}
                </p>
                {active.failureReason && <p className="text-muted-foreground">{active.failureReason}</p>}
              </div>
            </div>
          ) : (
            <ol className="flex flex-wrap gap-2 text-xs">
              {TIMELINE_STATUSES.map((status, idx) => {
                const reached = timelineIndex >= 0 && idx <= timelineIndex;
                return (
                  <li
                    key={status}
                    data-testid={`bare-metal-recovery-timeline-${status}`}
                    className={cn(
                      'flex items-center gap-1 rounded-full border px-2 py-0.5',
                      reached ? 'border-primary text-primary' : 'border-muted-foreground/30 text-muted-foreground',
                    )}
                  >
                    {reached && <CheckCircle2 className="h-3 w-3" />}
                    {t(/* i18n-dynamic */ `bareMetalRecovery.status.${status}`)}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
