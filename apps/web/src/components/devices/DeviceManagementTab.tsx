import { useCallback, useEffect, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  Clock,
  Globe,
  Loader2,
  Monitor,
  RefreshCw,
  Server,
  Shield,
  ShieldCheck,
  Wifi,
} from 'lucide-react';

import { friendlyFetchError } from '../../lib/utils';
import { fetchWithAuth } from '../../stores/auth';

// ── Types ────────────────────────────────────────────────────────────

type DetectionStatus = 'active' | 'installed' | 'unknown';

type Detection = {
  name: string;
  version?: string;
  status: DetectionStatus;
  serviceName?: string;
  details?: Record<string, unknown>;
};

type JoinType = 'hybrid_azure_ad' | 'azure_ad' | 'on_prem_ad' | 'workplace' | 'none';

type IdentityStatus = {
  joinType: JoinType;
  azureAdJoined: boolean;
  domainJoined: boolean;
  workplaceJoined: boolean;
  domainName?: string;
  tenantId?: string;
  mdmUrl?: string;
  source: string;
};

type CategoryKey =
  | 'mdm'
  | 'rmm'
  | 'remoteAccess'
  | 'endpointSecurity'
  | 'policyEngine'
  | 'backup'
  | 'identityMfa'
  | 'siem'
  | 'dnsFiltering'
  | 'zeroTrustVpn'
  | 'patchManagement';

type ManagementPosture = {
  collectedAt: string;
  scanDurationMs: number;
  categories: Partial<Record<CategoryKey, Detection[]>>;
  identity: IdentityStatus;
  errors?: string[];
};

type PostureResponse = {
  deviceId: string;
  hostname: string;
  posture: ManagementPosture | null;
  collected: boolean;
};

// ── Constants ────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<CategoryKey, string> = {
  mdm: 'MDM',
  rmm: 'RMM',
  remoteAccess: 'Remote Access',
  endpointSecurity: 'Endpoint Security',
  policyEngine: 'Policy Engine',
  backup: 'Backup',
  identityMfa: 'Identity / MFA',
  siem: 'SIEM',
  dnsFiltering: 'DNS Filtering',
  zeroTrustVpn: 'Zero Trust / VPN',
  patchManagement: 'Patch Management',
};

const CATEGORY_ORDER: CategoryKey[] = [
  'mdm',
  'endpointSecurity',
  'rmm',
  'policyEngine',
  'identityMfa',
  'zeroTrustVpn',
  'remoteAccess',
  'backup',
  'siem',
  'dnsFiltering',
  'patchManagement',
];

const JOIN_TYPE_LABELS: Record<JoinType, string> = {
  hybrid_azure_ad: 'Hybrid Azure AD (Entra ID + On-Prem AD)',
  azure_ad: 'Azure AD (Entra ID)',
  on_prem_ad: 'On-Premises Active Directory',
  workplace: 'Workplace Join',
  none: 'Not Joined',
};

const STATUS_BADGE: Record<DetectionStatus, string> = {
  active: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40',
  installed: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
  unknown: 'bg-gray-500/20 text-gray-600 border-gray-500/30',
};

// ── Helpers ──────────────────────────────────────────────────────────

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function BoolFlag({ label, value }: { label: string; value: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {value ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
      ) : (
        <span className="h-4 w-4 rounded-full border-2 border-muted-foreground/30" />
      )}
      <span className={value ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────

type DeviceManagementTabProps = {
  deviceId: string;
};

export default function DeviceManagementTab({ deviceId }: DeviceManagementTabProps) {
  const [data, setData] = useState<PostureResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchPosture = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/management-posture`);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      setData(await response.json());
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchPosture();
  }, [fetchPosture]);

  // ── Loading state ──────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading management posture...</p>
        </div>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchPosture}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  // ── Empty / not collected ──────────────────────────────────────────

  if (!data?.collected || !data.posture) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center shadow-sm">
        <Monitor className="mx-auto h-10 w-10 text-muted-foreground/50" />
        <h3 className="mt-4 font-semibold">No Management Data</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          The agent hasn't reported management posture for this device yet.
          Data is collected automatically during heartbeat cycles.
        </p>
      </div>
    );
  }

  const { posture } = data;
  const { identity, categories } = posture;

  // Build ordered list of categories that have detections
  const populatedCategories = CATEGORY_ORDER.filter(
    (key) => categories[key] && categories[key]!.length > 0
  );

  const totalDetections = populatedCategories.reduce(
    (sum, key) => sum + (categories[key]?.length ?? 0),
    0
  );

  return (
    <div className="space-y-6">
      {/* ── Identity / Directory Status ───────────────────────────── */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 mb-4">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-semibold">Identity &amp; Directory Status</h3>
          </div>
          <button
            type="button"
            onClick={fetchPosture}
            className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>

        <div className="rounded-md border bg-background p-4">
          <div className="flex items-center gap-2 mb-3">
            <Globe className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{JOIN_TYPE_LABELS[identity.joinType]}</span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2">
              <BoolFlag label="Azure AD / Entra ID Joined" value={identity.azureAdJoined} />
              <BoolFlag label="Domain Joined" value={identity.domainJoined} />
              <BoolFlag label="Workplace Joined" value={identity.workplaceJoined} />
            </div>

            <div className="space-y-1.5 text-sm">
              {identity.domainName && (
                <div>
                  <span className="text-muted-foreground">Domain: </span>
                  <span className="font-medium">{identity.domainName}</span>
                </div>
              )}
              {identity.tenantId && (
                <div>
                  <span className="text-muted-foreground">Tenant ID: </span>
                  <span className="font-mono text-xs">{identity.tenantId}</span>
                </div>
              )}
              {identity.mdmUrl && (
                <div>
                  <span className="text-muted-foreground">MDM Enrollment: </span>
                  <span className="font-mono text-xs break-all">{identity.mdmUrl}</span>
                </div>
              )}
            </div>

            <div className="text-sm">
              <span className="text-muted-foreground">Detection source: </span>
              <span className="font-medium">{identity.source}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Detected Management Tools ─────────────────────────────── */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold">Detected Management Tools</h3>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          {totalDetections} tool{totalDetections !== 1 ? 's' : ''} detected across{' '}
          {populatedCategories.length} categor{populatedCategories.length !== 1 ? 'ies' : 'y'}
        </p>

        {populatedCategories.length === 0 ? (
          <p className="text-sm text-muted-foreground">No management tools detected on this device.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {populatedCategories.map((catKey) => {
              const detections = categories[catKey]!;
              return (
                <div key={catKey} className="rounded-md border bg-background p-4">
                  <h4 className="text-sm font-semibold mb-3">{CATEGORY_LABELS[catKey]}</h4>
                  <div className="space-y-2">
                    {detections.map((det) => (
                      <div key={det.name} className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate" title={det.name}>
                            {det.name}
                          </p>
                          {det.version && (
                            <p className="text-xs text-muted-foreground">v{det.version}</p>
                          )}
                        </div>
                        <span
                          className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-semibold capitalize ${STATUS_BADGE[det.status]}`}
                        >
                          {det.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Scan Errors ───────────────────────────────────────────── */}
      {posture.errors && posture.errors.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <h4 className="text-sm font-semibold text-amber-800 mb-2">Scan Warnings</h4>
          <ul className="list-disc list-inside space-y-1">
            {posture.errors.map((err) => (
              <li key={err} className="text-xs text-amber-700">
                {err}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Metadata footer ───────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          Last scanned: {formatDateTime(posture.collectedAt)}
        </span>
        <span>Scan duration: {posture.scanDurationMs}ms</span>
      </div>
    </div>
  );
}
