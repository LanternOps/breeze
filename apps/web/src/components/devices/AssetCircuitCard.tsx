import { useCallback, useEffect, useRef, useState } from 'react';
import { Cable } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';
import { usePermissions } from '../../lib/permissions';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

type TerminationState = 'assigned' | 'unassigned' | 'needs_reassociation';

type CircuitView = {
  id: string;
  providerName: string;
  cid: string;
  bandwidthBps: number | null;
  serviceType: string | null;
  administrativeStatus: string;
  terminationState: TerminationState;
  termination: null | {
    interfaceId: string;
    interfaceName: string | null;
    asset: { kind: string; id: string; label: string } | null;
    primarySite: { id: string; name: string };
  };
  additionalServedSites: { id: string; name: string }[];
};

type InterfaceView = {
  id: string;
  name: string | null;
  kind: string | null;
  role: string | null;
  retired: boolean;
  circuitId: string | null;
};

type CircuitsResponse = {
  capabilities: { interfacesVisible: boolean; wanRoleWritable: boolean };
  interfaces: InterfaceView[];
  interfacesTruncated: boolean;
  circuits: CircuitView[];
};

type RoleResponse = { id: string; role: 'wan' | null };

type AssetCircuitCardProps = { subject: 'device' | 'discovered'; id: string };

const DASH = '—';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStrOrNull = (v: unknown) => v === null || typeof v === 'string';

function isCircuit(v: unknown): v is CircuitView {
  if (!isObj(v)) return false;
  if (typeof v.id !== 'string' || typeof v.providerName !== 'string' || typeof v.cid !== 'string') return false;
  if (typeof v.administrativeStatus !== 'string') return false;
  if (v.bandwidthBps !== null && typeof v.bandwidthBps !== 'number') return false;
  if (!isStrOrNull(v.serviceType)) return false;
  if (v.terminationState !== 'assigned' && v.terminationState !== 'unassigned' && v.terminationState !== 'needs_reassociation') return false;
  if (!Array.isArray(v.additionalServedSites)) return false;
  if (!v.additionalServedSites.every((s) => isObj(s) && typeof s.id === 'string' && typeof s.name === 'string')) return false;
  if (v.terminationState === 'assigned') {
    const term = v.termination;
    if (!isObj(term) || !isObj(term.primarySite) || typeof term.primarySite.name !== 'string') return false;
    if (!isStrOrNull(term.interfaceName)) return false;
    if (term.asset !== null && !(isObj(term.asset) && typeof term.asset.label === 'string')) return false;
  }
  return true;
}

function isInterface(v: unknown): v is InterfaceView {
  return (
    isObj(v) &&
    typeof v.id === 'string' &&
    isStrOrNull(v.name) &&
    isStrOrNull(v.kind) &&
    isStrOrNull(v.role) &&
    typeof v.retired === 'boolean'
  );
}

function isCircuitsResponse(v: unknown): v is CircuitsResponse {
  if (!isObj(v)) return false;
  const { capabilities, interfaces, interfacesTruncated, circuits } = v;
  if (!isObj(capabilities)) return false;
  if (typeof capabilities.interfacesVisible !== 'boolean' || typeof capabilities.wanRoleWritable !== 'boolean') return false;
  if (typeof interfacesTruncated !== 'boolean') return false;
  if (!Array.isArray(interfaces) || !interfaces.every(isInterface)) return false;
  return Array.isArray(circuits) && circuits.every(isCircuit);
}

function isRoleResponse(v: unknown): v is RoleResponse {
  return isObj(v) && typeof v.id === 'string' && (v.role === 'wan' || v.role === null);
}

function formatBandwidth(bps: number): string {
  if (bps >= 1e9) return `${Number((bps / 1e9).toFixed(2))} Gbps`;
  return `${Number((bps / 1e6).toFixed(2))} Mbps`;
}

export default function AssetCircuitCard({ subject, id }: AssetCircuitCardProps) {
  const { t } = useTranslation('devices');
  const { can } = usePermissions();
  const canWrite = can('devices', 'write');
  const base = subject === 'device' ? `/devices/${id}/circuits` : `/discovery/assets/${id}/circuits`;

  const [data, setData] = useState<CircuitsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState<InterfaceView | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchWithAuth(base);
      if (!mountedRef.current) return;
      if (res.ok) {
        const json: unknown = await res.json();
        if (!mountedRef.current) return;
        setData(isCircuitsResponse(json) ? json : null);
      } else {
        setData(null);
      }
    } catch {
      if (mountedRef.current) setData(null);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    setData(null);
    setConfirmClear(null);
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const friendly = (code: string): string | undefined => {
    switch (code) {
      case 'MFA_REQUIRED': return t('assetCircuitCard.toasts.mfaRequired');
      case 'WAN_HAS_TERMINATION': return t('assetCircuitCard.toasts.hasTermination');
      case 'INTERFACE_RETIRED': return t('assetCircuitCard.toasts.retired');
      case 'INTERFACE_NOT_FOUND': return t('assetCircuitCard.toasts.notFound');
      case 'topology_permission_denied': return t('assetCircuitCard.toasts.permissionDenied');
      default: return undefined;
    }
  };

  const setRole = async (iface: InterfaceView, role: 'wan' | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction<RoleResponse>({
        request: () =>
          fetchWithAuth(`/topology/interfaces/${iface.id}/role`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role }),
          }),
        errorFallback: t('assetCircuitCard.toasts.failed'),
        parseSuccess: (json) => {
          if (!isRoleResponse(json)) throw new Error('Malformed interface role response');
          return json;
        },
        successMessage: role ? t('assetCircuitCard.toasts.marked') : t('assetCircuitCard.toasts.unmarked'),
        friendly,
        onUnauthorized: UNAUTHORIZED,
      });
      await load();
    } catch (err) {
      handleActionError(err, t('assetCircuitCard.toasts.failed'));
      // The view may be stale (interface retired or termination changed): re-read.
      if (err instanceof ActionError && (err.status === 409 || err.status === 422 || err.status === 404)) {
        await load();
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const header = (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Cable className="h-4 w-4" aria-hidden="true" />
      {t('assetCircuitCard.title')}
    </div>
  );

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-4 shadow-xs animate-pulse" data-testid="asset-circuit-card-loading">
        <div className="h-4 w-32 rounded bg-muted" />
        <div className="mt-3 h-6 w-48 rounded bg-muted" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="asset-circuit-card">
        {header}
        <p className="mt-2 text-sm text-muted-foreground">
          {t('assetCircuitCard.loadFailed')}{' '}
          <button
            type="button"
            onClick={() => { setLoading(true); void load(); }}
            className="font-medium text-primary hover:underline"
          >
            {t('common:actions.retry')}
          </button>
        </p>
      </div>
    );
  }

  const { capabilities, interfaces, circuits } = data;
  const showInterfaces = capabilities.interfacesVisible;
  const hasWan = interfaces.some((i) => i.role === 'wan');
  const empty = circuits.length === 0 && (!showInterfaces || !hasWan);

  const dd = (value: string | null, testId: string) => (
    <dd
      className="text-sm font-medium"
      data-testid={testId}
      aria-label={value === null ? t('common:states.unknown') : undefined}
    >
      {value ?? DASH}
    </dd>
  );

  const statusLabel = (s: string): string => {
    switch (s) {
      case 'active': return t('assetCircuitCard.status.active');
      case 'planned': return t('assetCircuitCard.status.planned');
      case 'suspended': return t('assetCircuitCard.status.suspended');
      case 'disconnected': return t('assetCircuitCard.status.disconnected');
      default: return s;
    }
  };

  return (
    <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="asset-circuit-card">
      {header}

      {empty && (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="asset-circuit-empty">
          {t('assetCircuitCard.empty')}
        </p>
      )}

      {circuits.map((c) => {
        const term = c.terminationState === 'assigned' ? c.termination : null;
        return (
          <div key={c.id} className="mt-3 rounded-md border p-3" data-testid={`asset-circuit-${c.id}`}>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">{t('assetCircuitCard.provider')}</dt>
                {dd(c.providerName || null, 'asset-circuit-provider')}
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('assetCircuitCard.cid')}</dt>
                {dd(c.cid || null, 'asset-circuit-cid')}
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('assetCircuitCard.bandwidth')}</dt>
                {dd(c.bandwidthBps != null ? formatBandwidth(c.bandwidthBps) : null, 'asset-circuit-bandwidth')}
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('assetCircuitCard.serviceType')}</dt>
                {dd(c.serviceType || null, 'asset-circuit-service-type')}
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('assetCircuitCard.administrativeStatus')}</dt>
                {dd(statusLabel(c.administrativeStatus), 'asset-circuit-status')}
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('assetCircuitCard.sitesServed')}</dt>
                {dd(
                  c.additionalServedSites.length > 0 ? c.additionalServedSites.map((s) => s.name).join(', ') : null,
                  'asset-circuit-sites',
                )}
              </div>
            </dl>
            <p className="mt-3 text-sm" data-testid="asset-circuit-termination">
              {term
                ? term.asset || term.interfaceName
                  ? t('assetCircuitCard.terminationSite', {
                      site: term.primarySite.name,
                      asset: term.asset?.label ?? DASH,
                      iface: term.interfaceName ?? DASH,
                    })
                  : t('assetCircuitCard.terminationSiteBare', { site: term.primarySite.name })
                : c.terminationState === 'unassigned'
                  ? t('assetCircuitCard.terminationUnassigned')
                  : t('assetCircuitCard.terminationNeedsReassociation')}
            </p>
          </div>
        );
      })}

      {showInterfaces && (
        <div className="mt-3" data-testid="asset-circuit-interfaces">
          <h4 className="text-xs font-medium text-muted-foreground">{t('assetCircuitCard.interfaces')}</h4>
          {interfaces.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">{t('assetCircuitCard.noInterfaces')}</p>
          ) : (
            <ul className="mt-1 divide-y">
              {interfaces.map((i) => (
                <li key={i.id} className="flex items-center gap-2 py-1.5 text-sm" data-testid={`asset-circuit-iface-${i.id}`}>
                  {i.name ? (
                    <span className="font-medium">{i.name}</span>
                  ) : (
                    <span className="font-medium" aria-label={t('common:states.unknown')}>{i.kind ?? DASH}</span>
                  )}
                  {i.role === 'wan' && (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary" data-testid="asset-circuit-wan-badge">
                      {t('assetCircuitCard.wanBadge')}
                    </span>
                  )}
                  {i.retired && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {t('assetCircuitCard.retiredBadge')}
                    </span>
                  )}
                  {capabilities.wanRoleWritable && canWrite && !i.retired && (
                    <button
                      type="button"
                      data-testid={`asset-circuit-toggle-${i.id}`}
                      disabled={busy}
                      onClick={() => (i.role === 'wan' ? setConfirmClear(i) : void setRole(i, 'wan'))}
                      className="ml-auto text-sm font-medium text-primary hover:underline disabled:opacity-50"
                    >
                      {i.role === 'wan' ? t('assetCircuitCard.unmarkWan') : t('assetCircuitCard.markWan')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {data.interfacesTruncated && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="asset-circuit-truncated">
              {t('assetCircuitCard.truncated')}
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmClear !== null}
        onClose={() => setConfirmClear(null)}
        onConfirm={() => {
          const target = confirmClear;
          setConfirmClear(null);
          if (target) void setRole(target, null);
        }}
        isLoading={busy}
        title={t('assetCircuitCard.unmarkConfirm.title')}
        message={t('assetCircuitCard.unmarkConfirm.message', {
          name: confirmClear?.name || confirmClear?.kind || t('common:states.unknown'),
        })}
        confirmLabel={t('assetCircuitCard.unmarkWan')}
        confirmTestId="asset-circuit-unmark-confirm"
      />
    </div>
  );
}
