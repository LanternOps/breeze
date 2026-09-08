import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { runAction, ActionError, handleActionError } from '@/lib/runAction';
import CreateMonitorForm from '../monitors/CreateMonitorForm';

// #5213 W02/W03 — hand-enter a network asset. A manual asset IS a
// discovered_assets row (source='manual'), so this form posts the same
// identity fields the scan/UniFi writers populate: assetType,
// ipAddress/hostname/url, mac, manufacturer, model, tags, notes. `label` is
// REQUIRED here (not just on the API): a url-only row with no label falls
// back to an empty display name in the unified list's hostname precedence
// (label > hostname > url > ip).
//
// Asset-type options are the same 12 the Discovery list already exposes (see
// discovery:assetTypes.*) plus `website`/`service` (W03,
// docs/superpowers/plans/device-lifecycle/2026-09-07-manual-network-asset.md):
// those two require a URL (not just "any identity") and hide the MAC field,
// which doesn't apply to an IP-less endpoint.
const NETWORK_ASSET_TYPES = [
  'workstation', 'server', 'printer', 'router', 'switch', 'firewall',
  'access_point', 'phone', 'iot', 'camera', 'nas', 'website', 'service', 'unknown',
] as const;
type NetworkAssetType = (typeof NETWORK_ASSET_TYPES)[number];

// discovery:assetTypes uses camelCase for access_point; every other value
// matches the enum literal exactly.
const ASSET_TYPE_LABEL_KEYS: Record<NetworkAssetType, string> = {
  workstation: 'discovery:assetTypes.workstation',
  server: 'discovery:assetTypes.server',
  printer: 'discovery:assetTypes.printer',
  router: 'discovery:assetTypes.router',
  switch: 'discovery:assetTypes.switch',
  firewall: 'discovery:assetTypes.firewall',
  access_point: 'discovery:assetTypes.accessPoint',
  phone: 'discovery:assetTypes.phone',
  iot: 'discovery:assetTypes.iot',
  camera: 'discovery:assetTypes.camera',
  nas: 'discovery:assetTypes.nas',
  website: 'discovery:assetTypes.website',
  service: 'discovery:assetTypes.service',
  unknown: 'discovery:assetTypes.unknown',
};

// A website/service asset is identified by its URL, not an IP — it never has
// a MAC address, and the URL (not "any of IP/hostname/URL") is what's
// required. Everything else about the form stays the same.
const URL_REQUIRED_TYPES = new Set<NetworkAssetType>(['website', 'service']);

interface AddNetworkAssetModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the created asset id after a successful POST. */
  onCreated?: (assetId: string) => void;
}

export default function AddNetworkAssetModal({ isOpen, onClose, onCreated }: AddNetworkAssetModalProps) {
  const { t } = useTranslation('devices');
  const { currentOrgId, sites, fetchSites } = useOrgStore();
  const orgSites = sites.filter((s) => s.orgId === currentOrgId);

  const [label, setLabel] = useState('');
  const [assetType, setAssetType] = useState<NetworkAssetType>('unknown');
  const [siteId, setSiteId] = useState('');
  const [ipAddress, setIpAddress] = useState('');
  const [hostname, setHostname] = useState('');
  const [url, setUrl] = useState('');
  const [macAddress, setMacAddress] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [model, setModel] = useState('');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Post-create hand-off (W03): a website/service asset has no monitoring of
  // its own yet, so offer an inline "Add an HTTP check" step instead of
  // closing immediately. Every other asset type keeps the W02 behavior —
  // close right away.
  const [createdAsset, setCreatedAsset] = useState<{ id: string; url: string } | null>(null);
  const [showMonitorForm, setShowMonitorForm] = useState(false);

  useEffect(() => {
    if (isOpen && currentOrgId && sites.length === 0) void fetchSites();
  }, [isOpen, currentOrgId, sites.length, fetchSites]);

  // Default the site when the org has exactly one — the common single-site
  // MSP-client case shouldn't force an extra click. Depends on `sites` and
  // `currentOrgId` (orgSites's real inputs) rather than the derived
  // `orgSites` array itself, which is a fresh reference every render.
  useEffect(() => {
    if (isOpen && !siteId && orgSites.length === 1) setSiteId(orgSites[0]!.id);
  }, [isOpen, siteId, sites, currentOrgId, orgSites]);

  const resetForm = () => {
    setLabel('');
    setAssetType('unknown');
    setSiteId('');
    setIpAddress('');
    setHostname('');
    setUrl('');
    setMacAddress('');
    setManufacturer('');
    setModel('');
    setTags('');
    setNotes('');
    setError(null);
    setCreatedAsset(null);
    setShowMonitorForm(false);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const urlRequired = URL_REQUIRED_TYPES.has(assetType);
  const hasIdentity = urlRequired
    ? Boolean(url.trim())
    : Boolean(ipAddress.trim() || hostname.trim() || url.trim());
  const canSubmit = Boolean(label.trim() && currentOrgId && siteId && hasIdentity) && !submitting;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !currentOrgId) return;

    setSubmitting(true);
    setError(null);

    const payload = {
      orgId: currentOrgId,
      siteId,
      label: label.trim(),
      assetType,
      ipAddress: ipAddress.trim() || null,
      hostname: hostname.trim() || null,
      url: url.trim() || null,
      macAddress: macAddress.trim() || null,
      manufacturer: manufacturer.trim() || null,
      model: model.trim() || null,
      notes: notes.trim() || null,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    };

    try {
      const result = await runAction<{ id: string }>({
        request: () => fetchWithAuth('/devices/network', {
          method: 'POST',
          body: JSON.stringify(payload),
        }),
        successMessage: t('addNetworkAssetModal.toasts.created'),
        errorFallback: t('addNetworkAssetModal.toasts.createFailed'),
      });
      onCreated?.(result.id);
      if (urlRequired) {
        // Website/service: offer the HTTP-check hand-off instead of closing.
        // The list has already been refreshed via onCreated above.
        setCreatedAsset({ id: result.id, url: payload.url ?? '' });
      } else {
        resetForm();
        onClose();
      }
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      handleActionError(err, t('addNetworkAssetModal.toasts.createFailed'));
      setError(err instanceof ActionError ? err.message : t('addNetworkAssetModal.toasts.createFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onClose={handleClose} title={t('addNetworkAssetModal.title')} maxWidth="lg">
      <div className="p-6">
        <h2 className="mb-4 text-lg font-semibold">{t('addNetworkAssetModal.title')}</h2>
        {createdAsset ? (
          <div className="space-y-4" data-testid="asset-post-create">
            <p className="text-sm text-muted-foreground">{t('addNetworkAssetModal.postCreate.monitorPrompt')}</p>
            {!showMonitorForm && (
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  data-testid="asset-post-create-done"
                  onClick={handleClose}
                  className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
                >
                  {t('common:actions.done')}
                </button>
                <button
                  type="button"
                  data-testid="asset-post-create-add-http-check"
                  onClick={() => setShowMonitorForm(true)}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  {t('addNetworkAssetModal.postCreate.actions.addHttpCheck')}
                </button>
              </div>
            )}
            {showMonitorForm && (
              <CreateMonitorForm
                assetId={createdAsset.id}
                defaultTarget={createdAsset.url}
                onCreated={handleClose}
                onCancel={() => setShowMonitorForm(false)}
              />
            )}
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="asset-label-input" className="mb-1 block text-sm font-medium">
              {t('addNetworkAssetModal.fields.label')}
            </label>
            <input
              id="asset-label-input"
              data-testid="asset-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('addNetworkAssetModal.placeholders.label')}
              maxLength={255}
              required
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="asset-type-select" className="mb-1 block text-sm font-medium">
                {t('common:labels.type')}
              </label>
              <select
                id="asset-type-select"
                data-testid="asset-type"
                value={assetType}
                onChange={(e) => setAssetType(e.target.value as NetworkAssetType)}
                className="h-10 w-full rounded-md border bg-background px-2 text-sm"
              >
                {NETWORK_ASSET_TYPES.map((typeOption) => (
                  <option key={typeOption} value={typeOption}>
                    {t(/* i18n-dynamic */ ASSET_TYPE_LABEL_KEYS[typeOption])}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="asset-site-select" className="mb-1 block text-sm font-medium">
                {t('common:labels.site')}
              </label>
              <select
                id="asset-site-select"
                data-testid="asset-site"
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
                required
                className="h-10 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="" disabled>{t('addNetworkAssetModal.placeholders.selectSite')}</option>
                {orgSites.map((site) => (
                  <option key={site.id} value={site.id}>{site.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="rounded-md border bg-muted/30 p-3">
            <p className="mb-2 text-xs text-muted-foreground">
              {t(urlRequired ? 'addNetworkAssetModal.urlRequiredHint' : 'addNetworkAssetModal.identityHint')}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="asset-ip-input" className="mb-1 block text-sm font-medium">
                  {t('addNetworkAssetModal.fields.ipAddress')}
                </label>
                <input
                  id="asset-ip-input"
                  data-testid="asset-ip"
                  type="text"
                  value={ipAddress}
                  onChange={(e) => setIpAddress(e.target.value)}
                  placeholder="10.0.0.42"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label htmlFor="asset-hostname-input" className="mb-1 block text-sm font-medium">
                  {t('addNetworkAssetModal.fields.hostname')}
                </label>
                <input
                  id="asset-hostname-input"
                  data-testid="asset-hostname"
                  type="text"
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  maxLength={255}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
            <div className="mt-3">
              <label htmlFor="asset-url-input" className="mb-1 block text-sm font-medium">
                {t('addNetworkAssetModal.fields.url')}
              </label>
              <input
                id="asset-url-input"
                data-testid="asset-url"
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://shop.example"
                maxLength={2048}
                required={urlRequired}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          {/* A website/service asset has no MAC address — it isn't reachable
              on the local network segment the way a printer or switch is. */}
          <div className={urlRequired ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-2 gap-3'}>
            {!urlRequired && (
              <div>
                <label htmlFor="asset-mac-input" className="mb-1 block text-sm font-medium">
                  {t('addNetworkAssetModal.fields.macAddress')}
                </label>
                <input
                  id="asset-mac-input"
                  data-testid="asset-mac"
                  type="text"
                  value={macAddress}
                  onChange={(e) => setMacAddress(e.target.value)}
                  placeholder="00:11:22:33:44:55"
                  maxLength={17}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
              </div>
            )}
            <div>
              <label htmlFor="asset-manufacturer-input" className="mb-1 block text-sm font-medium">
                {t('addNetworkAssetModal.fields.manufacturer')}
              </label>
              <input
                id="asset-manufacturer-input"
                data-testid="asset-manufacturer"
                type="text"
                value={manufacturer}
                onChange={(e) => setManufacturer(e.target.value)}
                maxLength={255}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="asset-model-input" className="mb-1 block text-sm font-medium">
                {t('addNetworkAssetModal.fields.model')}
              </label>
              <input
                id="asset-model-input"
                data-testid="asset-model"
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                maxLength={255}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label htmlFor="asset-tags-input" className="mb-1 block text-sm font-medium">
                {t('addNetworkAssetModal.fields.tags')}
              </label>
              <input
                id="asset-tags-input"
                data-testid="asset-tags"
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder={t('addNetworkAssetModal.placeholders.tags')}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <div>
            <label htmlFor="asset-notes-input" className="mb-1 block text-sm font-medium">
              {t('addNetworkAssetModal.fields.notes')}
            </label>
            <textarea
              id="asset-notes-input"
              data-testid="asset-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              {t('common:actions.cancel')}
            </button>
            <button
              type="submit"
              data-testid="asset-submit"
              disabled={!canSubmit}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? t('common:states.saving') : t('addNetworkAssetModal.submit')}
            </button>
          </div>
        </form>
        )}
      </div>
    </Dialog>
  );
}
