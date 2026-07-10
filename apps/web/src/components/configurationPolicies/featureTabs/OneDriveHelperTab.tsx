import { useState, useEffect } from 'react';
import { Cloud, Plus, Trash2 } from 'lucide-react';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
import OneDriveLibraryPicker, { type PickedLibrary } from './OneDriveLibraryPicker';

type TargetingMode = 'everyone' | 'graph_group' | 'local_ad_group';
type KfmFolder = 'Desktop' | 'Documents' | 'Pictures';

type LibraryMapping = {
  libraryId: string;
  displayName: string;
  siteUrl?: string | null;
  siteId?: string | null;
  webId?: string | null;
  listId?: string | null;
  targetingMode: TargetingMode;
  groupId?: string | null;
  groupName?: string | null;
  hiveScope: 'hkcu' | 'hklm';
  enabled: boolean;
};

type OneDriveHelperSettings = {
  silentAccountConfig: boolean;
  filesOnDemand: boolean;
  kfmSilentOptIn: boolean;
  kfmFolders: KfmFolder[];
  kfmBlockOptOut: boolean;
  tenantAssociationId?: string | null;
  restartOnChange: boolean;
  libraries: LibraryMapping[];
};

const KFM_FOLDERS: KfmFolder[] = ['Desktop', 'Documents', 'Pictures'];

const defaults: OneDriveHelperSettings = {
  silentAccountConfig: true,
  filesOnDemand: true,
  kfmSilentOptIn: false,
  kfmFolders: ['Desktop', 'Documents', 'Pictures'],
  kfmBlockOptOut: false,
  tenantAssociationId: null,
  restartOnChange: true,
  libraries: [],
};

const targetingOptions: { value: TargetingMode; label: string }[] = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'graph_group', label: 'Entra (Graph) group' },
  { value: 'local_ad_group', label: 'Local / AD group' },
];

// Mirrors the server-side zod superRefine on onedriveLibraryMappingSchema so an
// invalid targeting row blocks Save client-side instead of eating a 400.
function libraryError(lib: LibraryMapping): string | null {
  if (lib.targetingMode === 'graph_group' && !lib.groupId?.trim() && !lib.groupName?.trim()) {
    return 'Graph group targeting requires a group ID or group name.';
  }
  if (lib.targetingMode === 'local_ad_group' && !lib.groupName?.trim()) {
    return 'Local/AD group targeting requires a group name.';
  }
  return null;
}

function normalizeLibrary(raw: Partial<LibraryMapping>): LibraryMapping {
  return {
    libraryId: raw.libraryId ?? '',
    displayName: raw.displayName ?? '',
    siteUrl: raw.siteUrl ?? null,
    siteId: raw.siteId ?? null,
    webId: raw.webId ?? null,
    listId: raw.listId ?? null,
    targetingMode: raw.targetingMode ?? 'everyone',
    groupId: raw.groupId ?? null,
    groupName: raw.groupName ?? null,
    hiveScope: raw.hiveScope ?? 'hkcu',
    enabled: raw.enabled ?? true,
  };
}

function mergeSettings(base: OneDriveHelperSettings, stored?: Partial<OneDriveHelperSettings>): OneDriveHelperSettings {
  const merged = { ...base, ...stored };
  merged.kfmFolders = Array.isArray(merged.kfmFolders)
    ? merged.kfmFolders.filter((f): f is KfmFolder => (KFM_FOLDERS as string[]).includes(f))
    : [...base.kfmFolders];
  merged.libraries = Array.isArray(merged.libraries) ? merged.libraries.map(normalizeLibrary) : [];
  return merged;
}

// Decode a friendly SharePoint site hint from a full site URL for the row.
function siteHint(siteUrl?: string | null): string | null {
  if (!siteUrl) return null;
  try {
    const url = new URL(siteUrl);
    return `${url.host}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return siteUrl;
  }
}

export default function OneDriveHelperTab({ policyId, existingLink, onLinkChanged, linkedPolicyId, parentLink, orgId }: FeatureTabProps) {
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const [settings, setSettings] = useState<OneDriveHelperSettings>(() =>
    mergeSettings(defaults, effectiveLink?.inlineSettings as Partial<OneDriveHelperSettings> | undefined),
  );

  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.inlineSettings) {
      setSettings((prev) => mergeSettings(prev, link.inlineSettings as Partial<OneDriveHelperSettings>));
    }
  }, [existingLink, parentLink]);

  const update = <K extends keyof OneDriveHelperSettings>(key: K, value: OneDriveHelperSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const toggleFolder = (folder: KfmFolder) =>
    setSettings((prev) => ({
      ...prev,
      kfmFolders: prev.kfmFolders.includes(folder)
        ? prev.kfmFolders.filter((f) => f !== folder)
        : [...prev.kfmFolders, folder],
    }));

  const updateLibrary = (index: number, patch: Partial<LibraryMapping>) =>
    setSettings((prev) => ({
      ...prev,
      libraries: prev.libraries.map((lib, i) => (i === index ? { ...lib, ...patch } : lib)),
    }));

  const removeLibrary = (index: number) =>
    setSettings((prev) => ({ ...prev, libraries: prev.libraries.filter((_, i) => i !== index) }));

  // The Graph picker (OneDriveLibraryPicker) owns the whole add-flow — Graph
  // browse AND the manual composite-ID paste fallback. It hands back a resolved
  // library, which we normalize into a full mapping row (default targeting).
  const handlePickerAdd = (lib: PickedLibrary) =>
    setSettings((prev) => ({
      ...prev,
      libraries: [
        ...prev.libraries,
        normalizeLibrary({
          libraryId: lib.libraryId,
          displayName: lib.displayName,
          siteUrl: lib.siteUrl || null,
          siteId: lib.siteId || null,
          webId: lib.webId || null,
          listId: lib.listId || null,
        }),
      ],
    }));

  // EventLogTab-style allowlist: build the wire payload from known keys only so
  // legacy/unknown fields on an older link are never re-persisted.
  const toPayload = (s: OneDriveHelperSettings) => ({
    silentAccountConfig: s.silentAccountConfig,
    filesOnDemand: s.filesOnDemand,
    kfmSilentOptIn: s.kfmSilentOptIn,
    kfmFolders: s.kfmFolders,
    kfmBlockOptOut: s.kfmBlockOptOut,
    tenantAssociationId: s.tenantAssociationId?.trim() ? s.tenantAssociationId.trim() : null,
    restartOnChange: s.restartOnChange,
    libraries: s.libraries.map((lib) => ({
      libraryId: lib.libraryId,
      displayName: lib.displayName,
      siteUrl: lib.siteUrl ?? null,
      siteId: lib.siteId ?? null,
      webId: lib.webId ?? null,
      listId: lib.listId ?? null,
      targetingMode: lib.targetingMode,
      groupId: lib.groupId ?? null,
      groupName: lib.groupName ?? null,
      hiveScope: lib.hiveScope,
      enabled: lib.enabled,
    })),
  });

  const hasInvalidLibrary = settings.libraries.some((lib) => libraryError(lib) !== null);

  const persist = async (existingId: string | null) => {
    clearError();
    const result = await save(existingId, {
      featureType: 'onedrive_helper',
      featurePolicyId: linkedPolicyId,
      inlineSettings: toPayload(settings),
    });
    if (result) onLinkChanged(result, 'onedrive_helper');
  };

  const handleSave = () => persist(existingLink?.id ?? null);
  const handleOverride = () => persist(null);

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'onedrive_helper');
  };

  const meta = FEATURE_META.onedrive_helper;

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<Cloud className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      saving={saving}
      saveDisabled={hasInvalidLibrary}
      error={error}
      onSave={handleSave}
      onRemove={existingLink && !linkedPolicyId ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleOverride : undefined}
      onRevert={!isInherited && !!linkedPolicyId && !!existingLink ? handleRemove : undefined}
    >
      <div className="space-y-6">
        {/* Base toggles */}
        <div className="space-y-3">
          <ToggleRow
            testId="onedrive-toggle-silent"
            title="Silent account configuration"
            description="Sign the user into OneDrive automatically with their Windows (Entra) identity — no prompt."
            checked={settings.silentAccountConfig}
            onChange={(v) => update('silentAccountConfig', v)}
          />
          <ToggleRow
            testId="onedrive-toggle-fod"
            title="Files On-Demand"
            description="Keep files online-only until opened, saving local disk space."
            checked={settings.filesOnDemand}
            onChange={(v) => update('filesOnDemand', v)}
          />
          <ToggleRow
            testId="onedrive-toggle-kfm"
            title="Known Folder Move (KFM)"
            description="Silently redirect Desktop, Documents, and Pictures into OneDrive."
            checked={settings.kfmSilentOptIn}
            onChange={(v) => update('kfmSilentOptIn', v)}
          />

          {/* KFM sub-options — only meaningful when KFM is enabled. */}
          {settings.kfmSilentOptIn && (
            <div className="ml-4 space-y-4 rounded-md border border-muted bg-muted/30 px-4 py-4">
              <div>
                <h3 className="text-sm font-semibold">Redirected folders</h3>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {KFM_FOLDERS.map((folder) => (
                    <label key={folder} className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        data-testid={`onedrive-kfm-folder-${folder}`}
                        checked={settings.kfmFolders.includes(folder)}
                        onChange={() => toggleFolder(folder)}
                        className="h-4 w-4 rounded border-border"
                      />
                      {folder}
                    </label>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-3 rounded-md border bg-background px-4 py-3 cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="onedrive-kfm-block-optout"
                  checked={settings.kfmBlockOptOut}
                  onChange={(e) => update('kfmBlockOptOut', e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                <div>
                  <p className="text-sm font-medium">Block opt-out</p>
                  <p className="text-xs text-muted-foreground">Prevent users from moving their known folders back out of OneDrive.</p>
                </div>
              </label>

              <div>
                <label className="text-sm font-medium">Tenant association ID</label>
                <input
                  type="text"
                  data-testid="onedrive-tenant-association"
                  value={settings.tenantAssociationId ?? ''}
                  onChange={(e) => update('tenantAssociationId', e.target.value)}
                  placeholder="Tenant GUID (optional — scopes KFM to your tenant)"
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <p className="mt-1 text-xs text-muted-foreground">Restricts KFM to accounts in this tenant. Leave blank to allow any.</p>
              </div>
            </div>
          )}

          <ToggleRow
            testId="onedrive-toggle-restart"
            title="Restart OneDrive on change"
            description="Restart the OneDrive client after applying policy changes so they take effect immediately."
            checked={settings.restartOnChange}
            onChange={(v) => update('restartOnChange', v)}
          />
        </div>

        {/* SharePoint libraries */}
        <div className="space-y-3 border-t pt-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">SharePoint libraries</h3>
              <p className="text-xs text-muted-foreground">Auto-mount these document libraries for targeted users.</p>
            </div>
            <button
              type="button"
              data-testid="onedrive-add-library-btn"
              onClick={() => setShowPicker(true)}
              className="inline-flex items-center gap-2 rounded-md border border-primary/40 px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/10"
            >
              <Plus className="h-4 w-4" />
              Add library
            </button>
          </div>

          {showPicker && (
            <OneDriveLibraryPicker orgId={orgId ?? undefined} onAdd={handlePickerAdd} onClose={() => setShowPicker(false)} />
          )}

          {settings.libraries.length === 0 && (
            <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              No libraries mapped yet.
            </p>
          )}

          <div className="space-y-3">
            {settings.libraries.map((lib, idx) => {
              const rowError = libraryError(lib);
              const hint = siteHint(lib.siteUrl);
              return (
                <div
                  key={idx}
                  data-testid={`onedrive-lib-row-${idx}`}
                  className="space-y-3 rounded-md border bg-background px-4 py-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{lib.displayName}</p>
                      {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          data-testid={`onedrive-lib-enabled-${idx}`}
                          checked={lib.enabled}
                          onChange={(e) => updateLibrary(idx, { enabled: e.target.checked })}
                          className="h-4 w-4 rounded border-border"
                        />
                        Enabled
                      </label>
                      <button
                        type="button"
                        data-testid={`onedrive-lib-remove-${idx}`}
                        onClick={() => removeLibrary(idx)}
                        className="inline-flex items-center justify-center rounded-md border border-destructive/40 p-2 text-destructive transition hover:bg-destructive/10"
                        aria-label="Remove library"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="text-xs font-medium">Targeting</label>
                      <select
                        data-testid={`onedrive-lib-targeting-${idx}`}
                        value={lib.targetingMode}
                        onChange={(e) => updateLibrary(idx, { targetingMode: e.target.value as TargetingMode })}
                        className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      >
                        {targetingOptions.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>

                    {lib.targetingMode === 'graph_group' && (
                      <div>
                        <label className="text-xs font-medium">Group ID</label>
                        <input
                          type="text"
                          data-testid={`onedrive-lib-groupid-${idx}`}
                          value={lib.groupId ?? ''}
                          onChange={(e) => updateLibrary(idx, { groupId: e.target.value })}
                          placeholder="Entra group object ID"
                          className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                        />
                      </div>
                    )}

                    {(lib.targetingMode === 'graph_group' || lib.targetingMode === 'local_ad_group') && (
                      <div>
                        <label className="text-xs font-medium">Group name</label>
                        <input
                          type="text"
                          data-testid={`onedrive-lib-groupname-${idx}`}
                          value={lib.groupName ?? ''}
                          onChange={(e) => updateLibrary(idx, { groupName: e.target.value })}
                          placeholder={lib.targetingMode === 'local_ad_group' ? 'AD / local group name' : 'Entra group display name'}
                          className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                        />
                      </div>
                    )}
                  </div>

                  {rowError && <p className="text-xs text-destructive">{rowError}</p>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </FeatureTabShell>
  );
}

function ToggleRow({
  testId,
  title,
  description,
  checked,
  onChange,
}: {
  testId: string;
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
      <div className="pr-4">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        data-testid={testId}
        aria-pressed={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition ${checked ? 'bg-emerald-500/80' : 'bg-muted'}`}
      >
        <span className={`inline-block h-5 w-5 rounded-full bg-white transition ${checked ? 'translate-x-5' : 'translate-x-1'}`} />
      </button>
    </div>
  );
}
