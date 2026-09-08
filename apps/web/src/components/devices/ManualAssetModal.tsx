import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { Dialog } from '../shared/Dialog';
import { showToast } from '../shared/Toast';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { asList } from '@/lib/asList';
import { DEVICE_ROLES, getDeviceRoleLabel, getDeviceRoleIcon, type DeviceRole } from '@/lib/deviceRoles';
import type { Device } from './DeviceList';

export interface ManualAssetOrgOption {
  id: string;
  name: string;
}

export interface ManualAssetSiteOption {
  id: string;
  name: string;
  orgId?: string;
}

interface ManualAssetContact {
  id: string;
  name: string | null;
  email: string | null;
}

export interface ManualAssetModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Fired once the create/update/link/unlink succeeds — the caller refetches. */
  onSaved: () => void;
  /**
   * Fixed org context (the page is scoped to one org), or `null` in fleet
   * view — in which case the operator must choose an org from `orgs` before
   * anything else on the form is usable.
   */
  organizationId: string | null;
  orgs: ManualAssetOrgOption[];
  sites: ManualAssetSiteOption[];
  /** Non-null when editing an existing manual asset; null when creating. */
  existing: Device | null;
  /**
   * Every non-manual row in the currently-loaded fleet (agent + network),
   * used to populate the link pickers and to resolve an already-linked
   * target's display name. Manual assets are never link targets themselves.
   */
  linkableDevices: Device[];
}

type FormState = {
  orgId: string;
  siteId: string;
  name: string;
  assetType: DeviceRole;
  manufacturer: string;
  model: string;
  serialNumber: string;
  assetTag: string;
  location: string;
  assignedContactId: string;
  assignedContactLabel: string;
  tags: string;
  notes: string;
};

const emptyForm = (orgId: string): FormState => ({
  orgId,
  siteId: '',
  name: '',
  assetType: 'unknown',
  manufacturer: '',
  model: '',
  serialNumber: '',
  assetTag: '',
  location: '',
  assignedContactId: '',
  assignedContactLabel: '',
  tags: '',
  notes: '',
});

/**
 * Add/edit modal for a manual (hand-entered, non-networked) inventory asset
 * (#4622 W04). Every mutation goes through `runAction` — the API gates every
 * manual-asset mutator behind `requireMfa()`, so a 403 `MFA_REQUIRED` is an
 * expected outcome here, not a bug, and gets the same friendly copy other
 * MFA-gated device mutations use (ArchiveOrgModal/MergeOrgModal precedent).
 *
 * The link control lives here, on the modal's primary surface, deliberately —
 * #3451 records that today's answer (buried in a tab on
 * /devices/network/:id) is the mistake to not repeat.
 */
export default function ManualAssetModal({
  isOpen,
  onClose,
  onSaved,
  organizationId,
  orgs,
  sites,
  existing,
  linkableDevices,
}: ManualAssetModalProps) {
  const { t } = useTranslation('devices');
  const isEdit = existing != null;

  const [form, setForm] = useState<FormState>(() => emptyForm(organizationId ?? ''));
  const [submitting, setSubmitting] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);

  const [contacts, setContacts] = useState<ManualAssetContact[]>([]);
  const [contactsLoadedForOrg, setContactsLoadedForOrg] = useState<string | null>(null);
  const [contactQuery, setContactQuery] = useState('');
  const [contactPickerOpen, setContactPickerOpen] = useState(false);

  const [linkTargetId, setLinkTargetId] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);

  // Seed the form whenever the modal opens (create) or the edited row changes.
  useEffect(() => {
    if (!isOpen) return;
    if (existing) {
      setForm({
        orgId: existing.orgId,
        siteId: existing.siteId,
        name: existing.displayName || existing.hostname,
        assetType: (existing.assetType as DeviceRole | undefined) ?? 'unknown',
        manufacturer: existing.manufacturer ?? '',
        model: existing.model ?? '',
        serialNumber: existing.serialNumber ?? '',
        assetTag: existing.assetTag ?? '',
        location: existing.location ?? '',
        assignedContactId: existing.assignedContactId ?? '',
        assignedContactLabel: '',
        tags: (existing.tags ?? []).join(', '),
        notes: existing.notes ?? '',
      });
    } else {
      setForm(emptyForm(organizationId ?? ''));
    }
    setDuplicateWarning(null);
    setLinkTargetId('');
  }, [isOpen, existing, organizationId]);

  const sitesForOrg = useMemo(
    () => sites.filter((s) => !form.orgId || s.orgId === form.orgId),
    [sites, form.orgId],
  );

  // Site defaults to the org's only site when there is exactly one (spec).
  // Only auto-applies on CREATE — an edit's siteId is the asset's own truth.
  useEffect(() => {
    if (isEdit) return;
    if (form.siteId) return;
    if (sitesForOrg.length === 1) {
      setForm((f) => ({ ...f, siteId: sitesForOrg[0]!.id }));
    }
  }, [isEdit, form.siteId, sitesForOrg]);

  // Load the selected org's contacts once per org (no server-side search on
  // this route today — filtered client-side as the operator types).
  useEffect(() => {
    if (!form.orgId || contactsLoadedForOrg === form.orgId) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetchWithAuth(`/orgs/organizations/${form.orgId}/contacts?limit=200`);
        if (!resp.ok) {
          // Best-effort, non-blocking field: the picker just stays empty
          // rather than blocking the whole form. Logged (not silent) so a
          // systemic auth/permission failure on this route is still
          // debuggable instead of looking identical to "org has no contacts".
          console.warn('[ManualAssetModal] failed to load org contacts:', resp.status);
          return;
        }
        const data = await resp.json();
        if (!cancelled) {
          setContacts(asList<ManualAssetContact>(data));
          setContactsLoadedForOrg(form.orgId);
        }
      } catch (err) {
        console.warn('[ManualAssetModal] failed to load org contacts:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [form.orgId, contactsLoadedForOrg]);

  const filteredContacts = useMemo(() => {
    const q = contactQuery.trim().toLowerCase();
    if (!q) return contacts.slice(0, 20);
    return contacts.filter((c) => (c.name ?? '').toLowerCase().includes(q) || (c.email ?? '').toLowerCase().includes(q)).slice(0, 20);
  }, [contacts, contactQuery]);

  const canSubmit = form.orgId.length > 0 && form.siteId.length > 0 && form.name.trim().length > 0 && !submitting;

  const mfaFriendly = (code: string) => (code === 'MFA_REQUIRED' ? t('manualAssetModal.errors.mfaRequired') : undefined);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setDuplicateWarning(null);
    const tags = form.tags.split(',').map((s) => s.trim()).filter(Boolean);
    const body: Record<string, unknown> = {
      siteId: form.siteId,
      name: form.name.trim(),
      assetType: form.assetType,
      manufacturer: form.manufacturer.trim() || null,
      model: form.model.trim() || null,
      serialNumber: form.serialNumber.trim() || null,
      assetTag: form.assetTag.trim() || null,
      location: form.location.trim() || null,
      assignedContactId: form.assignedContactId || null,
      notes: form.notes.trim() || null,
      tags,
    };
    if (!isEdit) body.orgId = form.orgId;

    // The mutation itself and its post-success side effects (onSaved/onClose)
    // are deliberately NOT in the same try/catch: a throw from either side
    // effect must never be re-labeled as "create/update failed" when the
    // asset was in fact saved — runAction's own success toast already fired.
    let result: { warnings?: { code: string; message: string }[] } | undefined;
    try {
      result = await runAction<{ warnings?: { code: string; message: string }[] }>({
        request: () =>
          fetchWithAuth(isEdit ? `/devices/manual/${existing!.id}` : '/devices/manual', {
            method: isEdit ? 'PATCH' : 'POST',
            body: JSON.stringify(body),
          }),
        errorFallback: isEdit ? t('manualAssetModal.errors.updateFailed') : t('manualAssetModal.errors.createFailed'),
        friendly: mfaFriendly,
        onUnauthorized: handleSessionExpired,
        successMessage: isEdit ? t('manualAssetModal.toasts.updated') : t('manualAssetModal.toasts.created'),
      });
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: isEdit ? t('manualAssetModal.errors.updateFailed') : t('manualAssetModal.errors.createFailed') });
      }
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    // Non-blocking: the create succeeded either way (spec — duplicate serial
    // is a soft hint, never a rejection). Surfaced as its own toast so it
    // doesn't get lost inside the success message.
    const dup = result.warnings?.find((w) => w.code === 'DUPLICATE_SERIAL');
    if (dup) {
      setDuplicateWarning(dup.message);
      showToast({ type: 'warning', message: dup.message });
    }
    try {
      onSaved();
      if (!dup) onClose();
    } catch (err) {
      // The save genuinely succeeded — a bug in the caller's refresh/close
      // handler must not read back as a failed save. Logged, not silent.
      console.error('[ManualAssetModal] onSaved/onClose threw after a successful save', err);
    }
  };

  const handleLink = async (kind: 'device' | 'asset') => {
    if (!existing || !linkTargetId || linkBusy) return;
    setLinkBusy(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/devices/manual/${existing.id}/link`, {
            method: 'POST',
            body: JSON.stringify(kind === 'device' ? { deviceId: linkTargetId } : { discoveredAssetId: linkTargetId }),
          }),
        errorFallback: t('manualAssetModal.errors.linkFailed'),
        friendly: mfaFriendly,
        onUnauthorized: handleSessionExpired,
        successMessage: t('manualAssetModal.toasts.linked'),
      });
    } catch {
      // runAction already toasted (or handled the 401 redirect).
      return;
    } finally {
      setLinkBusy(false);
    }
    // The link genuinely succeeded — a throw here must not read back as a
    // failed link (runAction's own catch above already handled that case).
    try {
      onSaved();
      onClose();
    } catch (err) {
      console.error('[ManualAssetModal] onSaved/onClose threw after a successful link', err);
    }
  };

  const handleUnlink = async () => {
    if (!existing || linkBusy) return;
    setLinkBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/devices/manual/${existing.id}/link`, { method: 'DELETE' }),
        errorFallback: t('manualAssetModal.errors.unlinkFailed'),
        friendly: mfaFriendly,
        onUnauthorized: handleSessionExpired,
        successMessage: t('manualAssetModal.toasts.unlinked'),
      });
    } catch {
      // runAction already toasted (or handled the 401 redirect).
      return;
    } finally {
      setLinkBusy(false);
    }
    try {
      onSaved();
    } catch (err) {
      console.error('[ManualAssetModal] onSaved threw after a successful unlink', err);
    }
  };

  if (!isOpen) return null;

  const linkedTarget = existing?.linkedDeviceId
    ? linkableDevices.find((d) => d.id === existing.linkedDeviceId)
    : existing?.linkedDiscoveredAssetId
      ? linkableDevices.find((d) => d.id === existing.linkedDiscoveredAssetId)
      : null;
  const isLinked = !!(existing?.linkedDeviceId || existing?.linkedDiscoveredAssetId);
  const linkCandidateDevices = linkableDevices.filter((d) => (d.deviceClass ?? 'agent') === 'agent' && d.orgId === form.orgId);
  const linkCandidateAssets = linkableDevices.filter((d) => (d.deviceClass ?? 'agent') === 'network' && d.orgId === form.orgId);

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      title={isEdit ? t('manualAssetModal.editTitle') : t('manualAssetModal.addTitle')}
      maxWidth="lg"
      className="flex max-h-[90vh] flex-col p-6"
    >
      <div data-testid="manual-asset-modal" className="flex-1 space-y-4 overflow-y-auto">
        <h2 className="text-lg font-semibold text-foreground">
          {isEdit ? t('manualAssetModal.editTitle') : t('manualAssetModal.addTitle')}
        </h2>

        {/* Link control — the modal's PRIMARY surface (#3451: not a tab). */}
        {isEdit && (
          <div data-testid="manual-asset-link-section" className="rounded-md border bg-muted/20 p-3">
            {isLinked ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">
                  {t('manualAssetModal.linkedTo', { name: linkedTarget?.displayName || linkedTarget?.hostname || t('manualAssetModal.linkedUnknown') })}
                </span>
                <button
                  type="button"
                  data-testid="manual-asset-unlink-button"
                  onClick={handleUnlink}
                  disabled={linkBusy}
                  className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                >
                  {t('manualAssetModal.unlink')}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">{t('manualAssetModal.linkSectionTitle')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    data-testid="manual-asset-link-device-select"
                    value={linkTargetId}
                    onChange={(e) => setLinkTargetId(e.target.value)}
                    className="min-w-[180px] rounded-md border bg-background px-2 py-1 text-sm"
                  >
                    <option value="">{t('manualAssetModal.linkDevicePlaceholder')}</option>
                    {linkCandidateDevices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.displayName || d.hostname}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    data-testid="manual-asset-link-device-button"
                    onClick={() => handleLink('device')}
                    disabled={!linkTargetId || linkBusy}
                    className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                  >
                    {t('manualAssetModal.linkToDevice')}
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    data-testid="manual-asset-link-asset-select"
                    value={linkTargetId}
                    onChange={(e) => setLinkTargetId(e.target.value)}
                    className="min-w-[180px] rounded-md border bg-background px-2 py-1 text-sm"
                  >
                    <option value="">{t('manualAssetModal.linkAssetPlaceholder')}</option>
                    {linkCandidateAssets.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.displayName || d.hostname}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    data-testid="manual-asset-link-asset-button"
                    onClick={() => handleLink('asset')}
                    disabled={!linkTargetId || linkBusy}
                    className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                  >
                    {t('manualAssetModal.linkToAsset')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {duplicateWarning && (
          <p data-testid="manual-asset-duplicate-warning" role="status" className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
            {duplicateWarning}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">{t('manualAssetModal.fields.organization')}</label>
            {isEdit || organizationId ? (
              <input
                type="text"
                disabled
                data-testid="manual-asset-org"
                value={orgs.find((o) => o.id === form.orgId)?.name ?? form.orgId}
                className="w-full rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground"
              />
            ) : (
              <select
                data-testid="manual-asset-org"
                value={form.orgId}
                onChange={(e) => setForm((f) => ({ ...f, orgId: e.target.value, siteId: '' }))}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="">{t('manualAssetModal.fields.selectOrganization')}</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">{t('manualAssetModal.fields.site')}</label>
            <select
              data-testid="manual-asset-site"
              value={form.siteId}
              onChange={(e) => setForm((f) => ({ ...f, siteId: e.target.value }))}
              disabled={!form.orgId}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-50"
            >
              <option value="">{t('manualAssetModal.fields.selectSite')}</option>
              {sitesForOrg.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm font-medium">{t('manualAssetModal.fields.name')}</label>
            <input
              type="text"
              data-testid="manual-asset-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t('manualAssetModal.fields.namePlaceholder')}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">{t('manualAssetModal.fields.assetType')}</label>
            <select
              data-testid="manual-asset-type"
              value={form.assetType}
              onChange={(e) => setForm((f) => ({ ...f, assetType: e.target.value as DeviceRole }))}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              {DEVICE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {getDeviceRoleLabel(role)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end gap-2 text-muted-foreground">
            {(() => {
              const Icon = getDeviceRoleIcon(form.assetType);
              return <Icon className="mb-2 h-5 w-5" aria-hidden="true" />;
            })()}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">{t('manualAssetModal.fields.manufacturer')}</label>
            <input
              type="text"
              data-testid="manual-asset-manufacturer"
              value={form.manufacturer}
              onChange={(e) => setForm((f) => ({ ...f, manufacturer: e.target.value }))}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">{t('manualAssetModal.fields.model')}</label>
            <input
              type="text"
              data-testid="manual-asset-model"
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">{t('manualAssetModal.fields.serialNumber')}</label>
            <input
              type="text"
              data-testid="manual-asset-serial"
              value={form.serialNumber}
              onChange={(e) => setForm((f) => ({ ...f, serialNumber: e.target.value }))}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">{t('manualAssetModal.fields.assetTag')}</label>
            <input
              type="text"
              data-testid="manual-asset-tag"
              value={form.assetTag}
              onChange={(e) => setForm((f) => ({ ...f, assetTag: e.target.value }))}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">{t('manualAssetModal.fields.location')}</label>
            <input
              type="text"
              data-testid="manual-asset-location"
              value={form.location}
              onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
              placeholder={t('manualAssetModal.fields.locationPlaceholder')}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div className="relative">
            <label className="mb-1 block text-sm font-medium">{t('manualAssetModal.fields.assignedContact')}</label>
            <input
              type="text"
              data-testid="manual-asset-contact-search"
              value={form.assignedContactLabel || contactQuery}
              onChange={(e) => {
                setContactQuery(e.target.value);
                setContactPickerOpen(true);
                setForm((f) => ({ ...f, assignedContactId: '', assignedContactLabel: '' }));
              }}
              onFocus={() => setContactPickerOpen(true)}
              placeholder={t('manualAssetModal.fields.assignedContactPlaceholder')}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
            {contactPickerOpen && filteredContacts.length > 0 && (
              <div
                data-testid="manual-asset-contact-options"
                className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-card shadow-lg"
              >
                {filteredContacts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    data-testid={`manual-asset-contact-option-${c.id}`}
                    onClick={() => {
                      setForm((f) => ({ ...f, assignedContactId: c.id, assignedContactLabel: c.name || c.email || c.id }));
                      setContactQuery('');
                      setContactPickerOpen(false);
                    }}
                    className="flex w-full items-center px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    {c.name || c.email || c.id}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">{t('manualAssetModal.fields.tags')}</label>
            <input
              type="text"
              data-testid="manual-asset-tags"
              value={form.tags}
              onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
              placeholder={t('manualAssetModal.fields.tagsPlaceholder')}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm font-medium">{t('manualAssetModal.fields.notes')}</label>
            <textarea
              data-testid="manual-asset-notes"
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              rows={3}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2 border-t pt-4">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          {t('manualAssetModal.cancel')}
        </button>
        <button
          type="button"
          data-testid="manual-asset-submit"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {isEdit ? t('manualAssetModal.save') : t('manualAssetModal.create')}
        </button>
      </div>
    </Dialog>
  );
}
