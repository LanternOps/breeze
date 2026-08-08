import { useEffect, useState } from 'react';
import { Globe, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DiscoveredAsset, OpenPortEntry, DiscoveredAssetType } from './DiscoveredAssetList';
import { typeConfig, approvalStatusConfig } from './DiscoveredAssetList';
import AssetMonitoringSection from './AssetMonitoringSection';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { extractApiError } from '../../lib/apiError';
import { formatDateTime } from '@/lib/dateTimeFormat';
import type { DiscoveredAssetLinkSource } from './networkTypes';
import { formatNumber } from '@/lib/i18n/format';

export type AssetDetail = DiscoveredAsset & {
  openPorts?: OpenPortEntry[];
  osFingerprint?: string;
  snmpData?: Record<string, string>;
  linkedDeviceId?: string | null;
  linkSource?: DiscoveredAssetLinkSource | null;
  label?: string | null;
  notes?: string | null;
  tags?: string[];
};

// Friendly labels for the scalar SNMP system OIDs the discovery scan collects.
const SNMP_FIELD_LABEL_KEYS: Record<string, string> = {
  sysName: 'assetDetailModal.snmpFields.systemName',
  sysDescr: 'common:labels.description',
  sysObjectId: 'assetDetailModal.snmpFields.objectId'
};

function snmpFieldLabel(key: string, t: (key: string) => string): string {
  return SNMP_FIELD_LABEL_KEYS[key] ? t(/* i18n-dynamic */ SNMP_FIELD_LABEL_KEYS[key]) : key;
}

type AssetDetailModalProps = {
  open: boolean;
  asset?: AssetDetail | null;
  /** While the detail is being fetched (topology click / deep link). */
  loading?: boolean;
  onClose: () => void;
  onDeleted?: (assetId: string) => void;
  onUpdated?: (assetId: string) => void;
};

export default function AssetDetailModal({
  open,
  asset,
  loading = false,
  onClose,
  onDeleted,
  onUpdated
}: AssetDetailModalProps) {
  const { t } = useTranslation('discovery');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [editLabel, setEditLabel] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editType, setEditType] = useState<DiscoveredAssetType>(asset?.type ?? 'unknown');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    setDeleteError(undefined);
    setEditLabel(asset?.label ?? '');
    setEditNotes(asset?.notes ?? '');
    setEditTags(asset?.tags?.join(', ') ?? '');
    setEditType(asset?.type ?? 'unknown');
    setSaveError(undefined);
    setSaveSuccess(false);
  }, [asset]);

  const handleDelete = async () => {
    if (!asset) return;
    const name = asset.hostname || asset.ip;
    if (!confirm(t('assetDetailModal.confirmDelete', { name }))) {
      return;
    }

    try {
      setDeleting(true);
      setDeleteError(undefined);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(t('assetDetailModal.errors.delete'));
      }

      onDeleted?.(asset.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('assetDetailModal.errors.generic'));
    } finally {
      setDeleting(false);
    }
  };

  const handleSaveInfo = async () => {
    if (!asset) return;
    try {
      setSaving(true);
      setSaveError(undefined);
      setSaveSuccess(false);
      const tags = editTags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          label: editLabel || null,
          notes: editNotes || null,
          tags,
          ...(editType !== asset.type ? { assetType: editType } : {})
        })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(extractApiError(body, t('assetDetailModal.errors.saveInfo')));
      }
      setSaveSuccess(true);
      onUpdated?.(asset.id);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('assetDetailModal.errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  const handleResetType = async () => {
    if (!asset) return;
    try {
      setSaving(true);
      setSaveError(undefined);
      setSaveSuccess(false);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ resetTypeToAuto: true })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(extractApiError(body, t('assetDetailModal.errors.resetType')));
      }
      setSaveSuccess(true);
      onUpdated?.(asset.id);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('assetDetailModal.errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  // No asset record yet: never render nothing while open, or a node click looks
  // like it did nothing. Show a loading state, then a graceful not-found state
  // with a retry path (#1728).
  if (!asset) {
    if (!open) return null;
    return (
      <Dialog open={open} onClose={onClose} title={t('assetDetailModal.deviceDetailsTitle')} maxWidth="md">
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
          {loading ? (
            <>
              <div className="h-7 w-7 animate-spin rounded-full border-[3px] border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">{t('assetDetailModal.loadingDetails')}</p>
            </>
          ) : (
            <>
              <Globe className="h-7 w-7 text-muted-foreground/60" aria-hidden />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{t('assetDetailModal.detailsUnavailableTitle')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('assetDetailModal.detailsUnavailableDescription')}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="mt-1 rounded-md border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted"
              >
                {t('common:actions.close')}
              </button>
            </>
          )}
        </div>
      </Dialog>
    );
  }

  const openPorts = asset.openPorts ?? [];
  const osFingerprint = asset.osFingerprint ?? '—';
  const snmpData = asset.snmpData ?? {};

  return (
    <Dialog open={open} onClose={onClose} title={asset.label || asset.hostname || asset.ip} maxWidth="5xl" alignTop className="flex flex-col max-h-[calc(100vh-4rem)]">
        <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{asset.label || asset.hostname || asset.ip}</h2>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${typeConfig[asset.type].color}`}>
                {t(/* i18n-dynamic */ typeConfig[asset.type].labelKey)}
              </span>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${approvalStatusConfig[asset.approvalStatus].color}`}>
                {t(/* i18n-dynamic */ approvalStatusConfig[asset.approvalStatus].labelKey)}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {asset.ip}{asset.mac !== '—' && <> • {asset.mac}</>}
              {asset.manufacturer !== '—' && <> • {asset.manufacturer}</>}
              {asset.lastSeen && <> • {t('assetDetailModal.lastSeen', { time: formatDateTime(asset.lastSeen) })}</>}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {t('common:actions.close')}
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-5">
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Left column — Network & Discovery */}
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('assetDetailModal.networkDetailsTitle')}</h3>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">{t('assetDetailModal.fields.ping')}</dt>
                  <dd className="font-mono font-medium">
                    {asset.responseTimeMs != null
                      ? asset.responseTimeMs < 1
                        ? '<1 ms'
                        : `${formatNumber(asset.responseTimeMs, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ms`
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('assetDetailModal.fields.osFingerprint')}</dt>
                  <dd className="font-medium truncate">{osFingerprint}</dd>
                </div>
              </dl>
              {openPorts.length > 0 && (
                <div className="mt-3 border-t pt-3">
                  <p className="text-xs font-medium text-muted-foreground">{t('assetDetailModal.openPorts')}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {openPorts.map((p) => (
                      <span
                        key={p.port}
                        className="rounded-full border border-muted bg-background px-2 py-0.5 text-xs"
                      >
                        {p.port}{p.service ? ` (${p.service})` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {openPorts.length === 0 && (
                <p className="mt-3 text-xs text-muted-foreground">{t('assetDetailModal.noOpenPorts')}</p>
              )}
            </div>

            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('assetDetailModal.snmpDataTitle')}</h3>
              <dl className="mt-3 space-y-2 text-sm">
                {Object.keys(snmpData).length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    {t('assetDetailModal.noSnmpData')}
                  </div>
                ) : (
                  Object.entries(snmpData).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">{snmpFieldLabel(key, t)}</dt>
                      <dd className="font-medium text-right break-all">{value}</dd>
                    </div>
                  ))
                )}
              </dl>
            </div>

            <AssetMonitoringSection assetId={asset.id} ipAddress={asset.ip} open={open} />
          </div>

          {/* Right column — Asset Management */}
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('assetDetailModal.assetInfoTitle')}</h3>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('assetDetailModal.fields.displayName')}</label>
                  <input
                    type="text"
                    value={editLabel}
                    onChange={e => setEditLabel(e.target.value)}
                    placeholder={t('assetDetailModal.placeholders.displayName')}
                    maxLength={255}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('assetDetailModal.fields.assetType')}</label>
                  <div className="mt-1 flex items-center gap-2">
                    <select
                      data-testid="asset-modal-type-select"
                      className="rounded-md border bg-background px-2 py-1 text-sm"
                      value={editType}
                      onChange={(e) => setEditType(e.target.value as DiscoveredAssetType)}
                    >
                      {(Object.keys(typeConfig) as DiscoveredAssetType[]).map((assetType) => (
                        <option key={assetType} value={assetType}>{t(/* i18n-dynamic */ typeConfig[assetType].labelKey)}</option>
                      ))}
                    </select>
                    {asset.typeSource === 'manual' && (
                      <button
                        type="button"
                        data-testid="asset-modal-type-reset"
                        className="text-xs text-muted-foreground underline hover:text-foreground"
                        onClick={() => void handleResetType()}
                      >
                        {t('assetDetailModal.actions.resetType')}
                      </button>
                    )}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('assetDetailModal.fields.notesDescription')}</label>
                  <textarea
                    value={editNotes}
                    onChange={e => setEditNotes(e.target.value)}
                    placeholder={t('assetDetailModal.placeholders.notes')}
                    rows={2}
                    className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring resize-none"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('assetDetailModal.fields.tags')}</label>
                  <input
                    type="text"
                    value={editTags}
                    onChange={e => setEditTags(e.target.value)}
                    placeholder={t('assetDetailModal.placeholders.tags')}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSaveInfo}
                    disabled={saving}
                    className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-70"
                  >
                    {saving ? t('common:states.saving') : t('common:actions.save')}
                  </button>
                  {saveSuccess && (
                    <span className="text-xs text-success">{t('common:states.saved')}</span>
                  )}
                </div>
                {saveError && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {saveError}
                  </div>
                )}
              </div>
            </div>

            {asset.linkedDeviceId && (
              <div className="rounded-md border bg-muted/30 px-4 py-3">
                <a
                  href={`/devices/${asset.linkedDeviceId}`}
                  data-testid="asset-modal-same-device-link"
                  className="text-sm text-primary hover:underline"
                >
                  {t('assetDetailModal.sameDeviceAs', {
                    name: asset.linkedDeviceName || t('common:states.unknown')
                  })}
                </a>
              </div>
            )}

            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Globe className="h-4 w-4" />
                {t('assetDetailModal.proxy.title')}
              </h3>
              <a
                href={`/devices/network/${asset.id}`}
                data-testid="asset-modal-proxy-link"
                className="mt-2 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                {t('assetDetailModal.proxy.manageOnDevicePage')}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>

            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-3">
              <p className="text-xs text-muted-foreground">{t('assetDetailModal.deleteDescription')}</p>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="h-8 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deleting ? t('assetDetailModal.actions.deleting') : t('assetDetailModal.actions.deleteAsset')}
              </button>
              {deleteError && (
                <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {deleteError}
                </div>
              )}
            </div>
          </div>
        </div>
        </div>
    </Dialog>
  );
}
