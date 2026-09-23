import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { typeConfig, type DiscoveredAsset, type DiscoveredAssetType } from '@/components/discovery/DiscoveredAssetList';
import ChangeSiteModal from '@/components/devices/ChangeSiteModal';
import { showToast } from '@/components/shared/Toast';
import { ActionError } from '@/lib/runAction';
import type { NetworkAssetExtras } from '../types';
import { SettingsSectionShell } from './SettingsSectionShell';
import { ASSET_TYPE_GROUPS, isPatchableAssetType } from './assetTypeGroups';
import { useNetworkAssetMutations, type IdentityPatch } from './useNetworkAssetMutations';

type IdentitySectionProps = {
  asset: DiscoveredAsset;
  assetId: string;
  /** Org/site context for the Change-site dialog; absent on older callers. */
  extras?: NetworkAssetExtras;
  onSaved: () => void | boolean | Promise<void | boolean>;
  onAnnounce: (message: string) => void;
};

const fieldClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export function IdentitySection({ asset, assetId, extras, onSaved, onAnnounce }: IdentitySectionProps) {
  const { t } = useTranslation('devices');
  const { patchIdentity, changeSite } = useNetworkAssetMutations();

  // Site moves are their own dialog rather than a field in this form: the
  // server may also drop a cross-site device link and disable topology
  // policies, which the operator must be told about (spec: site-move summary).
  const [changeSiteOpen, setChangeSiteOpen] = useState(false);
  const siteMoveSummary = useRef<string | null>(null);
  const changeSiteSubject = extras?.orgId && extras.siteId
    ? {
      id: assetId,
      name: asset.label || asset.hostname || asset.ip,
      orgId: extras.orgId,
      siteId: extras.siteId,
      siteName: extras.siteName ?? null,
    }
    : null;

  const handleSiteMoved = async () => {
    if (await onSaved() === false) {
      showToast({ type: 'error', message: t('networkDeviceDetailPage.settings.refreshFailed') });
    }
    onAnnounce(siteMoveSummary.current ?? t('networkDeviceDetailPage.settings.toasts.siteChanged', { site: '' }));
    siteMoveSummary.current = null;
  };

  const tags = (asset.tags ?? []).join(', ');
  const baseline = useMemo(() => ({
    label: asset.label ?? '',
    tags,
    notes: asset.notes ?? '',
    type: asset.type,
  }), [asset.label, tags, asset.notes, asset.type]);

  const [draft, setDraft] = useState(baseline);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const previousBaseline = useRef(baseline);
  useEffect(() => {
    const previous = previousBaseline.current;
    if (previous === baseline) return;
    previousBaseline.current = baseline;
    const hadEdits = draft.label.trim() !== previous.label.trim()
      || draft.notes !== previous.notes || draft.tags !== previous.tags || draft.type !== previous.type;
    if (hadEdits && !saving) setConflict(true);
    else setDraft(baseline);
  }, [baseline, draft, saving]);

  const dirty =
    draft.label.trim() !== baseline.label.trim()
    || draft.notes !== baseline.notes
    || draft.tags !== baseline.tags
    || draft.type !== baseline.type;

  const handleSave = async () => {
    const patch: IdentityPatch = {};
    if (draft.label.trim() !== baseline.label.trim()) patch.label = draft.label.trim() || null;
    if (draft.notes !== baseline.notes) patch.notes = draft.notes.trim() || null;
    if (draft.tags !== baseline.tags) {
      patch.tags = draft.tags.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (draft.type !== baseline.type) patch.assetType = draft.type;
    if (Object.keys(patch).length === 0) return;

    setSaving(true);
    setConflict(false);
    try {
      await patchIdentity(assetId, patch);
      if (await onSaved() === false) {
        showToast({ type: 'error', message: t('networkDeviceDetailPage.settings.refreshFailed') });
      }
      onAnnounce(t('networkDeviceDetailPage.settings.toasts.identitySaved'));
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;   // auth redirect owns it
      if (err instanceof ActionError && err.status === 409) {
        // Spec §14: someone else changed this asset. Reload and drop the draft
        // rather than letting a stale Save overwrite their change on retry.
        setConflict(true);
        setDraft(baseline);
        if (await onSaved() === false) {
          showToast({ type: 'error', message: t('networkDeviceDetailPage.settings.refreshFailed') });
        }
        return;
      }
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('networkDeviceDetailPage.settings.toasts.identitySaveFailed') });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleResetType = async () => {
    setSaving(true);
    setConflict(false);
    try {
      // Reset discards any pending type edit too — throwing away manual
      // overrides is its whole point, so a pending one must not survive it.
      await patchIdentity(assetId, { resetTypeToAuto: true });
      setDraft((d) => ({ ...d, type: baseline.type }));
      if (await onSaved() === false) {
        showToast({ type: 'error', message: t('networkDeviceDetailPage.settings.refreshFailed') });
      }
      onAnnounce(t('networkDeviceDetailPage.toasts.typeReset'));
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('networkDeviceDetailPage.toasts.typeResetFailed') });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSectionShell
      section="identity"
      title={t('networkDeviceDetailPage.settings.sections.identity')}
      description={t('networkDeviceDetailPage.settings.identity.description')}
      dirty={dirty}
      saving={saving}
      onSave={() => void handleSave()}
      onCancel={() => { setDraft(baseline); setConflict(false); }}
    >
      <fieldset disabled={saving} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="network-settings-identity-name" className="text-sm font-medium">{t('networkDeviceDetailPage.settings.identity.displayName')}</label>
          <input id="network-settings-identity-name" data-testid="network-settings-identity-name" maxLength={255} className={fieldClass}
            value={draft.label} onChange={(event) => setDraft((d) => ({ ...d, label: event.target.value }))} />
        </div>
        <div className="space-y-1">
          <label htmlFor="network-settings-identity-type" className="text-sm font-medium">{t('networkDeviceDetailPage.settings.identity.type')}</label>
          <select id="network-settings-identity-type" data-testid="network-settings-identity-type" className={fieldClass}
            value={draft.type} onChange={(event) => setDraft((d) => ({ ...d, type: event.target.value as DiscoveredAssetType }))}>
            {!isPatchableAssetType(asset.type) && <option value={asset.type} disabled>{t(/* i18n-dynamic */ typeConfig[asset.type].labelKey)}</option>}
            {ASSET_TYPE_GROUPS.map((group) => (
              <optgroup key={group.labelKey} label={t(/* i18n-dynamic */ group.labelKey)}>
                {group.types.map((type) => <option key={type} value={type}>{t(/* i18n-dynamic */ typeConfig[type].labelKey)}</option>)}
              </optgroup>
            ))}
          </select>
          {!isPatchableAssetType(asset.type) && <p data-testid="network-settings-identity-type-fixed" className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.settings.identity.typeFixed')}</p>}
          {asset.typeSource === 'manual' && asset.detectedType && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span data-testid="network-settings-identity-type-detected" className="text-muted-foreground">{t('networkDeviceDetailPage.settings.identity.typeDetected', { type: t(/* i18n-dynamic */ typeConfig[asset.detectedType].labelKey) })}</span>
              <button type="button" data-testid="network-settings-identity-type-reset" onClick={() => void handleResetType()}
                className="rounded-md border px-2 py-1 hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                {t('networkDeviceDetailPage.settings.identity.resetToDetected')}
              </button>
            </div>
          )}
          {draft.type !== baseline.type && <p data-testid="network-settings-identity-type-consequence" className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.settings.identity.typeConsequence')}</p>}
        </div>
        <div className="space-y-1">
          <label htmlFor="network-settings-identity-tags" className="text-sm font-medium">{t('networkDeviceDetailPage.settings.identity.tags')}</label>
          <input id="network-settings-identity-tags" data-testid="network-settings-identity-tags" aria-describedby="network-settings-identity-tags-hint" className={fieldClass}
            value={draft.tags} onChange={(event) => setDraft((d) => ({ ...d, tags: event.target.value }))} />
          <p id="network-settings-identity-tags-hint" className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.settings.identity.tagsHint')}</p>
        </div>
        <div className="space-y-1">
          <label htmlFor="network-settings-identity-notes" className="text-sm font-medium">{t('networkDeviceDetailPage.settings.identity.notes')}</label>
          <textarea id="network-settings-identity-notes" data-testid="network-settings-identity-notes" rows={4} className={fieldClass}
            value={draft.notes} onChange={(event) => setDraft((d) => ({ ...d, notes: event.target.value }))} />
        </div>
        {conflict && <p role="alert" data-testid="network-settings-identity-conflict" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">{t('networkDeviceDetailPage.settings.identity.conflict')}</p>}
      </fieldset>
      <div className="mt-4 space-y-1 border-t pt-4">
        <span className="text-sm font-medium">{t('networkDeviceDetailPage.settings.identity.site')}</span>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span data-testid="network-settings-identity-site">{extras?.siteName || '—'}</span>
          {changeSiteSubject && (
            <button type="button" data-testid="network-settings-identity-change-site" disabled={saving}
              onClick={() => setChangeSiteOpen(true)}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
              {t('networkDeviceDetailPage.settings.identity.changeSite')}
            </button>
          )}
        </div>
      </div>
      {changeSiteSubject && (
        <ChangeSiteModal
          subject={changeSiteSubject}
          submit={async (siteId, siteName) => {
            const result = await changeSite(assetId, siteId, siteName);
            siteMoveSummary.current = result.summary;
          }}
          isOpen={changeSiteOpen}
          onClose={() => setChangeSiteOpen(false)}
          onSaved={() => void handleSiteMoved()}
        />
      )}
    </SettingsSectionShell>
  );
}
