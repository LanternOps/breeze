import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Database,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  History,
  RefreshCw,
} from 'lucide-react';
import { cn, marginLeftPxClass } from '@/lib/utils';
import { formatDateTime as formatUserDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';
import HashLink from '../shared/HashLink';
import { buildRestoreHash } from './restoreHash';
import { formatNumber } from '@/lib/i18n/format';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';

type BackupType = 'file' | 'system_image' | 'database' | 'application';

// Human labels for non-file backup types. Deliberately untranslated literals
// (like the sibling immutability badge, though the legal-hold badge next to it
// does use t()): these render in English across all locales as a tradeoff to
// avoid fanning a new key out across all five translation bundles. Move to t()
// keys if/when the badge cluster is localized as a whole.
const BACKUP_TYPE_LABELS: Record<Exclude<BackupType, 'file'>, string> = {
  system_image: 'System image',
  database: 'Database',
  application: 'Application',
};

type Snapshot = {
  id: string;
  label: string | null;
  // Display name (then hostname) of the backed-up device, attached by
  // GET /backup/snapshots; null when the lookup finds none.
  deviceName?: string | null;
  createdAt: string;
  backupType?: BackupType;
  sizeBytes: number | null;
  fileCount: number | null;
  location: string | null;
  expiresAt: string | null;
  legalHold: boolean;
  legalHoldReason: string | null;
  legalHoldSource?: 'policy' | 'manual' | null;
  isImmutable: boolean;
  immutableUntil: string | null;
  immutabilityEnforcement: 'application' | 'provider' | null;
  requestedImmutabilityEnforcement: 'application' | 'provider' | null;
  immutabilityFallbackReason: string | null;
  retentionBlockedReason?: 'legal_hold' | 'immutable_until' | null;
  bareMetalRestorable?: boolean | null;
  bareMetalReasons?: string[] | null;
  // Set from GET /snapshots/:id/browse: the snapshot recorded files but has no
  // file index to list them from (not "still processing").
  manifestUnavailable?: boolean;
};

type SnapshotTreeItem = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
  modifiedAt?: string;
};

// #8230: the browse endpoint returns ONE directory level per request, paged by
// an opaque cursor. Directories are fetched when first expanded/selected.
type DirState = {
  items: SnapshotTreeItem[];
  nextCursor: string | null;
  loading: boolean;
};

const ROOT_DIR = '/';

function browseUrl(snapshotId: string, dir: string, cursor?: string | null): string {
  const params: string[] = [];
  if (dir !== ROOT_DIR) params.push(`dir=${encodeURIComponent(dir)}`);
  if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
  return `/backup/snapshots/${snapshotId}/browse${params.length ? `?${params.join('&')}` : ''}`;
}

// Picker text: the device leads, so snapshots of several devices that share a
// policy label ("Nightly") can be told apart.
function snapshotOptionLabel(snapshot: Snapshot): string {
  const parts = [snapshot.deviceName, snapshot.label ?? snapshot.id].filter(Boolean);
  if (snapshot.backupType && snapshot.backupType !== 'file') {
    parts.push(BACKUP_TYPE_LABELS[snapshot.backupType]);
  }
  return parts.join(' — ');
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** exponent);
  const precision = value >= 10 || exponent === 0 ? 0 : 1;
  return `${formatNumber(value, { minimumFractionDigits: precision, maximumFractionDigits: precision })} ${units[exponent]}`;
}

function formatDateTime(value: string | null | undefined): string {
  return formatUserDateTime(value, {
    fallback: '-',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SnapshotBrowser() {
  const { t } = useTranslation('backup');
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFolder, setSelectedFolder] = useState(ROOT_DIR);
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  // Bumped on every snapshot change so a slow page for a previous snapshot
  // can never land in the new snapshot's directory cache.
  const browseEpoch = useRef(0);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reason, setReason] = useState('');
  const [immutableDays, setImmutableDays] = useState(30);
  const [immutabilityMode, setImmutabilityMode] = useState<'application' | 'provider'>('application');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const fetchSnapshots = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/backup/snapshots');
      if (!response.ok) {
        throw new Error('Failed to fetch snapshots');
      }
      const payload = await response.json();
      const data = payload?.data ?? payload ?? {};
      const snapshotList = Array.isArray(data) ? data : data.snapshots ?? [];
      setSnapshots(Array.isArray(snapshotList) ? snapshotList : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSnapshots();
  }, [fetchSnapshots]);

  useEffect(() => {
    if (!selectedSnapshotId && snapshots.length > 0) {
      setSelectedSnapshotId(snapshots[0].id);
    }
  }, [selectedSnapshotId, snapshots]);

  const loadDir = useCallback(async (dir: string, cursor?: string | null) => {
    if (!selectedSnapshotId) return;
    const epoch = browseEpoch.current;
    setDirs((prev) => ({
      ...prev,
      [dir]: { items: prev[dir]?.items ?? [], nextCursor: prev[dir]?.nextCursor ?? null, loading: true },
    }));
    try {
      const response = await fetchWithAuth(browseUrl(selectedSnapshotId, dir, cursor));
      if (!response.ok) {
        throw new Error('Failed to browse snapshot');
      }
      const payload = await response.json();
      if (epoch !== browseEpoch.current) return;
      const items = Array.isArray(payload?.data) ? payload.data as SnapshotTreeItem[] : [];
      setDirs((prev) => ({
        ...prev,
        [dir]: {
          items: cursor ? [...(prev[dir]?.items ?? []), ...items] : items,
          nextCursor: typeof payload?.nextCursor === 'string' ? payload.nextCursor : null,
          loading: false,
        },
      }));
      if (dir === ROOT_DIR && !cursor) {
        setSnapshots((prev) => prev.map((snapshot) => (
          snapshot.id === selectedSnapshotId
            ? { ...snapshot, manifestUnavailable: payload?.manifestUnavailable === true }
            : snapshot
        )));
      }
    } catch (err) {
      if (epoch !== browseEpoch.current) return;
      // A first-page failure must leave the directory "not loaded" so
      // expanding/selecting it again retries; only keep an entry that already
      // holds earlier pages (a failed "Load more").
      setDirs((prev) => {
        const existing = prev[dir];
        if (!existing || existing.items.length === 0) {
          const { [dir]: _dropped, ...rest } = prev;
          return rest;
        }
        return { ...prev, [dir]: { ...existing, loading: false } };
      });
      setError(err instanceof Error ? err.message : 'Failed to browse snapshot');
    }
  }, [selectedSnapshotId]);

  // Reset + load the root level whenever the snapshot changes.
  useEffect(() => {
    browseEpoch.current += 1;
    setDirs({});
    setExpanded(new Set([ROOT_DIR]));
    setSelectedFolder(ROOT_DIR);
    setSelectedFiles(new Set());
    if (selectedSnapshotId) void loadDir(ROOT_DIR);
  }, [selectedSnapshotId, loadDir]);

  const ensureDirLoaded = (dir: string) => {
    if (!dirs[dir]) void loadDir(dir);
  };

  const handleProtectionAction = useCallback(async (
    action: 'apply-hold' | 'release-hold' | 'apply-immutability' | 'release-immutability',
  ) => {
    if (!selectedSnapshotId) return;

    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setActionError('A reason is required for snapshot protection changes.');
      return;
    }

    if (action === 'apply-immutability' && immutableDays < 1) {
      setActionError('Immutable days must be at least 1.');
      return;
    }

    const path = (() => {
      switch (action) {
        case 'apply-hold':
          return `/backup/snapshots/${selectedSnapshotId}/legal-hold`;
        case 'release-hold':
          return `/backup/snapshots/${selectedSnapshotId}/legal-hold`;
        case 'apply-immutability':
          return `/backup/snapshots/${selectedSnapshotId}/immutability`;
        case 'release-immutability':
          return `/backup/snapshots/${selectedSnapshotId}/immutability/release`;
      }
    })();

    const selectedSnapshot = snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null;
    const body = action === 'apply-immutability'
      ? (
        selectedSnapshot?.isImmutable && selectedSnapshot.immutableUntil
          ? {
              reason: trimmedReason,
              extendUntil: new Date(new Date(selectedSnapshot.immutableUntil).getTime() + immutableDays * 24 * 60 * 60 * 1000).toISOString(),
              enforcement: immutabilityMode,
            }
          : { reason: trimmedReason, immutableDays, enforcement: immutabilityMode }
      )
      : { reason: trimmedReason };
    const method = action === 'release-hold' ? 'DELETE' : 'POST';

    try {
      setActionLoading(true);
      setActionError(undefined);
      setActionMessage(undefined);

      const response = await fetchWithAuth(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? 'Failed to update snapshot protection');
      }

      const updated = payload?.data ?? payload;
      setSnapshots((prev) => prev.map((snapshot) => (
        snapshot.id === selectedSnapshotId
          ? {
              ...snapshot,
              ...updated,
              label: updated.label ?? snapshot.label,
            }
          : snapshot
      )));
      setActionMessage(
        action === 'apply-hold'
          ? 'Legal hold applied.'
          : action === 'release-hold'
            ? 'Legal hold released.'
            : action === 'apply-immutability'
              ? `${immutabilityMode === 'provider' ? 'Provider' : 'Application'} immutability ${selectedSnapshot?.isImmutable ? 'extended' : 'applied'}.`
              : 'Application immutability released.'
      );
      setReason('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update snapshot protection');
    } finally {
      setActionLoading(false);
    }
  }, [immutableDays, immutabilityMode, reason, selectedSnapshotId, snapshots]);

  const selectedSnapshot = useMemo(
    () => snapshots.find((snapshot) => snapshot.id === selectedSnapshotId),
    [selectedSnapshotId, snapshots]
  );
  const selectedSnapshotDisplayLabel = selectedSnapshot?.label ?? selectedSnapshot?.id ?? 'Snapshot';
  // The "auto-select the first snapshot" effect below only fires (and commits
  // `selectedSnapshotId`) on the render AFTER the fetch resolves — so on the
  // fetch-resolution render itself `selectedSnapshotId` is still `''` even
  // though a snapshot is about to be selected. Falling back to
  // `snapshots[0]?.id` here (rather than reading `selectedSnapshotId` alone)
  // keeps the restore link correct on that first render instead of briefly
  // carrying no snapshot at all (#6456 review).
  const restoreLinkSnapshotId = selectedSnapshotId || snapshots[0]?.id || '';

  const visibleFiles = useMemo(
    () => (dirs[selectedFolder]?.items ?? [])
      .filter((item) => item.type === 'file')
      .map((item) => ({
        id: item.path,
        name: item.name,
        size: typeof item.sizeBytes === 'number' ? `${item.sizeBytes} B` : undefined,
        modified: item.modifiedAt,
      })),
    [dirs, selectedFolder]
  );
  const rootLoaded = dirs[ROOT_DIR] !== undefined && !dirs[ROOT_DIR]!.loading;
  const rootEmpty = rootLoaded && dirs[ROOT_DIR]!.items.length === 0;

  const toggleExpanded = (id: string) => {
    ensureDirLoaded(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleFile = (id: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Folder ids are the directory's tree path, exactly what the API takes as `dir`.
  const renderTree = (item: SnapshotTreeItem | null, depth = 0): ReactNode => {
    const dirPath = item ? item.path : ROOT_DIR;
    const name = item ? item.name : 'Root';
    const state = dirs[dirPath];
    const isExpanded = expanded.has(dirPath);

    return (
      <div key={dirPath}>
        <div
          className={cn(
            'flex items-center gap-2 rounded-md px-2 py-1 text-sm',
            dirPath === selectedFolder ? 'bg-primary/10 text-foreground' : 'text-muted-foreground',
            marginLeftPxClass(depth * 14)
          )}
        >
          <button onClick={() => toggleExpanded(dirPath)} className="text-muted-foreground">
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
          <button
            onClick={() => {
              ensureDirLoaded(dirPath);
              setSelectedFolder(dirPath);
            }}
            className="flex items-center gap-2"
          >
            {isExpanded ? (
              <FolderOpen className="h-4 w-4" />
            ) : (
              <Folder className="h-4 w-4" />
            )}
            {name}
          </button>
        </div>
        {isExpanded && (
          <div className="space-y-1">
            {(state?.items ?? [])
              .filter((child) => child.type === 'directory')
              .map((child) => renderTree(child, depth + 1))}
            {state?.loading && (
              <div className={cn('px-2 py-1 text-xs text-muted-foreground', marginLeftPxClass((depth + 1) * 14))}>
                Loading...
              </div>
            )}
            {state?.nextCursor && !state.loading && (
              <button
                type="button"
                onClick={() => void loadDir(dirPath, state.nextCursor)}
                className={cn('px-2 py-1 text-xs text-primary hover:underline', marginLeftPxClass((depth + 1) * 14))}
              >
                Load more
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const breadcrumbs = selectedFolder.split('/').filter(Boolean);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('snapshotBrowser.loadingSnapshots')}</p>
        </div>
      </div>
    );
  }

  if (error && snapshots.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchSnapshots}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('snapshotBrowser.tryAgain')} </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">{t('snapshotBrowser.snapshots')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('snapshotBrowser.manageBackupRestorePointsInspectProtectionStateAnd')} </p>
      </div>

      <div className="rounded-lg border bg-card p-5 shadow-xs space-y-4">
        {(error || actionError) && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {actionError ?? error}
          </div>
        )}
        {actionMessage && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
            {actionMessage}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor="snapshot-browser-picker" className="flex items-center gap-2 text-sm text-muted-foreground">
            <History className="h-4 w-4" />
            {t('snapshotBrowser.snapshot')} </label>
          <div className="flex flex-wrap items-center gap-2">
            <select
              id="snapshot-browser-picker"
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={selectedSnapshotId}
              onChange={(event) => setSelectedSnapshotId(event.target.value)}
            >
              {snapshots.map((snapshot) => (
                <option key={snapshot.id} value={snapshot.id}>
                  {snapshotOptionLabel(snapshot)}
                </option>
              ))}
            </select>
            <button
              onClick={fetchSnapshots}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
            >
              <RefreshCw className="h-4 w-4" />
              {t('snapshotBrowser.refresh')} </button>
          </div>
        </div>

        {selectedSnapshot && (
          <div className="grid gap-4 rounded-lg border bg-muted/15 p-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-foreground">{selectedSnapshotDisplayLabel}</span>
                {selectedSnapshot.deviceName && (
                  <span data-testid="snapshot-device-name" className="text-sm text-muted-foreground">
                    {selectedSnapshot.deviceName}
                  </span>
                )}
                {selectedSnapshot.backupType && selectedSnapshot.backupType !== 'file' && (
                  <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-700">
                    {BACKUP_TYPE_LABELS[selectedSnapshot.backupType]}
                  </span>
                )}
                {selectedSnapshot.bareMetalRestorable === true && (
                  <span data-testid="snapshot-bare-metal-ok" className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700">
                    {t('snapshotBrowser.bareMetalRestorable')}
                  </span>
                )}
                {selectedSnapshot.bareMetalRestorable === false && (
                  <span
                    data-testid="snapshot-bare-metal-no"
                    title={(selectedSnapshot.bareMetalReasons ?? []).join('; ')}
                    className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700"
                  >
                    {t('snapshotBrowser.bareMetalNotRestorable')}
                  </span>
                )}
                {selectedSnapshot.legalHold && (
                  <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700">
                    {t('snapshotBrowser.legalHold')} </span>
                )}
                {selectedSnapshot.isImmutable && (
                  <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-700">
                    {selectedSnapshot.immutabilityEnforcement === 'provider' ? 'Provider immutability' : 'Application immutability'}
                  </span>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border bg-background p-3">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <CalendarClock className="h-3.5 w-3.5" />
                    {t('snapshotBrowser.snapshotTiming')} </div>
                  <div className="mt-2 space-y-1 text-sm text-foreground">
                    <div>{t('snapshotBrowser.created')} {formatDateTime(selectedSnapshot.createdAt)}</div>
                    <div>{t('snapshotBrowser.expires')} {formatDateTime(selectedSnapshot.expiresAt)}</div>
                    <div>{t('snapshotBrowser.immutableUntil')} {formatDateTime(selectedSnapshot.immutableUntil)}</div>
                  </div>
                </div>
                <div className="rounded-md border bg-background p-3">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <Database className="h-3.5 w-3.5" />
                    {t('snapshotBrowser.snapshotDetails')} </div>
                  <div className="mt-2 space-y-1 text-sm text-foreground">
                    <div>{t('snapshotBrowser.size')} {formatBytes(selectedSnapshot.sizeBytes)}</div>
                    <div>{t('snapshotBrowser.files')} {selectedSnapshot.fileCount ?? '-'}</div>
                    <div data-testid="snapshot-location" className="break-all">
                      {t('snapshotBrowser.location')}{' '}
                      <span className="text-muted-foreground">{selectedSnapshot.location ?? '-'}</span>
                    </div>
                  </div>
                </div>
              </div>

              {(selectedSnapshot.legalHoldReason || selectedSnapshot.immutabilityEnforcement) && (
                <div className="rounded-md border bg-background p-3 text-sm">
                  {selectedSnapshot.legalHoldReason && (
                    <div>
                      <span className="font-medium text-foreground">{t('snapshotBrowser.holdReason')}</span>{' '}
                      <span className="text-muted-foreground">{selectedSnapshot.legalHoldReason}</span>
                    </div>
                  )}
                  {selectedSnapshot.legalHoldSource && (
                    <div>
                      <span className="font-medium text-foreground">{t('snapshotBrowser.holdSource')}</span>{' '}
                      <span className="text-muted-foreground">
                        {selectedSnapshot.legalHoldSource === 'policy' ? 'Inherited from backup policy' : 'Applied manually'}
                      </span>
                    </div>
                  )}
                  {selectedSnapshot.immutabilityEnforcement && (
                    <div>
                      <span className="font-medium text-foreground">{t('snapshotBrowser.enforcement')}</span>{' '}
                      <span className="text-muted-foreground">
                        {selectedSnapshot.immutabilityEnforcement === 'provider'
                          ? 'Provider-enforced WORM'
                          : 'Application-level cleanup protection'}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {selectedSnapshot.requestedImmutabilityEnforcement === 'provider' &&
                selectedSnapshot.immutabilityEnforcement === 'application' && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800">
                    {t('snapshotBrowser.providerImmutabilityWasRequestedByPolicyButBreeze')} {selectedSnapshot.immutabilityFallbackReason && (
                      <div className="mt-1 text-xs text-amber-900/80">
                        {t('snapshotBrowser.reason')} {selectedSnapshot.immutabilityFallbackReason}
                      </div>
                    )}
                  </div>
                )}
            </div>

            <div className="space-y-3 rounded-md border bg-background p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                {t('snapshotBrowser.protectionControls')} </div>
              <p className="text-xs text-muted-foreground">
                {t('snapshotBrowser.theseActionsApplyToTheSelectedSnapshotOnly')} </p>
              {selectedSnapshot.retentionBlockedReason && (
                <p className="text-xs text-muted-foreground">
                  {t('snapshotBrowser.retentionCleanupIsCurrentlyBlockedBy')} {selectedSnapshot.retentionBlockedReason === 'legal_hold' ? 'legal hold' : 'immutability'} {t('snapshotBrowser.forThisSnapshot')} </p>
              )}
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('snapshotBrowser.reason2')}</label>
                <input
                  aria-label={t('snapshotBrowser.reason2')}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={t('snapshotBrowser.reasonForApplyingOrReleasingProtection')}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('snapshotBrowser.applicationImmutabilityDays')}</label>
                <input
                  aria-label={t('snapshotBrowser.applicationImmutabilityDays')}
                  type="number"
                  min={1}
                  max={3650}
                  value={immutableDays}
                  onChange={(event) => setImmutableDays(Number(event.target.value) || 30)}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
              <div>
                <label htmlFor="snapshot-immutability-enforcement" className="text-xs font-medium text-muted-foreground">{t('snapshotBrowser.immutabilityEnforcement')}</label>
                <select
                  id="snapshot-immutability-enforcement"
                  value={immutabilityMode}
                  onChange={(event) => setImmutabilityMode(event.target.value as 'application' | 'provider')}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="application">{t('snapshotBrowser.applicationLevel')}</option>
                  <option value="provider">{t('snapshotBrowser.providerEnforced')}</option>
                </select>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  disabled={actionLoading || selectedSnapshot.legalHold}
                  onClick={() => void handleProtectionAction('apply-hold')}
                  className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-800 disabled:opacity-50"
                >
                  {actionLoading ? 'Working...' : 'Apply legal hold'}
                </button>
                <button
                  type="button"
                  disabled={actionLoading || !selectedSnapshot.legalHold}
                  onClick={() => void handleProtectionAction('release-hold')}
                  className="rounded-md border px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
                >
                  {t('snapshotBrowser.releaseLegalHold')} </button>
                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={() => void handleProtectionAction('apply-immutability')}
                  className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm font-medium text-sky-800 disabled:opacity-50"
                >
                  {selectedSnapshot.isImmutable ? 'Extend immutability' : 'Apply immutability'}
                </button>
                <button
                  type="button"
                  disabled={
                    actionLoading ||
                    !selectedSnapshot.isImmutable ||
                    selectedSnapshot.immutabilityEnforcement === 'provider'
                  }
                  onClick={() => void handleProtectionAction('release-immutability')}
                  className="rounded-md border px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
                >
                  {t('snapshotBrowser.releaseAppImmutability')} </button>
              </div>
              {selectedSnapshot.immutabilityEnforcement === 'provider' && selectedSnapshot.isImmutable && (
                <p className="text-xs text-muted-foreground">
                  {t('snapshotBrowser.providerEnforcedImmutabilityCannotBeReleasedFromBreeze')} </p>
              )}
            </div>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <div className="rounded-md border bg-muted/10 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('snapshotBrowser.fileTree')}</h3>
            <div className="mt-3 space-y-1 text-sm">
              {rootLoaded && !rootEmpty ? (
                renderTree(null)
              ) : (
                <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                  {t('snapshotBrowser.noFileTreeAvailable')} </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">{t('snapshotBrowser.path')}</span>
                <span className="ml-2 text-muted-foreground">/</span>
                {breadcrumbs.map((crumb, index) => (
                  <span key={`${index}-${crumb}`} className="ml-2 text-muted-foreground">
                    {crumb}
                    {index < breadcrumbs.length - 1 && <span className="mx-1">/</span>}
                  </span>
                ))}
              </div>
              {/* #6349: this sentence used to be dead copy — the restore
                  workflow it points at was never mounted. It is now the
                  Restore tab on this same dashboard, so the pointer is a real
                  link. #6456: the selected snapshot + checked files are now
                  carried into the wizard via the hash, so the operator isn't
                  made to re-select them there. */}
              <HashLink
                hash={restoreLinkSnapshotId ? buildRestoreHash(restoreLinkSnapshotId, Array.from(selectedFiles)) : 'restore'}
                data-testid="snapshot-browser-restore-link"
                className="text-xs font-medium text-primary underline-offset-2 hover:underline"
              >
                {t('snapshotBrowser.useTheRestoreWorkflowToRecoverOrExport')}
              </HashLink>
            </div>

            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[400px]">
                <thead className="bg-muted/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">{t('snapshotBrowser.select')}</th>
                    <th className="px-4 py-3">{t('snapshotBrowser.name')}</th>
                    <th className="px-4 py-3">{t('snapshotBrowser.size2')}</th>
                    <th className="px-4 py-3">{t('snapshotBrowser.modified')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visibleFiles.map((file) => (
                    <tr key={file.id} className="text-sm text-foreground">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedFiles.has(file.id)}
                          onChange={() => toggleFile(file.id)}
                          aria-label={`Select ${file.name}`}
                          className="h-4 w-4"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          {file.name}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{file.size}</td>
                      <td className="px-4 py-3 text-muted-foreground">{file.modified}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {dirs[selectedFolder]?.nextCursor && !dirs[selectedFolder]?.loading && (
              <button
                type="button"
                onClick={() => void loadDir(selectedFolder, dirs[selectedFolder]?.nextCursor)}
                className="text-xs font-medium text-primary hover:underline"
              >
                Load more
              </button>
            )}

            {visibleFiles.length === 0 && !dirs[selectedFolder]?.loading && (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                {!rootEmpty && rootLoaded
                  ? 'Select a folder in the tree to view its files.'
                  : selectedSnapshot?.manifestUnavailable
                    ? t('snapshotBrowser.fileIndexUnavailable')
                    : 'No files in this snapshot. The backup may still be processing.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
