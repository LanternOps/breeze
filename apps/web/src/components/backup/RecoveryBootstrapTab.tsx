import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Copy,
  Filter,
  Loader2,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { formatTime } from './backupDashboardHelpers';

type RecoveryTokenStatus = 'active' | 'revoked' | 'expired' | 'used' | 'completed' | string;
type RecoveryTokenRestoreType = 'full' | 'selective' | 'bare_metal' | string;

type SnapshotSummary = {
  id: string;
  label?: string | null;
  timestamp?: string | null;
  size?: number | null;
};

type BootstrapSnapshot = {
  id?: string | null;
  orgId?: string | null;
  jobId?: string | null;
  deviceId?: string | null;
  configId?: string | null;
  snapshotId?: string | null;
  label?: string | null;
  location?: string | null;
  timestamp?: string | null;
  size?: number | null;
  fileCount?: number | null;
  backupType?: string | null;
  isIncremental?: boolean | null;
  metadata?: Record<string, unknown> | null;
};

type BootstrapConfig = {
  id?: string | null;
  orgId?: string | null;
  name?: string | null;
  type?: string | null;
  provider?: string | null;
  isActive?: boolean | null;
};

type BootstrapDownload = {
  type?: string | null;
  method?: string | null;
  url?: string | null;
  pathPrefix?: string | null;
  expiresAt?: string | null;
  requiresAuthentication?: boolean | null;
};

type RecoveryBootstrapPreview = {
  version?: number | null;
  minHelperVersion?: string | null;
  serverUrl?: string | null;
  releaseUrl?: string | null;
  commandTemplate?: string | null;
  prerequisites?: string[] | null;
  providerType?: string | null;
  backupConfig?: BootstrapConfig | null;
  download?: BootstrapDownload | null;
  snapshot?: BootstrapSnapshot | null;
  targetConfig?: Record<string, unknown> | null;
};

type LinkedRestoreJob = {
  id?: string | null;
  status?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  restoredFiles?: number | null;
  restoredSize?: number | null;
  result?: Record<string, unknown> | null;
};

type RecoveryMediaArtifact = {
  id: string;
  tokenId: string;
  snapshotId: string;
  platform: string;
  architecture: string;
  status: string;
  checksumSha256?: string | null;
  signatureFormat?: string | null;
  signingKeyId?: string | null;
  signedAt?: string | null;
  publicKey?: string | null;
  publicKeyPath?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | null;
  completedAt?: string | null;
  downloadPath?: string | null;
  signatureDownloadPath?: string | null;
};

type RecoveryBootMediaArtifact = {
  id: string;
  tokenId: string;
  snapshotId: string;
  bundleArtifactId?: string | null;
  platform: string;
  architecture: string;
  mediaType: string;
  status: string;
  checksumSha256?: string | null;
  signatureFormat?: string | null;
  signingKeyId?: string | null;
  signedAt?: string | null;
  publicKey?: string | null;
  publicKeyPath?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | null;
  completedAt?: string | null;
  downloadPath?: string | null;
  signatureDownloadPath?: string | null;
};

type RecoveryTokenRecord = {
  id: string;
  token?: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
  snapshotId?: string | null;
  restoreType?: RecoveryTokenRestoreType;
  status?: RecoveryTokenStatus;
  sessionStatus?: string | null;
  createdAt?: string | null;
  expiresAt?: string | null;
  authenticatedAt?: string | null;
  completedAt?: string | null;
  usedAt?: string | null;
  targetConfig?: Record<string, unknown> | null;
  restoreJobId?: string | null;
  restoreResult?: Record<string, unknown> | null;
  linkedRestoreJob?: LinkedRestoreJob | null;
  bootstrapPreview?: RecoveryBootstrapPreview | null;
  notes?: string | null;
};

type TokenStatusFilter = RecoveryTokenStatus | 'all';
type RestoreTypeFilter = RecoveryTokenRestoreType | 'all';

const STORAGE_KEY = 'breeze-backup-recovery-bootstrap-catalog';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function toNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toMaybeRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function renderTrustMetadata(metadata: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!metadata) return null;
  const rows = keys
    .map((key) => {
      const value = metadata[key];
      if (value == null || value === '') return null;
      return { key, value: typeof value === 'string' ? value : JSON.stringify(value) };
    })
    .filter(Boolean) as Array<{ key: string; value: string }>;
  if (rows.length === 0) return null;

  return (
    <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
      {rows.map((row) => (
        <p key={row.key}>
          {row.key}: <span className="break-all font-mono">{row.value}</span>
        </p>
      ))}
    </div>
  );
}

function readStoredTokens(): RecoveryTokenRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!isRecord(item) || !toText(item.id)) return null;
        return {
          id: toText(item.id),
          deviceId: item.deviceId == null ? null : toText(item.deviceId),
          deviceName: item.deviceName == null ? null : toText(item.deviceName),
          snapshotId: item.snapshotId == null ? null : toText(item.snapshotId),
          restoreType: item.restoreType == null ? undefined : toText(item.restoreType),
          status: item.status == null ? undefined : toText(item.status),
          sessionStatus: item.sessionStatus == null ? null : toText(item.sessionStatus),
          createdAt: item.createdAt == null ? null : toText(item.createdAt),
          expiresAt: item.expiresAt == null ? null : toText(item.expiresAt),
          authenticatedAt: item.authenticatedAt == null ? null : toText(item.authenticatedAt),
          completedAt: item.completedAt == null ? null : toText(item.completedAt),
          usedAt: item.usedAt == null ? null : toText(item.usedAt),
          targetConfig: toMaybeRecord(item.targetConfig),
          restoreJobId: item.restoreJobId == null ? null : toText(item.restoreJobId),
          restoreResult: toMaybeRecord(item.restoreResult),
          linkedRestoreJob: toMaybeRecord(item.linkedRestoreJob) as LinkedRestoreJob | null,
          bootstrapPreview: toMaybeRecord(item.bootstrapPreview) as RecoveryBootstrapPreview | null,
          notes: item.notes == null ? null : toText(item.notes),
        } satisfies RecoveryTokenRecord;
      })
      .filter(Boolean) as RecoveryTokenRecord[];
  } catch {
    return [];
  }
}

function persistTokens(tokens: RecoveryTokenRecord[]) {
  if (typeof window === 'undefined') return;
  try {
    const safeTokens = tokens.map(({ token: _token, bootstrapPreview: _bootstrapPreview, ...rest }) => rest);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(safeTokens));
  } catch {
    // Ignore storage quota / privacy mode failures.
  }
}

function getRecoveryServerBase(): string {
  const raw = import.meta.env.PUBLIC_API_URL || '';
  if (!raw) {
    return typeof window !== 'undefined' ? window.location.origin.replace(/\/$/, '') : '';
  }

  try {
    return new URL(raw, typeof window !== 'undefined' ? window.location.origin : 'http://localhost').origin;
  } catch {
    return raw.replace(/\/$/, '');
  }
}

function buildCliCommand(token: string): string {
  const server = getRecoveryServerBase();
  return `breeze-backup bmr-recover --token ${token} --server ${server}`;
}

function normalizeApiResponse<T = Record<string, unknown>>(payload: unknown): T {
  if (isRecord(payload) && 'data' in payload) {
    return (payload as Record<string, unknown>).data as T;
  }
  return (isRecord(payload) ? payload : {}) as T;
}

function toTokenRecord(raw: Record<string, unknown>, fallback?: Partial<RecoveryTokenRecord>): RecoveryTokenRecord {
  const bootstrapPreview = isRecord(raw.bootstrapPreview)
    ? (raw.bootstrapPreview as RecoveryBootstrapPreview)
    : isRecord(raw.bootstrap)
      ? ({
          version: typeof raw.bootstrap.version === 'number' ? raw.bootstrap.version : null,
          minHelperVersion: raw.bootstrap.minHelperVersion == null ? null : toText(raw.bootstrap.minHelperVersion),
          serverUrl: raw.bootstrap.serverUrl == null ? null : toText(raw.bootstrap.serverUrl),
          releaseUrl: raw.bootstrap.releaseUrl == null ? null : toText(raw.bootstrap.releaseUrl),
          commandTemplate: raw.bootstrap.commandTemplate == null ? null : toText(raw.bootstrap.commandTemplate),
          prerequisites: Array.isArray(raw.bootstrap.prerequisites)
            ? raw.bootstrap.prerequisites.map((item) => toText(item))
            : null,
          providerType: isRecord(raw.bootstrap.provider)
            ? (raw.bootstrap.provider.type == null ? null : toText(raw.bootstrap.provider.type))
            : raw.bootstrap.providerType == null
              ? null
              : toText(raw.bootstrap.providerType),
          backupConfig: isRecord(raw.bootstrap.provider)
            ? (isRecord(raw.bootstrap.provider.backupConfig)
              ? (raw.bootstrap.provider.backupConfig as BootstrapConfig)
              : null)
            : isRecord(raw.bootstrap.backupConfig)
              ? (raw.bootstrap.backupConfig as BootstrapConfig)
              : null,
          download: isRecord(raw.bootstrap.download)
            ? ({
                type: raw.bootstrap.download.type == null ? null : toText(raw.bootstrap.download.type),
                method: raw.bootstrap.download.method == null ? null : toText(raw.bootstrap.download.method),
                url: raw.bootstrap.download.url == null ? null : toText(raw.bootstrap.download.url),
                pathPrefix: raw.bootstrap.download.pathPrefix == null ? null : toText(raw.bootstrap.download.pathPrefix),
                expiresAt: raw.bootstrap.download.expiresAt == null ? null : toText(raw.bootstrap.download.expiresAt),
                requiresAuthentication:
                  typeof raw.bootstrap.download.requiresAuthentication === 'boolean'
                    ? raw.bootstrap.download.requiresAuthentication
                    : null,
              } satisfies BootstrapDownload)
            : null,
          snapshot: isRecord(raw.snapshot)
            ? (raw.snapshot as BootstrapSnapshot)
            : isRecord(raw.bootstrap.snapshot)
              ? (raw.bootstrap.snapshot as BootstrapSnapshot)
              : null,
          targetConfig: toMaybeRecord(raw.targetConfig) ?? toMaybeRecord(raw.bootstrap.targetConfig),
        } as RecoveryBootstrapPreview)
      : fallback?.bootstrapPreview ?? null;

  const linkedRestoreJob = isRecord(raw.linkedRestoreJob)
    ? ({
        id: raw.linkedRestoreJob.id == null ? null : toText(raw.linkedRestoreJob.id),
        status: raw.linkedRestoreJob.status == null ? null : toText(raw.linkedRestoreJob.status),
        createdAt: raw.linkedRestoreJob.createdAt == null ? null : toText(raw.linkedRestoreJob.createdAt),
        startedAt: raw.linkedRestoreJob.startedAt == null ? null : toText(raw.linkedRestoreJob.startedAt),
        completedAt: raw.linkedRestoreJob.completedAt == null ? null : toText(raw.linkedRestoreJob.completedAt),
        restoredFiles: toNumber(raw.linkedRestoreJob.restoredFiles),
        restoredSize: toNumber(raw.linkedRestoreJob.restoredSize),
        result: toMaybeRecord(raw.linkedRestoreJob.result),
      } satisfies LinkedRestoreJob)
    : fallback?.linkedRestoreJob ?? null;

  return {
    id: toText(raw.id, fallback?.id ?? ''),
    token: raw.token == null ? fallback?.token ?? null : toText(raw.token),
    deviceId: raw.deviceId == null ? fallback?.deviceId ?? null : toText(raw.deviceId),
    deviceName: isRecord(raw.device)
      ? (raw.device.displayName == null
        ? raw.device.hostname == null
          ? fallback?.deviceName ?? null
          : toText(raw.device.hostname)
        : toText(raw.device.displayName))
      : fallback?.deviceName ?? null,
    snapshotId: raw.snapshotId == null ? fallback?.snapshotId ?? null : toText(raw.snapshotId),
    restoreType: raw.restoreType == null ? fallback?.restoreType ?? 'full' : toText(raw.restoreType),
    status: raw.status == null ? fallback?.status ?? 'active' : toText(raw.status),
    sessionStatus: raw.sessionStatus == null ? fallback?.sessionStatus ?? null : toText(raw.sessionStatus),
    createdAt: raw.createdAt == null ? fallback?.createdAt ?? null : toText(raw.createdAt),
    expiresAt: raw.expiresAt == null ? fallback?.expiresAt ?? null : toText(raw.expiresAt),
    authenticatedAt: raw.authenticatedAt == null ? fallback?.authenticatedAt ?? null : toText(raw.authenticatedAt),
    completedAt: raw.completedAt == null ? fallback?.completedAt ?? null : toText(raw.completedAt),
    usedAt: raw.usedAt == null ? fallback?.usedAt ?? null : toText(raw.usedAt),
    targetConfig: toMaybeRecord(raw.targetConfig) ?? fallback?.targetConfig ?? null,
    restoreJobId: linkedRestoreJob?.id ?? (raw.restoreJobId == null ? fallback?.restoreJobId ?? null : toText(raw.restoreJobId)),
    restoreResult: linkedRestoreJob?.result ?? toMaybeRecord(raw.restoreResult) ?? fallback?.restoreResult ?? null,
    linkedRestoreJob,
    bootstrapPreview,
    notes: raw.notes == null ? fallback?.notes ?? null : toText(raw.notes),
  };
}

function toMediaRecord(raw: Record<string, unknown>): RecoveryMediaArtifact {
  return {
    id: toText(raw.id),
    tokenId: toText(raw.tokenId),
    snapshotId: toText(raw.snapshotId),
    platform: toText(raw.platform),
    architecture: toText(raw.architecture),
    status: toText(raw.status),
    checksumSha256: raw.checksumSha256 == null ? null : toText(raw.checksumSha256),
    signatureFormat: raw.signatureFormat == null ? null : toText(raw.signatureFormat),
    signingKeyId: raw.signingKeyId == null ? null : toText(raw.signingKeyId),
    signedAt: raw.signedAt == null ? null : toText(raw.signedAt),
    publicKey: raw.publicKey == null ? null : toText(raw.publicKey),
    publicKeyPath: raw.publicKeyPath == null ? null : toText(raw.publicKeyPath),
    metadata: toMaybeRecord(raw.metadata),
    createdAt: raw.createdAt == null ? null : toText(raw.createdAt),
    completedAt: raw.completedAt == null ? null : toText(raw.completedAt),
    downloadPath: raw.downloadPath == null ? null : toText(raw.downloadPath),
    signatureDownloadPath: raw.signatureDownloadPath == null ? null : toText(raw.signatureDownloadPath),
  };
}

function toBootMediaRecord(raw: Record<string, unknown>): RecoveryBootMediaArtifact {
  return {
    id: toText(raw.id),
    tokenId: toText(raw.tokenId),
    snapshotId: toText(raw.snapshotId),
    bundleArtifactId: raw.bundleArtifactId == null ? null : toText(raw.bundleArtifactId),
    platform: toText(raw.platform),
    architecture: toText(raw.architecture),
    mediaType: toText(raw.mediaType),
    status: toText(raw.status),
    checksumSha256: raw.checksumSha256 == null ? null : toText(raw.checksumSha256),
    signatureFormat: raw.signatureFormat == null ? null : toText(raw.signatureFormat),
    signingKeyId: raw.signingKeyId == null ? null : toText(raw.signingKeyId),
    signedAt: raw.signedAt == null ? null : toText(raw.signedAt),
    publicKey: raw.publicKey == null ? null : toText(raw.publicKey),
    publicKeyPath: raw.publicKeyPath == null ? null : toText(raw.publicKeyPath),
    metadata: toMaybeRecord(raw.metadata),
    createdAt: raw.createdAt == null ? null : toText(raw.createdAt),
    completedAt: raw.completedAt == null ? null : toText(raw.completedAt),
    downloadPath: raw.downloadPath == null ? null : toText(raw.downloadPath),
    signatureDownloadPath: raw.signatureDownloadPath == null ? null : toText(raw.signatureDownloadPath),
  };
}

function formatStatusLabel(status?: string | null): string {
  if (!status) return 'Unknown';
  return status.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusClassName(status?: string | null): string {
  switch ((status ?? '').toLowerCase()) {
    case 'active':
      return 'bg-success/10 text-success';
    case 'revoked':
      return 'bg-destructive/10 text-destructive';
    case 'expired':
      return 'bg-warning/10 text-warning';
    case 'completed':
      return 'bg-primary/10 text-primary';
    case 'used':
      return 'bg-muted text-muted-foreground';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function restoreTypeLabel(type?: string | null): string {
  switch (type) {
    case 'full':
      return 'Full restore';
    case 'selective':
      return 'Selective restore';
    case 'bare_metal':
      return 'Bare metal';
    default:
      return type ? type.replace(/_/g, ' ') : 'Unknown';
  }
}

function renderJson(value: unknown): string {
  if (value == null) return '-';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function DetailLine({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md border bg-background/80 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm text-foreground">{value}</div>
    </div>
  );
}

export default function RecoveryBootstrapTab() {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [catalog, setCatalog] = useState<RecoveryTokenRecord[]>(() => readStoredTokens());
  const [mediaCatalog, setMediaCatalog] = useState<RecoveryMediaArtifact[]>([]);
  const [bootMediaCatalog, setBootMediaCatalog] = useState<RecoveryBootMediaArtifact[]>([]);
  const [selectedTokenId, setSelectedTokenId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TokenStatusFilter>('all');
  const [restoreTypeFilter, setRestoreTypeFilter] = useState<RestoreTypeFilter>('all');
  const [loadTokenId, setLoadTokenId] = useState('');
  const [creating, setCreating] = useState(false);
  const [loadingSnapshots, setLoadingSnapshots] = useState(true);
  const [refreshingTokenId, setRefreshingTokenId] = useState<string | null>(null);
  const [previewingTokenId, setPreviewingTokenId] = useState<string | null>(null);
  const [copyStatusId, setCopyStatusId] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [tokenMessage, setTokenMessage] = useState<string>();
  const [loadingMedia, setLoadingMedia] = useState(false);
  const [creatingMedia, setCreatingMedia] = useState(false);
  const [creatingBootMedia, setCreatingBootMedia] = useState(false);
  const [createSnapshotId, setCreateSnapshotId] = useState('');
  const [createRestoreType, setCreateRestoreType] = useState<RecoveryTokenRestoreType>('bare_metal');
  const [createExpiresInHours, setCreateExpiresInHours] = useState('24');
  const [createTargetConfig, setCreateTargetConfig] = useState('');
  const [bundlePlatform, setBundlePlatform] = useState('linux');
  const [bundleArchitecture, setBundleArchitecture] = useState('amd64');

  const refreshArtifacts = useCallback(async () => {
    const [mediaResponse, bootMediaResponse] = await Promise.all([
      fetchWithAuth('/backup/bmr/media?limit=100'),
      fetchWithAuth('/backup/bmr/boot-media?limit=100'),
    ]);
    if (!mediaResponse.ok) {
      throw new Error('Failed to load recovery bundles');
    }
    if (!bootMediaResponse.ok) {
      throw new Error('Failed to load bootable recovery media');
    }

    const mediaPayload = await mediaResponse.json();
    const mediaRows = isRecord(mediaPayload) && Array.isArray(mediaPayload.data)
      ? mediaPayload.data
      : Array.isArray(mediaPayload)
        ? mediaPayload
        : [];
    setMediaCatalog(
      Array.isArray(mediaRows)
        ? mediaRows
            .filter((item): item is Record<string, unknown> => isRecord(item))
            .map(toMediaRecord)
        : []
    );

    const bootMediaPayload = await bootMediaResponse.json();
    const bootMediaRows = isRecord(bootMediaPayload) && Array.isArray(bootMediaPayload.data)
      ? bootMediaPayload.data
      : Array.isArray(bootMediaPayload)
        ? bootMediaPayload
        : [];
    setBootMediaCatalog(
      Array.isArray(bootMediaRows)
        ? bootMediaRows
            .filter((item): item is Record<string, unknown> => isRecord(item))
            .map(toBootMediaRecord)
        : []
    );
  }, []);

  useEffect(() => {
    persistTokens(catalog);
  }, [catalog]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let cancelled = false;
    const fetchInitialData = async () => {
      try {
        setLoadingSnapshots(true);
        const [snapshotsResponse, tokensResponse] = await Promise.all([
          fetchWithAuth('/backup/snapshots'),
          fetchWithAuth('/backup/bmr/tokens?limit=100'),
        ]);
        if (!snapshotsResponse.ok) {
          throw new Error('Failed to load snapshots');
        }
        if (!tokensResponse.ok) {
          throw new Error('Failed to load recovery tokens');
        }
        const payload = normalizeApiResponse(await snapshotsResponse.json());
        const list = Array.isArray(payload.snapshots)
          ? payload.snapshots
          : Array.isArray(payload)
            ? payload
            : [];

        const nextSnapshots = list
          .map((item): SnapshotSummary | null => {
            if (!isRecord(item) || !toText(item.id)) return null;
            return {
              id: toText(item.id),
              label: item.label == null ? null : toText(item.label),
              timestamp: item.timestamp == null ? null : toText(item.timestamp),
              size: toNumber(item.size ?? item.sizeBytes ?? item.totalBytes),
            };
          })
          .filter(Boolean) as SnapshotSummary[];

        if (cancelled) return;
        setSnapshots(nextSnapshots);
        setCreateSnapshotId((current) => current || nextSnapshots[0]?.id || '');

        const existing = readStoredTokens();
        const existingById = new Map(existing.map((item) => [item.id, item]));
        const tokenPayload = await tokensResponse.json();
        const tokenRows = isRecord(tokenPayload) && Array.isArray(tokenPayload.data)
          ? tokenPayload.data
          : Array.isArray(tokenPayload)
            ? tokenPayload
            : [];
        const remoteTokens = Array.isArray(tokenRows)
          ? tokenRows
              .filter((item): item is Record<string, unknown> => isRecord(item))
              .map((item) => toTokenRecord(item, existingById.get(toText(item.id))))
          : [];
        setCatalog((prev) => {
          const prevById = new Map(prev.map((item) => [item.id, item]));
          const merged = remoteTokens.map((item) => {
            const local = prevById.get(item.id) ?? existingById.get(item.id);
            return {
              ...item,
              token: local?.token ?? item.token ?? null,
              bootstrapPreview: item.bootstrapPreview ?? local?.bootstrapPreview ?? null,
            };
          });
          const remoteIds = new Set(merged.map((item) => item.id));
          const localOnly = [...prevById.values(), ...existingById.values()].filter(
            (item, index, all) => !remoteIds.has(item.id) && all.findIndex((candidate) => candidate.id === item.id) === index
          );
          return [...merged, ...localOnly];
        });

        await refreshArtifacts();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load snapshots');
        }
      } finally {
        if (!cancelled) setLoadingSnapshots(false);
      }
    };

    void fetchInitialData();
    return () => {
      cancelled = true;
    };
  }, [refreshArtifacts]);

  const selectedToken = useMemo(
    () => catalog.find((token) => token.id === selectedTokenId) ?? null,
    [catalog, selectedTokenId]
  );
  const selectedMedia = useMemo(
    () => mediaCatalog.filter((artifact) => artifact.tokenId === selectedTokenId),
    [mediaCatalog, selectedTokenId]
  );
  const selectedBootMedia = useMemo(
    () => bootMediaCatalog.filter((artifact) => artifact.tokenId === selectedTokenId),
    [bootMediaCatalog, selectedTokenId]
  );

  useEffect(() => {
    if (!selectedMedia.some((artifact) => artifact.status === 'pending' || artifact.status === 'building') &&
        !selectedBootMedia.some((artifact) => artifact.status === 'pending' || artifact.status === 'building')) {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshArtifacts().catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to refresh recovery artifacts');
      });
    }, 10000);

    return () => window.clearInterval(timer);
  }, [refreshArtifacts, selectedBootMedia, selectedMedia]);

  useEffect(() => {
    if (!selectedTokenId && catalog.length > 0) {
      setSelectedTokenId(catalog[0].id);
    }
  }, [catalog, selectedTokenId]);

  const filteredTokens = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return [...catalog]
      .filter((token) => {
        const haystack = [
          token.id,
          token.deviceId,
          token.snapshotId,
          token.restoreType,
          token.status,
          token.notes,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        const matchesQuery = normalizedQuery ? haystack.includes(normalizedQuery) : true;
        const matchesStatus = statusFilter === 'all' ? true : token.status === statusFilter;
        const matchesRestoreType =
          restoreTypeFilter === 'all' ? true : token.restoreType === restoreTypeFilter;

        return matchesQuery && matchesStatus && matchesRestoreType;
      })
      .sort((a, b) => {
        const aTime = new Date(a.createdAt ?? 0).getTime();
        const bTime = new Date(b.createdAt ?? 0).getTime();
        return bTime - aTime;
      });
  }, [catalog, query, restoreTypeFilter, statusFilter]);

  const updateToken = useCallback((id: string, updater: (current: RecoveryTokenRecord) => RecoveryTokenRecord) => {
    setCatalog((prev) => prev.map((token) => (token.id === id ? updater(token) : token)));
  }, []);

  const upsertToken = useCallback((token: RecoveryTokenRecord) => {
    setCatalog((prev) => {
      const existingIndex = prev.findIndex((item) => item.id === token.id);
      if (existingIndex === -1) {
        return [token, ...prev];
      }
      const next = [...prev];
      next[existingIndex] = {
        ...next[existingIndex],
        ...token,
        token: token.token ?? next[existingIndex].token ?? null,
        bootstrapPreview: token.bootstrapPreview ?? next[existingIndex].bootstrapPreview ?? null,
      };
      return next;
    });
    setSelectedTokenId(token.id);
  }, []);

  const handleCreateToken = useCallback(async () => {
    setError(undefined);
    setTokenMessage(undefined);

    if (!createSnapshotId) {
      setError('Select a snapshot first.');
      return;
    }

    const expiresInHours = Number(createExpiresInHours);
    if (!Number.isFinite(expiresInHours) || expiresInHours < 1) {
      setError('Expiration must be at least 1 hour.');
      return;
    }

    let parsedTargetConfig: Record<string, unknown> | undefined;
    if (createTargetConfig.trim()) {
      try {
        const parsed = JSON.parse(createTargetConfig);
        if (!isRecord(parsed)) {
          throw new Error('Target config must be a JSON object.');
        }
        parsedTargetConfig = parsed;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Target config must be valid JSON.');
        return;
      }
    }

    try {
      setCreating(true);
      const response = await fetchWithAuth('/backup/bmr/tokens', {
        method: 'POST',
        body: JSON.stringify({
          snapshotId: createSnapshotId,
          restoreType: createRestoreType,
          targetConfig: parsedTargetConfig,
          expiresInHours,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Failed to create recovery token');
      }

      const payload = normalizeApiResponse(await response.json());
      const createdToken = toTokenRecord(payload, {
        restoreType: createRestoreType,
        snapshotId: createSnapshotId,
      });

      upsertToken(createdToken);
      setTokenMessage('Recovery token created. Copy the CLI command before you leave this page.');
      setCreateTargetConfig('');
      setCreateExpiresInHours('24');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create recovery token');
    } finally {
      setCreating(false);
    }
  }, [createExpiresInHours, createRestoreType, createSnapshotId, createTargetConfig, upsertToken]);

  const handleLoadToken = useCallback(async () => {
    const tokenId = loadTokenId.trim();
    if (!tokenId) {
      setError('Enter a token ID to load.');
      return;
    }

    setError(undefined);
    setTokenMessage(undefined);
    try {
      setRefreshingTokenId(tokenId);
      const response = await fetchWithAuth(`/backup/bmr/tokens/${encodeURIComponent(tokenId)}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Failed to load token');
      }
      const payload = normalizeApiResponse(await response.json());
      const token = toTokenRecord(payload, { id: tokenId });
      upsertToken(token);
      setLoadTokenId('');
      setTokenMessage('Recovery token metadata loaded.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load token');
    } finally {
      setRefreshingTokenId(null);
    }
  }, [loadTokenId, upsertToken]);

  const handleRefreshToken = useCallback(
    async (tokenId: string) => {
      try {
        setRefreshingTokenId(tokenId);
        const response = await fetchWithAuth(`/backup/bmr/tokens/${encodeURIComponent(tokenId)}`);
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error ?? 'Failed to refresh token');
        }
        const payload = normalizeApiResponse(await response.json());
        updateToken(tokenId, (current) => toTokenRecord(payload, current));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to refresh token');
      } finally {
        setRefreshingTokenId(null);
      }
    },
    [updateToken]
  );

  const handlePreviewBootstrap = useCallback(
    async (tokenId: string) => {
      const token = catalog.find((item) => item.id === tokenId);
      if (!token?.token) {
        setError('The plaintext token is only available immediately after creation in this browser session.');
        return;
      }

      try {
        setPreviewingTokenId(tokenId);
        setError(undefined);
        const response = await fetchWithAuth('/backup/bmr/recover/authenticate', {
          method: 'POST',
          body: JSON.stringify({ token: token.token }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error ?? 'Failed to preview bootstrap');
        }

        const payload = normalizeApiResponse(await response.json());
        const authenticatedAt = toText(payload.authenticatedAt, null as unknown as string) || null;
        const bootstrapPreview = isRecord(payload.bootstrap)
          ? (toTokenRecord(payload, token).bootstrapPreview ?? null)
          : token.bootstrapPreview ?? null;
        updateToken(tokenId, (current) => ({
          ...current,
          authenticatedAt: authenticatedAt ?? current.authenticatedAt ?? null,
          bootstrapPreview,
          deviceId: toText(payload.deviceId, current.deviceId ?? ''),
          snapshotId: toText(payload.snapshotId, current.snapshotId ?? ''),
          restoreType: toText(payload.restoreType, current.restoreType ?? 'full'),
          targetConfig: toMaybeRecord(payload.targetConfig) ?? current.targetConfig ?? null,
        }));
        setSelectedTokenId(tokenId);
        setTokenMessage('Bootstrap preview loaded. The token has been authenticated for the recovery session.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to preview bootstrap');
      } finally {
        setPreviewingTokenId(null);
      }
    },
    [catalog, updateToken]
  );

  const handleRevoke = useCallback(
    async (tokenId: string) => {
      const ok = typeof window === 'undefined'
        ? true
        : window.confirm('Revoke this recovery token? The recovery agent will no longer be able to use it.');
      if (!ok) return;

      try {
        setRefreshingTokenId(tokenId);
        setError(undefined);
        const response = await fetchWithAuth(`/backup/bmr/tokens/${encodeURIComponent(tokenId)}`, {
          method: 'DELETE',
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error ?? 'Failed to revoke token');
        }
        updateToken(tokenId, (current) => ({ ...current, status: 'revoked' }));
        setMediaCatalog((prev) =>
          prev.map((artifact) =>
            artifact.tokenId === tokenId ? { ...artifact, status: 'expired' } : artifact
          )
        );
        setTokenMessage('Recovery token revoked.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to revoke token');
      } finally {
        setRefreshingTokenId(null);
      }
    },
    [updateToken]
  );

  const copyText = useCallback(async (value: string, id: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatusId(id);
      window.setTimeout(() => setCopyStatusId((current) => (current === id ? null : current)), 1500);
    } catch {
      setError('Failed to copy to clipboard.');
    }
  }, []);

  const handleCreateBundle = useCallback(async () => {
    if (!selectedToken) {
      setError('Select a recovery token first.');
      return;
    }

    try {
      setCreatingMedia(true);
      setError(undefined);
      const response = await fetchWithAuth('/backup/bmr/media', {
        method: 'POST',
        body: JSON.stringify({
          tokenId: selectedToken.id,
          platform: bundlePlatform,
          architecture: bundleArchitecture,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Failed to create recovery bundle');
      }
      const payload = normalizeApiResponse(await response.json());
      if (isRecord(payload)) {
        const nextArtifact = toMediaRecord(payload);
        setMediaCatalog((prev) => {
          const existing = prev.findIndex((item) => item.id === nextArtifact.id);
          if (existing === -1) return [nextArtifact, ...prev];
          const copy = [...prev];
          copy[existing] = nextArtifact;
          return copy;
        });
      }
      setTokenMessage('Recovery bundle build started.');
      await refreshArtifacts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create recovery bundle');
    } finally {
      setCreatingMedia(false);
    }
  }, [bundleArchitecture, bundlePlatform, refreshArtifacts, selectedToken]);

  const handleDownloadBundle = useCallback(async (artifact: RecoveryMediaArtifact) => {
    if (!artifact.downloadPath) return;
    try {
      setLoadingMedia(true);
      setError(undefined);
      const response = await fetchWithAuth(artifact.downloadPath);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Failed to download recovery bundle');
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${artifact.platform}-${artifact.architecture}-recovery-bundle.tar.gz`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download recovery bundle');
    } finally {
      setLoadingMedia(false);
    }
  }, []);

  const handleDownloadArtifact = useCallback(async (downloadPath: string, fileName: string, failureMessage: string) => {
    try {
      setLoadingMedia(true);
      setError(undefined);
      const response = await fetchWithAuth(downloadPath);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? failureMessage);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : failureMessage);
    } finally {
      setLoadingMedia(false);
    }
  }, []);

  const handleCreateBootMedia = useCallback(async () => {
    if (!selectedToken) {
      setError('Select a recovery token first.');
      return;
    }

    try {
      setCreatingBootMedia(true);
      setError(undefined);
      const response = await fetchWithAuth('/backup/bmr/boot-media', {
        method: 'POST',
        body: JSON.stringify({
          tokenId: selectedToken.id,
          platform: 'linux',
          architecture: 'amd64',
          mediaType: 'iso',
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Failed to create bootable recovery media');
      }
      const payload = normalizeApiResponse(await response.json());
      if (isRecord(payload)) {
        const nextArtifact = toBootMediaRecord(payload);
        setBootMediaCatalog((prev) => {
          const existing = prev.findIndex((item) => item.id === nextArtifact.id);
          if (existing === -1) return [nextArtifact, ...prev];
          const copy = [...prev];
          copy[existing] = nextArtifact;
          return copy;
        });
      }
      setTokenMessage('Bootable recovery media build started.');
      await refreshArtifacts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create bootable recovery media');
    } finally {
      setCreatingBootMedia(false);
    }
  }, [refreshArtifacts, selectedToken]);

  const selectedCommand = selectedToken?.token
    ? `breeze-backup bmr-recover --token ${selectedToken.token} --server ${selectedToken.bootstrapPreview?.serverUrl ?? getRecoveryServerBase()}`
    : selectedToken?.bootstrapPreview?.commandTemplate ?? null;
  const selectedBootstrap = selectedToken?.bootstrapPreview ?? null;

  if (loadingSnapshots && catalog.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading recovery bootstrap tools...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-warning/30 bg-warning/5 p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-2 rounded-md bg-warning/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-warning">
              <TerminalSquare className="h-3.5 w-3.5" />
              Manual recovery environment
            </div>
            <h2 className="text-xl font-semibold text-foreground">Recovery Bootstrap</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Create, inspect, authenticate, and revoke recovery tokens for manual recovery workflows.
              This tab bootstraps manual recovery environments and can stage downloadable recovery bundles.
            </p>
          </div>
          <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">CLI template</p>
            <p className="mt-1 font-mono text-[11px]">
              breeze-backup bmr-recover --token &lt;token&gt; --server &lt;api-server&gt;
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {tokenMessage && (
        <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
          {tokenMessage}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Create recovery token</h3>
                <p className="text-sm text-muted-foreground">
                  Generate a new token for a specific backup snapshot and recovery profile.
                </p>
              </div>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="recovery-bootstrap-snapshot" className="text-xs font-medium text-muted-foreground">
                  Snapshot
                </label>
                <select
                  id="recovery-bootstrap-snapshot"
                  value={createSnapshotId}
                  onChange={(e) => setCreateSnapshotId(e.target.value)}
                  disabled={loadingSnapshots || snapshots.length === 0}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  {snapshots.length === 0 ? (
                    <option value="">No snapshots available</option>
                  ) : (
                    snapshots.map((snapshot) => (
                      <option key={snapshot.id} value={snapshot.id}>
                        {snapshot.label ?? snapshot.id}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="recovery-bootstrap-restore-type" className="text-xs font-medium text-muted-foreground">
                  Restore type
                </label>
                <select
                  id="recovery-bootstrap-restore-type"
                  value={createRestoreType}
                  onChange={(e) => setCreateRestoreType(e.target.value)}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="bare_metal">Bare metal</option>
                  <option value="full">Full</option>
                  <option value="selective">Selective</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="recovery-bootstrap-expiry" className="text-xs font-medium text-muted-foreground">
                  Expires in hours
                </label>
                <input
                  id="recovery-bootstrap-expiry"
                  type="number"
                  min={1}
                  max={168}
                  value={createExpiresInHours}
                  onChange={(e) => setCreateExpiresInHours(e.target.value)}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>

              <div className="space-y-1.5 md:col-span-2">
                <label htmlFor="recovery-bootstrap-target-config" className="text-xs font-medium text-muted-foreground">
                  Optional target config JSON
                </label>
                <textarea
                  id="recovery-bootstrap-target-config"
                  value={createTargetConfig}
                  onChange={(e) => setCreateTargetConfig(e.target.value)}
                  placeholder='{"targetPaths":[...],"notes":"optional"}'
                  rows={5}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Stored on the token for the recovery agent. Leave blank if you do not need overrides.
                </p>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleCreateToken()}
                disabled={creating || snapshots.length === 0}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create token
              </button>
              <p className="text-xs text-muted-foreground">
                The plaintext token is only returned once, so copy the command immediately after creation.
              </p>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Bootstrap detail</h3>
                <p className="text-sm text-muted-foreground">
                  Shows the exact command, bootstrap data, restore status, and recovery bundle state for the selected token.
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="h-4 w-4 text-success" />
                Authentication preview only, no completion call from this UI
              </div>
            </div>

            {selectedToken ? (
              <div className="mt-4 space-y-4">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <DetailLine label="Token ID" value={<span className="font-mono text-xs">{selectedToken.id}</span>} />
                  <DetailLine label="Status" value={<span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', statusClassName(selectedToken.status))}>{formatStatusLabel(selectedToken.status)}</span>} />
                  <DetailLine label="Session" value={selectedToken.sessionStatus ? formatStatusLabel(selectedToken.sessionStatus) : '-'} />
                  <DetailLine label="Restore type" value={restoreTypeLabel(selectedToken.restoreType)} />
                  <DetailLine label="Snapshot" value={<span className="font-mono text-xs">{selectedToken.snapshotId ?? '-'}</span>} />
                  <DetailLine label="Device" value={<span className="font-mono text-xs">{selectedToken.deviceName ?? selectedToken.deviceId ?? '-'}</span>} />
                  <DetailLine label="Expiry" value={selectedToken.expiresAt ? formatTime(selectedToken.expiresAt) : '-'} />
                  <DetailLine label="Authenticated" value={selectedToken.authenticatedAt ? formatTime(selectedToken.authenticatedAt) : '-'} />
                  <DetailLine label="Completed" value={selectedToken.completedAt ? formatTime(selectedToken.completedAt) : '-'} />
                  <DetailLine label="Used" value={selectedToken.usedAt ? formatTime(selectedToken.usedAt) : '-'} />
                </div>

                <div className="rounded-lg border bg-muted/20 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">Exact CLI command</p>
                      <p className="text-xs text-muted-foreground">
                        Exact when the plaintext token is known in this browser session, otherwise the API-provided template is shown.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedToken.token ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void copyText(buildCliCommand(selectedToken.token!), selectedToken.id)}
                            className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
                          >
                            {copyStatusId === selectedToken.id ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                            {copyStatusId === selectedToken.id ? 'Copied' : 'Copy command'}
                          </button>
                        </>
                      ) : null}
                      {selectedToken.token ? (
                        <button
                          type="button"
                          onClick={() => void handlePreviewBootstrap(selectedToken.id)}
                          disabled={previewingTokenId === selectedToken.id}
                          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
                        >
                          {previewingTokenId === selectedToken.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ClipboardCopy className="h-3.5 w-3.5" />
                          )}
                          Preview bootstrap bundle
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {selectedCommand ? (
                    <pre className="mt-3 overflow-x-auto rounded-md border bg-background p-3 font-mono text-xs text-foreground">
                      {selectedCommand}
                    </pre>
                  ) : (
                    <div className="mt-3 rounded-md border border-dashed bg-background/70 p-3 text-sm text-muted-foreground">
                      Plaintext token unavailable. Load the token in this browser session to show the exact CLI command.
                    </div>
                  )}
                </div>

                <div className="rounded-lg border bg-background/80 p-4">
                  <div className="flex items-center gap-2">
                    <LockKeyhole className="h-4 w-4 text-primary" />
                    <p className="text-sm font-semibold text-foreground">Prerequisites</p>
                  </div>
                  <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                    <li>Use the token before it expires or is revoked.</li>
                    <li>The recovery agent needs network reachability to the API host in the command.</li>
                    <li>The snapshot and device referenced by the token must still exist.</li>
                    <li>Bootstrap preview authenticates the token session and surfaces the recovery bundle data.</li>
                    <li>Recovery bundles include the helper binary and launch script, but the plaintext token is still entered at run time.</li>
                    <li>Target config overrides are optional and only apply when the token stores them.</li>
                  </ul>
                </div>

                <div className="rounded-lg border bg-background/80 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">Recovery bundles</p>
                      <p className="text-xs text-muted-foreground">
                        Build a downloadable helper bundle tied to this token. The token remains one-time and is not embedded in the archive.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        aria-label="Bundle platform"
                        value={bundlePlatform}
                        onChange={(event) => setBundlePlatform(event.target.value)}
                        className="h-9 rounded-md border bg-background px-3 text-xs"
                      >
                        <option value="linux">Linux</option>
                        <option value="darwin">macOS</option>
                        <option value="windows">Windows</option>
                      </select>
                      <select
                        aria-label="Bundle architecture"
                        value={bundleArchitecture}
                        onChange={(event) => setBundleArchitecture(event.target.value)}
                        className="h-9 rounded-md border bg-background px-3 text-xs"
                      >
                        <option value="amd64">amd64</option>
                        <option value="arm64">arm64</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => void handleCreateBundle()}
                        disabled={creatingMedia}
                        className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
                      >
                        {creatingMedia ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                        Create bundle
                      </button>
                    </div>
                  </div>

                  {selectedMedia.length > 0 ? (
                    <div className="mt-3 grid gap-3">
                      {selectedMedia.map((artifact) => (
                        <div key={artifact.id} className="rounded-md border bg-muted/20 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium text-foreground">{artifact.platform} / {artifact.architecture}</p>
                              <p className="text-xs text-muted-foreground">
                                {formatStatusLabel(artifact.status)}
                                {artifact.completedAt ? ` • ${formatTime(artifact.completedAt)}` : ''}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              {artifact.checksumSha256 ? (
                                <button
                                  type="button"
                                  onClick={() => void copyText(artifact.checksumSha256!, `${artifact.id}-checksum`)}
                                  className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                  Copy checksum
                                </button>
                              ) : null}
                              {artifact.signatureDownloadPath ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleDownloadArtifact(
                                      artifact.signatureDownloadPath!,
                                      `${artifact.platform}-${artifact.architecture}-recovery-bundle.tar.gz.minisig`,
                                      'Failed to download recovery bundle signature'
                                    )
                                  }
                                  disabled={loadingMedia}
                                  className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-60"
                                >
                                  <ShieldCheck className="h-3.5 w-3.5" />
                                  Signature
                                </button>
                              ) : null}
                              {artifact.downloadPath ? (
                                <button
                                  type="button"
                                  onClick={() => void handleDownloadBundle(artifact)}
                                  disabled={loadingMedia}
                                  className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-60"
                                >
                                  {loadingMedia ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TerminalSquare className="h-3.5 w-3.5" />}
                                  Download
                                </button>
                              ) : null}
                            </div>
                          </div>
                          {artifact.checksumSha256 ? (
                            <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{artifact.checksumSha256}</p>
                          ) : null}
                          {(artifact.signingKeyId || artifact.signedAt || artifact.status === 'legacy_unsigned') ? (
                            <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                              <p>
                                Signing: {artifact.status === 'legacy_unsigned'
                                  ? 'Unsigned legacy bundle'
                                  : artifact.signatureFormat
                                    ? `${artifact.signatureFormat} via ${artifact.signingKeyId ?? 'unknown key'}`
                                    : 'Pending'}
                              </p>
                              {artifact.signedAt ? <p>Signed at: {formatTime(artifact.signedAt)}</p> : null}
                            </div>
                          ) : null}
                          {renderTrustMetadata(artifact.metadata, [
                            'helperBinaryVersion',
                            'helperBinaryDigestVerified',
                            'helperBinarySourceType',
                            'helperBinarySourceRef',
                            'helperBinaryManifestVersion',
                          ])}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">No recovery bundles have been created for this token yet.</p>
                  )}
                </div>

                <div className="rounded-lg border bg-background/80 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">Bootable recovery media</p>
                      <p className="text-xs text-muted-foreground">
                        Build a signed linux/amd64 recovery ISO from the latest signed recovery bundle.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleCreateBootMedia()}
                      disabled={creatingBootMedia}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
                    >
                      {creatingBootMedia ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                      Create ISO
                    </button>
                  </div>

                  {selectedBootMedia.length > 0 ? (
                    <div className="mt-3 grid gap-3">
                      {selectedBootMedia.map((artifact) => (
                        <div key={artifact.id} className="rounded-md border bg-muted/20 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium text-foreground">
                                {artifact.platform} / {artifact.architecture} / {artifact.mediaType}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {formatStatusLabel(artifact.status)}
                                {artifact.completedAt ? ` • ${formatTime(artifact.completedAt)}` : ''}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              {artifact.checksumSha256 ? (
                                <button
                                  type="button"
                                  onClick={() => void copyText(artifact.checksumSha256!, `${artifact.id}-boot-checksum`)}
                                  className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                  Copy checksum
                                </button>
                              ) : null}
                              {artifact.signatureDownloadPath ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleDownloadArtifact(
                                      artifact.signatureDownloadPath!,
                                      `${artifact.platform}-${artifact.architecture}.${artifact.mediaType}.minisig`,
                                      'Failed to download boot media signature'
                                    )
                                  }
                                  disabled={loadingMedia}
                                  className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-60"
                                >
                                  <ShieldCheck className="h-3.5 w-3.5" />
                                  Signature
                                </button>
                              ) : null}
                              {artifact.downloadPath ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleDownloadArtifact(
                                      artifact.downloadPath!,
                                      `breeze-recovery-${artifact.platform}-${artifact.architecture}.${artifact.mediaType}`,
                                      'Failed to download bootable recovery media'
                                    )
                                  }
                                  disabled={loadingMedia}
                                  className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-60"
                                >
                                  {loadingMedia ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TerminalSquare className="h-3.5 w-3.5" />}
                                  Download ISO
                                </button>
                              ) : null}
                            </div>
                          </div>
                          {artifact.checksumSha256 ? (
                            <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{artifact.checksumSha256}</p>
                          ) : null}
                          {(artifact.signingKeyId || artifact.signedAt) ? (
                            <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                              <p>Signing: {artifact.signatureFormat ?? 'signed'} via {artifact.signingKeyId ?? 'unknown key'}</p>
                              {artifact.signedAt ? <p>Signed at: {formatTime(artifact.signedAt)}</p> : null}
                            </div>
                          ) : null}
                          {renderTrustMetadata(artifact.metadata, [
                            'bootTemplateId',
                            'bootTemplateVersion',
                            'bootTemplateSourceRef',
                            'bootTemplateSha256',
                            'bootTemplateManifestVersion',
                          ])}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">
                      No bootable recovery media has been created for this token yet.
                    </p>
                  )}
                </div>

                <div className="rounded-lg border bg-background/80 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">Linked restore job / result</p>
                      <p className="text-xs text-muted-foreground">Latest restore result linked to this token.</p>
                    </div>
                  </div>
                  {selectedToken.restoreJobId || selectedToken.restoreResult || selectedToken.linkedRestoreJob?.status ? (
                    <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      <DetailLine label="Restore job ID" value={selectedToken.restoreJobId ?? '-'} />
                      <DetailLine label="Restore status" value={selectedToken.linkedRestoreJob?.status ? formatStatusLabel(selectedToken.linkedRestoreJob.status) : '-'} />
                      <DetailLine label="Restored files" value={selectedToken.linkedRestoreJob?.restoredFiles ?? '-'} />
                      <DetailLine label="Restored size" value={selectedToken.linkedRestoreJob?.restoredSize ?? '-'} />
                      <DetailLine label="Completed" value={selectedToken.linkedRestoreJob?.completedAt ? formatTime(selectedToken.linkedRestoreJob.completedAt) : '-'} />
                      <DetailLine label="Restore result" value={<pre className="whitespace-pre-wrap break-words text-xs text-foreground">{renderJson(selectedToken.restoreResult)}</pre>} />
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">No linked restore job or result has been loaded for this token yet.</p>
                  )}
                </div>

                {selectedBootstrap && (selectedBootstrap.providerType || selectedBootstrap.backupConfig || selectedBootstrap.download || selectedBootstrap.snapshot) && (
                  <div className="rounded-lg border bg-muted/20 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-foreground">Bootstrap bundle</p>
                        <p className="text-xs text-muted-foreground">
                          This is the recovery bootstrap payload returned by the API authenticate endpoint.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void copyText(renderJson(selectedBootstrap), `${selectedToken.id}-bootstrap`)}
                        className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
                      >
                        {copyStatusId === `${selectedToken.id}-bootstrap` ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        {copyStatusId === `${selectedToken.id}-bootstrap` ? 'Copied' : 'Copy bundle JSON'}
                      </button>
                    </div>

                    <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      <DetailLine label="Provider type" value={selectedBootstrap.providerType ?? '-'} />
                      <DetailLine label="Target config" value={<pre className="whitespace-pre-wrap break-words text-xs">{renderJson(selectedBootstrap.targetConfig)}</pre>} />
                      <DetailLine label="Backup config" value={selectedBootstrap.backupConfig?.name ?? selectedBootstrap.backupConfig?.id ?? '-'} />
                      <DetailLine label="Snapshot label" value={selectedBootstrap.snapshot?.label ?? selectedBootstrap.snapshot?.id ?? '-'} />
                      <DetailLine label="Snapshot time" value={selectedBootstrap.snapshot?.timestamp ? formatTime(selectedBootstrap.snapshot.timestamp) : '-'} />
                      <DetailLine label="Download mode" value={selectedBootstrap.download?.type ?? '-'} />
                      <DetailLine label="Download scope" value={selectedBootstrap.download?.pathPrefix ?? '-'} />
                      <DetailLine label="Access expires" value={selectedBootstrap.download?.expiresAt ? formatTime(selectedBootstrap.download.expiresAt) : 'Requires re-authentication'} />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-4 rounded-md border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
                Create or load a recovery token to inspect the exact CLI command and bootstrap details.
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Load token by ID</h3>
                  <p className="text-sm text-muted-foreground">
                    Look up an existing token to refresh its server-side metadata and bring it into the current view.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleLoadToken()}
                  disabled={refreshingTokenId !== null && loadTokenId.trim() === refreshingTokenId}
                  className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-60"
                >
                  {refreshingTokenId ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                  Load
                </button>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="recovery-bootstrap-load-id" className="text-xs font-medium text-muted-foreground">
                  Token ID
                </label>
                <input
                  id="recovery-bootstrap-load-id"
                  value={loadTokenId}
                  onChange={(e) => setLoadTokenId(e.target.value)}
                  placeholder="rec-..."
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm font-mono"
                />
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Filter catalog</h3>
                <p className="text-sm text-muted-foreground">
                  Filter the recovery token catalog by status, restore type, or search text.
                </p>
              </div>
              <div className="text-sm text-muted-foreground">
                {filteredTokens.length} of {catalog.length}
              </div>
            </div>

            <div className="mt-4 grid gap-3">
              <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
                <Search className="h-4 w-4 text-muted-foreground" />
                <label htmlFor="recovery-bootstrap-search" className="sr-only">
                  Search tokens
                </label>
                <input
                  id="recovery-bootstrap-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search token, snapshot, device..."
                  className="w-full bg-transparent outline-none"
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
                  <Filter className="h-4 w-4 text-muted-foreground" />
                  <label htmlFor="recovery-bootstrap-status" className="sr-only">
                    Filter by status
                  </label>
                  <select
                    id="recovery-bootstrap-status"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as TokenStatusFilter)}
                    className="w-full bg-transparent outline-none"
                  >
                    <option value="all">All statuses</option>
                    <option value="active">Active</option>
                    <option value="revoked">Revoked</option>
                    <option value="expired">Expired</option>
                    <option value="used">Used</option>
                    <option value="completed">Completed</option>
                  </select>
                </div>

                <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
                  <Filter className="h-4 w-4 text-muted-foreground" />
                  <label htmlFor="recovery-bootstrap-type" className="sr-only">
                    Filter by restore type
                  </label>
                  <select
                    id="recovery-bootstrap-type"
                    value={restoreTypeFilter}
                    onChange={(e) => setRestoreTypeFilter(e.target.value as RestoreTypeFilter)}
                    className="w-full bg-transparent outline-none"
                  >
                    <option value="all">All restore types</option>
                    <option value="bare_metal">Bare metal</option>
                    <option value="full">Full</option>
                    <option value="selective">Selective</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-foreground">Token catalog</h3>
              <div className="text-xs text-muted-foreground">
                {catalog.length === 0 ? 'No recovery tokens found' : `${catalog.length} token${catalog.length === 1 ? '' : 's'} loaded`}
              </div>
            </div>

            {filteredTokens.length === 0 ? (
              <div className="mt-4 rounded-md border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
                No recovery tokens match the current filters.
              </div>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="pb-2 pr-4 font-medium">Token</th>
                      <th className="pb-2 pr-4 font-medium">Status</th>
                      <th className="pb-2 pr-4 font-medium">Type</th>
                      <th className="pb-2 pr-4 font-medium">Snapshot</th>
                      <th className="pb-2 pr-4 font-medium">Expires</th>
                      <th className="pb-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTokens.map((token) => {
                      const active = token.id === selectedTokenId;
                      const canPreview = Boolean(token.token);
                      return (
                        <tr
                          key={token.id}
                          className={cn('border-b last:border-0 transition-colors', active && 'bg-primary/5')}
                          onClick={() => setSelectedTokenId(token.id)}
                        >
                          <td className="py-3 pr-4">
                            <div className="space-y-1">
                              <p className="font-mono text-xs text-foreground">{token.id}</p>
                              <p className="text-xs text-muted-foreground">
                                {token.deviceId ?? '-'}
                              </p>
                            </div>
                          </td>
                          <td className="py-3 pr-4">
                            <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', statusClassName(token.status))}>
                              {formatStatusLabel(token.status)}
                            </span>
                          </td>
                          <td className="py-3 pr-4 text-muted-foreground">
                            {restoreTypeLabel(token.restoreType)}
                          </td>
                          <td className="py-3 pr-4 text-muted-foreground">
                            <div className="space-y-1">
                              <p className="font-mono text-xs text-foreground">{token.snapshotId ?? '-'}</p>
                              <p className="text-[11px]">{token.createdAt ? formatTime(token.createdAt) : '-'}</p>
                            </div>
                          </td>
                          <td className="py-3 pr-4 text-muted-foreground">
                            {token.expiresAt ? formatTime(token.expiresAt) : '-'}
                          </td>
                          <td className="py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedTokenId(token.id);
                                }}
                                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                              >
                                <Server className="h-3.5 w-3.5" />
                                View
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleRefreshToken(token.id);
                                }}
                                disabled={refreshingTokenId === token.id}
                                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                              >
                                {refreshingTokenId === token.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-3.5 w-3.5" />
                                )}
                                Refresh
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handlePreviewBootstrap(token.id);
                                }}
                                disabled={!canPreview || previewingTokenId === token.id}
                                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                                title={canPreview ? 'Preview bootstrap bundle' : 'Plaintext token unavailable'}
                              >
                                {previewingTokenId === token.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <ClipboardCopy className="h-3.5 w-3.5" />
                                )}
                                Preview
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleRevoke(token.id);
                                }}
                                disabled={token.status === 'revoked'}
                                className="inline-flex items-center gap-1 rounded-md border border-destructive/30 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-60"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                Revoke
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border/70 bg-muted/10 p-4 text-sm text-muted-foreground">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">Plaintext token handling</p>
            <p>
              The server never re-shows the plaintext token. This tab preserves it only while you keep the freshly created token in the current browser session, so copy the exact command immediately after creation.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
