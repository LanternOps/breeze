import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Loader2, Upload, Link2, HardDriveUpload } from 'lucide-react';
import type { DetectionRule } from '@breeze/shared';
import { cn } from '@/lib/utils';
import { Dialog } from '../shared/Dialog';
import { showToast } from '../shared/Toast';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { findUnknownTokens } from '@/lib/installerVariables';
import DetectionRulesEditor from './DetectionRulesEditor';
import VariableInput, { type DeviceCustomField } from './VariableInput';

type Architecture = 'x64' | 'arm64' | 'x86';
type Source = 'url' | 'file';

export interface CreatedPackage {
  id: string;
  name: string;
  vendor: string;
  category: string;
  description: string;
  createdAt: string;
  versionCount: number;
}

interface AddPackageModalProps {
  open: boolean;
  onClose: () => void;
  /** Called once the package AND its first version are persisted. */
  onCreated: (pkg: CreatedPackage) => void;
}

const CATEGORIES = [
  'browser', 'utility', 'compression', 'productivity',
  'communication', 'developer', 'media', 'security',
] as const;

const OS_OPTIONS = ['Windows', 'macOS', 'Linux'] as const;

const blankForm = {
  name: '',
  vendor: '',
  category: 'utility',
  description: '',
  version: '',
  architecture: 'x64' as Architecture,
  source: 'url' as Source,
  downloadUrl: '',
  supportedOs: [] as string[],
  silentInstallArgs: '',
  silentUninstallArgs: '',
  detectionRules: [] as DetectionRule[],
  notes: '',
  file: null as File | null,
  fileName: '',
};

export default function AddPackageModal({ open, onClose, onCreated }: AddPackageModalProps) {
  const [form, setForm] = useState(blankForm);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [customFields, setCustomFields] = useState<DeviceCustomField[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // If the catalog item was created but the version write failed, keep its id so
  // a retry continues from the version step instead of creating a duplicate.
  const createdCatalogId = useRef<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    setForm(blankForm);
    setAdvancedOpen(false);
    createdCatalogId.current = null;
    if (fileInputRef.current) fileInputRef.current.value = '';
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth('/custom-fields?limit=200');
        if (!res.ok || cancelled) return;
        const payload = await res.json();
        const rows = payload.data ?? payload ?? [];
        if (Array.isArray(rows)) {
          setCustomFields(
            rows
              .map((r: Record<string, unknown>) => ({
                fieldKey: String(r.fieldKey ?? ''),
                name: String(r.name ?? r.fieldKey ?? ''),
              }))
              .filter((f: DeviceCustomField) => f.fieldKey),
          );
        }
      } catch {
        /* custom fields are optional for the variable picker */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const update = <K extends keyof typeof blankForm>(key: K, value: (typeof blankForm)[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    setForm((prev) => ({
      ...prev,
      file,
      fileName: file.name,
      silentInstallArgs:
        ext === 'msi' && !prev.silentInstallArgs
          ? 'msiexec /i "{file}" /qn /norestart'
          : prev.silentInstallArgs,
      silentUninstallArgs:
        ext === 'msi' && !prev.silentUninstallArgs
          ? 'msiexec /x "{file}" /qn /norestart'
          : prev.silentUninstallArgs,
    }));
  };

  const knownKeys = useMemo(() => new Set(customFields.map((f) => f.fieldKey)), [customFields]);
  const tokenErrors = useMemo(() => {
    const opts = { requireKnownCustomKeys: knownKeys.size > 0 };
    return [form.downloadUrl, form.silentInstallArgs, form.silentUninstallArgs].flatMap((s) =>
      findUnknownTokens(s, knownKeys, opts),
    );
  }, [form.downloadUrl, form.silentInstallArgs, form.silentUninstallArgs, knownKeys]);

  const hasSource = form.source === 'url' ? form.downloadUrl.trim() !== '' : form.file != null;
  const canSubmit =
    form.name.trim() !== '' &&
    form.version.trim() !== '' &&
    hasSource &&
    tokenErrors.length === 0 &&
    !saving;

  const buildVersionRequest = (catalogId: string): (() => Promise<Response>) => {
    const shared = {
      version: form.version.trim(),
      architecture: form.architecture,
      releaseNotes: form.notes || undefined,
      silentInstallArgs: form.silentInstallArgs || undefined,
      silentUninstallArgs: form.silentUninstallArgs || undefined,
      supportedOs: form.supportedOs.length > 0 ? form.supportedOs : undefined,
      detectionRules: form.detectionRules.length > 0 ? form.detectionRules : undefined,
    };

    if (form.source === 'file' && form.file) {
      const fd = new FormData();
      fd.append('file', form.file);
      fd.append('version', shared.version);
      fd.append('architecture', shared.architecture);
      if (shared.releaseNotes) fd.append('releaseNotes', shared.releaseNotes);
      if (shared.silentInstallArgs) fd.append('silentInstallArgs', shared.silentInstallArgs);
      if (shared.silentUninstallArgs) fd.append('silentUninstallArgs', shared.silentUninstallArgs);
      if (shared.supportedOs) fd.append('supportedOs', JSON.stringify(shared.supportedOs));
      if (shared.detectionRules) fd.append('detectionRules', JSON.stringify(shared.detectionRules));
      if (form.downloadUrl.trim()) fd.append('downloadUrl', form.downloadUrl.trim());
      return () =>
        fetchWithAuth(`/software/catalog/${catalogId}/versions/upload`, {
          method: 'POST',
          body: fd,
          headers: {},
        });
    }

    return () =>
      fetchWithAuth(`/software/catalog/${catalogId}/versions`, {
        method: 'POST',
        body: JSON.stringify({ ...shared, downloadUrl: form.downloadUrl.trim() || undefined }),
      });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setSaving(true);
    try {
      // Step 1 — create the catalog item (skip if a prior attempt already did).
      if (!createdCatalogId.current) {
        const item = await runAction<{ id: string }>({
          request: () =>
            fetchWithAuth('/software/catalog', {
              method: 'POST',
              body: JSON.stringify({
                name: form.name.trim(),
                vendor: form.vendor.trim() || undefined,
                category: form.category,
                description: form.description.trim() || undefined,
              }),
            }),
          parseSuccess: (d) => {
            const data = (d as { data?: { id?: unknown } }).data ?? (d as { id?: unknown });
            return { id: String((data as { id?: unknown }).id ?? '') };
          },
          errorFallback: 'Failed to create package',
        });
        createdCatalogId.current = item.id;
      }

      const catalogId = createdCatalogId.current;
      if (!catalogId) throw new Error('Missing package id');

      // Step 2 — add the first version. Success toast lands here so the user is
      // only told "added" once the package is actually deployable.
      await runAction({
        request: buildVersionRequest(catalogId),
        errorFallback: 'Package created, but adding the first version failed',
        successMessage: `Added ${form.name.trim()} — v${form.version.trim()}`,
      });

      onCreated({
        id: catalogId,
        name: form.name.trim(),
        vendor: form.vendor.trim(),
        category: form.category,
        description: form.description.trim(),
        createdAt: new Date().toISOString(),
        versionCount: 1,
      });
      onClose();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to add package' });
      }
      // Non-401 ActionError already toasted by runAction. Modal stays open; if the
      // catalog item was created, createdCatalogId retries from the version step.
    } finally {
      setSaving(false);
    }
  };

  const labelCls = 'text-xs font-semibold uppercase text-muted-foreground';
  const inputCls =
    'mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring';

  return (
    <Dialog
      open={open}
      onClose={saving ? () => {} : onClose}
      title="Add software package"
      labelledBy={titleId}
      maxWidth="2xl"
      alignTop
      className="flex max-h-[90vh] flex-col"
    >
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h2 id={titleId} className="text-lg font-semibold">Add software package</h2>
          <p className="text-sm text-muted-foreground">
            Create the package and its first deployable version in one step.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {/* Package identity */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground">Package</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="pkg-name">Name</label>
                <input
                  id="pkg-name"
                  autoFocus
                  type="text"
                  value={form.name}
                  onChange={(e) => update('name', e.target.value)}
                  placeholder="e.g. Google Chrome"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="pkg-vendor">Vendor</label>
                <input
                  id="pkg-vendor"
                  type="text"
                  value={form.vendor}
                  onChange={(e) => update('vendor', e.target.value)}
                  placeholder="e.g. Google"
                  className={inputCls}
                />
              </div>
            </div>
            <div>
              <label className={labelCls} htmlFor="pkg-category">Category</label>
              <select
                id="pkg-category"
                value={form.category}
                onChange={(e) => update('category', e.target.value)}
                className={inputCls}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                ))}
              </select>
            </div>
          </section>

          {/* First version */}
          <section className="space-y-4 border-t pt-5">
            <h3 className="text-sm font-semibold text-foreground">First version</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="pkg-version">Version</label>
                <input
                  id="pkg-version"
                  type="text"
                  value={form.version}
                  onChange={(e) => update('version', e.target.value)}
                  placeholder="e.g. 1.0.0"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="pkg-arch">Architecture</label>
                <select
                  id="pkg-arch"
                  value={form.architecture}
                  onChange={(e) => update('architecture', e.target.value as Architecture)}
                  className={inputCls}
                >
                  <option value="x64">x64</option>
                  <option value="arm64">arm64</option>
                  <option value="x86">x86</option>
                </select>
              </div>
            </div>

            {/* Source: URL or file, one control */}
            <div>
              <span className={labelCls}>Source</span>
              <div className="mt-2 inline-flex rounded-md border bg-muted/40 p-0.5" role="tablist" aria-label="Installer source">
                {([['url', 'Download URL', Link2], ['file', 'Upload file', HardDriveUpload]] as const).map(
                  ([val, label, Icon]) => (
                    <button
                      key={val}
                      type="button"
                      role="tab"
                      aria-selected={form.source === val}
                      onClick={() => update('source', val)}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors',
                        form.source === val
                          ? 'bg-background text-foreground shadow-xs'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {label}
                    </button>
                  ),
                )}
              </div>

              {form.source === 'url' ? (
                <div className="mt-3">
                  <VariableInput
                    id="pkg-url"
                    value={form.downloadUrl}
                    onChange={(v) => update('downloadUrl', v)}
                    placeholder="https://example.com/package-v1.0.0.msi"
                    customFields={customFields}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Use variables like <code className="font-mono">{'{{org.name}}'}</code> — resolved per organization at deploy time.
                  </p>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".msi,.exe,.dmg,.deb,.pkg"
                    onChange={handleFile}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex h-10 items-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
                  >
                    <Upload className="h-4 w-4" />
                    Choose file
                  </button>
                  <span className="truncate text-sm text-muted-foreground">
                    {form.fileName || 'No file selected (.msi, .exe, .dmg, .deb, .pkg)'}
                  </span>
                </div>
              )}
            </div>

            <div>
              <span className={labelCls}>Supported OS</span>
              <div className="mt-2 flex flex-wrap items-center gap-4">
                {OS_OPTIONS.map((os) => {
                  const val = os.toLowerCase();
                  return (
                    <label key={os} className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.supportedOs.includes(val)}
                        onChange={(e) =>
                          update(
                            'supportedOs',
                            e.target.checked
                              ? [...form.supportedOs, val]
                              : form.supportedOs.filter((o) => o !== val),
                          )
                        }
                        className="h-4 w-4 rounded border"
                      />
                      {os}
                    </label>
                  );
                })}
              </div>
            </div>

            <div>
              <label className={labelCls} htmlFor="pkg-install">Silent install args</label>
              <div className="mt-2">
                <VariableInput
                  id="pkg-install"
                  value={form.silentInstallArgs}
                  onChange={(v) => update('silentInstallArgs', v)}
                  placeholder={'e.g. msiexec /i "{file}" /qn /norestart'}
                  customFields={customFields}
                />
              </div>
            </div>
          </section>

          {/* Advanced */}
          <section className="border-t pt-3">
            <button
              type="button"
              onClick={() => setAdvancedOpen((o) => !o)}
              aria-expanded={advancedOpen}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className={cn('h-4 w-4 transition-transform', advancedOpen && 'rotate-180')} />
              Advanced options
            </button>

            {advancedOpen && (
              <div className="mt-4 space-y-4">
                <div>
                  <label className={labelCls} htmlFor="pkg-uninstall">Silent uninstall args</label>
                  <div className="mt-2">
                    <VariableInput
                      id="pkg-uninstall"
                      value={form.silentUninstallArgs}
                      onChange={(v) => update('silentUninstallArgs', v)}
                      placeholder={'e.g. msiexec /x "{file}" /qn /norestart'}
                      customFields={customFields}
                    />
                  </div>
                </div>

                <DetectionRulesEditor
                  rules={form.detectionRules}
                  onChange={(detectionRules) => update('detectionRules', detectionRules)}
                />

                <div>
                  <label className={labelCls} htmlFor="pkg-notes">Release notes</label>
                  <textarea
                    id="pkg-notes"
                    value={form.notes}
                    onChange={(e) => update('notes', e.target.value)}
                    placeholder="One item per line"
                    className="mt-2 min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>

                <div>
                  <label className={labelCls} htmlFor="pkg-desc">Description</label>
                  <textarea
                    id="pkg-desc"
                    value={form.description}
                    onChange={(e) => update('description', e.target.value)}
                    placeholder="Brief description of the software"
                    className="mt-2 min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Sticky footer */}
        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="inline-flex h-9 items-center justify-center rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving
              ? form.source === 'file'
                ? 'Uploading…'
                : 'Creating…'
              : createdCatalogId.current
                ? 'Retry adding version'
                : 'Create package'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
