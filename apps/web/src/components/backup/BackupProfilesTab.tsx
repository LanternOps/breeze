import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Server,
  Laptop,
  Command,
  Terminal,
  FilePlus2,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  ArrowLeft,
} from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, ActionError, handleActionError } from "@/lib/runAction";
import { i18n } from "@/lib/i18n";
import {
  ToggleRow,
  FieldError,
  PathList,
} from "../configurationPolicies/featureTabs/backupTabPrimitives";
import { createOsPresets } from "../configurationPolicies/featureTabs/backupTabPresets";

// ── Types ──────────────────────────────────────────────────────────────────────
export type BackupProfile = {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
  description: string | null;
  selections: Record<string, unknown>;
  isActive: boolean;
  inUseByPolicies: number;
  createdAt: string;
  updatedAt: string;
};

type DraftSelections = {
  file: { enabled: boolean; paths: string[]; excludes: string[] };
  system_image: { enabled: boolean; includeSystemState: boolean };
  mssql: { enabled: boolean; backupType: string; excludeDatabases: string[] };
  hyperv: { enabled: boolean; consistencyType: string; excludeVms: string[] };
};

type Draft = {
  name: string;
  description: string;
  ownerScope: "organization" | "partner";
  isActive: boolean;
  selections: DraftSelections;
};

const emptySelections = (): DraftSelections => ({
  file: { enabled: false, paths: [], excludes: [] },
  system_image: { enabled: false, includeSystemState: true },
  mssql: { enabled: false, backupType: "full", excludeDatabases: [] },
  hyperv: { enabled: false, consistencyType: "application", excludeVms: [] },
});

function inflateSelections(stored: Record<string, unknown> | null | undefined): DraftSelections {
  const base = emptySelections();
  if (!stored || typeof stored !== "object") return base;
  const s = stored as Record<string, Record<string, unknown> | undefined>;
  if (s.file) {
    base.file = {
      enabled: s.file.enabled === true,
      paths: Array.isArray(s.file.paths) ? (s.file.paths as string[]) : [],
      excludes: Array.isArray(s.file.excludes) ? (s.file.excludes as string[]) : [],
    };
  }
  if (s.system_image) {
    base.system_image = {
      enabled: s.system_image.enabled === true,
      includeSystemState: s.system_image.includeSystemState !== false,
    };
  }
  if (s.mssql) {
    base.mssql = {
      enabled: s.mssql.enabled === true,
      backupType: typeof s.mssql.backupType === "string" ? s.mssql.backupType : "full",
      excludeDatabases: Array.isArray(s.mssql.excludeDatabases)
        ? (s.mssql.excludeDatabases as string[])
        : [],
    };
  }
  if (s.hyperv) {
    base.hyperv = {
      enabled: s.hyperv.enabled === true,
      consistencyType:
        typeof s.hyperv.consistencyType === "string" ? s.hyperv.consistencyType : "application",
      excludeVms: Array.isArray(s.hyperv.excludeVms) ? (s.hyperv.excludeVms as string[]) : [],
    };
  }
  return base;
}

/** Enabled-source chip labels for a selections object (list rows + policy picker). */
export function selectionChips(selections: Record<string, unknown> | null | undefined): string[] {
  const s = (selections ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const chips: string[] = [];
  if (s.file?.enabled === true) chips.push(i18n.t("backup:profiles.sourceFile"));
  if (s.system_image?.enabled === true) chips.push(i18n.t("backup:profiles.sourceSystemState"));
  if (s.mssql?.enabled === true) chips.push(i18n.t("backup:profiles.sourceSql"));
  if (s.hyperv?.enabled === true) chips.push(i18n.t("backup:profiles.sourceHyperv"));
  return chips;
}

// ── Creation templates (the #2415 OS presets, promoted) ───────────────────────
type Template = {
  id: string;
  icon: typeof Server;
  title: string;
  description: string;
  build: () => DraftSelections;
};

function createTemplates(): Template[] {
  const presets = createOsPresets();
  const byId = new Map(presets.map((preset) => [preset.id, preset]));
  const windows = byId.get("windows");
  const macos = byId.get("macos");
  const linux = byId.get("linux");
  return [
    {
      id: "server",
      icon: Server,
      title: i18n.t("backup:profiles.tmplServerTitle"),
      description: i18n.t("backup:profiles.tmplServerDesc"),
      build: () => ({
        ...emptySelections(),
        file: {
          enabled: true,
          paths: [...(windows?.paths ?? [])],
          excludes: [...(windows?.excludes ?? [])],
        },
        system_image: { enabled: true, includeSystemState: true },
        mssql: { enabled: true, backupType: "full", excludeDatabases: ["tempdb"] },
      }),
    },
    {
      id: "windows-workstation",
      icon: Laptop,
      title: i18n.t("backup:profiles.tmplWindowsWsTitle"),
      description: i18n.t("backup:profiles.tmplWindowsWsDesc"),
      build: () => ({
        ...emptySelections(),
        file: {
          enabled: true,
          paths: [...(windows?.paths ?? [])],
          excludes: [...(windows?.excludes ?? [])],
        },
      }),
    },
    {
      id: "macos-workstation",
      icon: Command,
      title: i18n.t("backup:profiles.tmplMacosWsTitle"),
      description: i18n.t("backup:profiles.tmplMacosWsDesc"),
      build: () => ({
        ...emptySelections(),
        file: {
          enabled: true,
          paths: [...(macos?.paths ?? [])],
          excludes: [...(macos?.excludes ?? [])],
        },
      }),
    },
    {
      id: "linux-server",
      icon: Terminal,
      title: i18n.t("backup:profiles.tmplLinuxServerTitle"),
      description: i18n.t("backup:profiles.tmplLinuxServerDesc"),
      build: () => ({
        ...emptySelections(),
        file: {
          enabled: true,
          paths: [...(linux?.paths ?? [])],
          excludes: [...(linux?.excludes ?? [])],
        },
      }),
    },
    {
      id: "blank",
      icon: FilePlus2,
      title: i18n.t("backup:profiles.tmplBlankTitle"),
      description: i18n.t("backup:profiles.tmplBlankDesc"),
      build: emptySelections,
    },
  ];
}

function buildSelectionsPayload(selections: DraftSelections): Record<string, unknown> {
  return {
    file: {
      enabled: selections.file.enabled,
      paths: selections.file.paths,
      excludes: selections.file.excludes,
    },
    system_image: {
      enabled: selections.system_image.enabled,
      includeSystemState: selections.system_image.includeSystemState,
    },
    mssql: {
      enabled: selections.mssql.enabled,
      backupType: selections.mssql.backupType,
      excludeDatabases: selections.mssql.excludeDatabases,
    },
    hyperv: {
      enabled: selections.hyperv.enabled,
      consistencyType: selections.hyperv.consistencyType,
      excludeVms: selections.hyperv.excludeVms,
    },
  };
}

// ── Source section wrapper (flat editor: all four always visible) ─────────────
function SourceSection({
  title,
  description,
  enabled,
  onToggle,
  children,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={title}
          onClick={() => onToggle(!enabled)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full border transition focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ${enabled ? "bg-emerald-500/80" : "bg-muted"}`}
        >
          <span
            className={`inline-block h-5 w-5 rounded-full bg-white transition ${enabled ? "translate-x-5" : "translate-x-1"}`}
          />
        </button>
      </div>
      {enabled && children && (
        <div className="space-y-4 border-t px-4 py-4">{children}</div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function BackupProfilesTab() {
  useTranslation("backup");
  const [profiles, setProfiles] = useState<BackupProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [view, setView] = useState<"list" | "templates" | "editor">("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({
    name: "",
    description: "",
    ownerScope: "organization",
    isActive: true,
    selections: emptySelections(),
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BackupProfile | null>(null);
  const [deleteBlockedBy, setDeleteBlockedBy] = useState<
    { policyId: string; policyName: string }[] | null
  >(null);

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const response = await fetchWithAuth("/backup/profiles?includeInactive=true");
      if (!response.ok) throw new Error(String(response.status));
      const payload = await response.json();
      setProfiles(Array.isArray(payload.data) ? payload.data : []);
    } catch {
      setLoadError(i18n.t("backup:profiles.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  const templates = createTemplates();

  const startFromTemplate = (template: Template) => {
    setEditingId(null);
    setDraft({
      name: "",
      description: "",
      ownerScope: "organization",
      isActive: true,
      selections: template.build(),
    });
    setFieldErrors({});
    setView("editor");
  };

  const startEdit = (profile: BackupProfile) => {
    setEditingId(profile.id);
    setDraft({
      name: profile.name,
      description: profile.description ?? "",
      ownerScope: profile.partnerId ? "partner" : "organization",
      isActive: profile.isActive,
      selections: inflateSelections(profile.selections),
    });
    setFieldErrors({});
    setView("editor");
  };

  const updateSelections = <K extends keyof DraftSelections>(
    source: K,
    patch: Partial<DraftSelections[K]>,
  ) => {
    setDraft((prev) => ({
      ...prev,
      selections: {
        ...prev.selections,
        [source]: { ...prev.selections[source], ...patch },
      },
    }));
  };

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    if (!draft.name.trim()) {
      errors.name = i18n.t("backup:profiles.nameRequired");
    }
    const anyEnabled =
      draft.selections.file.enabled ||
      draft.selections.system_image.enabled ||
      draft.selections.mssql.enabled ||
      draft.selections.hyperv.enabled;
    if (!anyEnabled) {
      errors.sources = i18n.t("backup:profiles.needSource");
    }
    if (draft.selections.file.enabled && draft.selections.file.paths.length === 0) {
      errors.filePaths = i18n.t("backup:profiles.needPaths");
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const body = editingId
        ? {
            name: draft.name.trim(),
            description: draft.description.trim() || null,
            isActive: draft.isActive,
            selections: buildSelectionsPayload(draft.selections),
          }
        : {
            name: draft.name.trim(),
            ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
            ownerScope: draft.ownerScope,
            isActive: draft.isActive,
            selections: buildSelectionsPayload(draft.selections),
          };
      await runAction({
        request: () =>
          fetchWithAuth(editingId ? `/backup/profiles/${editingId}` : "/backup/profiles", {
            method: editingId ? "PATCH" : "POST",
            body: JSON.stringify(body),
          }),
        errorFallback: editingId
          ? i18n.t("backup:profiles.updateFailed")
          : i18n.t("backup:profiles.createFailed"),
        successMessage: editingId
          ? i18n.t("backup:profiles.updated")
          : i18n.t("backup:profiles.created"),
      });
      setView("list");
      setEditingId(null);
      await fetchProfiles();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        handleActionError(err, i18n.t("backup:profiles.createFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (profile: BackupProfile) => {
    setDeleteBlockedBy(null);
    try {
      await runAction({
        request: () => fetchWithAuth(`/backup/profiles/${profile.id}`, { method: "DELETE" }),
        errorFallback: i18n.t("backup:profiles.deleteFailed"),
        successMessage: i18n.t("backup:profiles.deleted"),
      });
      setDeleteTarget(null);
      await fetchProfiles();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError && err.status === 409) {
        // In-use race (a policy linked it since the list loaded). The toast
        // already fired; flip the inline panel to the in-use message and
        // refresh counts.
        setDeleteBlockedBy([]);
        await fetchProfiles();
        return;
      }
      if (!(err instanceof ActionError)) {
        handleActionError(err, i18n.t("backup:profiles.deleteFailed"));
      }
    }
  };

  // ── List view ────────────────────────────────────────────────────────────────
  if (view === "list") {
    return (
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">
              {i18n.t("backup:profiles.title")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {i18n.t("backup:profiles.subtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setView("templates")}
            className="inline-flex shrink-0 items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            {i18n.t("backup:profiles.newProfile")}
          </button>
        </div>

        {loadError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {loading ? (
          <div className="space-y-2" aria-hidden>
            {[0, 1, 2].map((n) => (
              <div key={n} className="h-16 animate-pulse rounded-md border bg-muted/30" />
            ))}
          </div>
        ) : profiles.length === 0 ? (
          <div className="rounded-md border border-dashed p-6">
            <p className="text-sm font-medium">
              {i18n.t("backup:profiles.emptyTitle")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {i18n.t("backup:profiles.emptyBody")}
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {templates.map((template) => {
                const Icon = template.icon;
                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => startFromTemplate(template)}
                    className="flex flex-col gap-1 rounded-md border p-3 text-left transition hover:border-primary/40 hover:bg-primary/5 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      {template.title}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {template.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {profiles.map((profile) => (
              <div
                key={profile.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{profile.name}</span>
                    {profile.partnerId && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                        {i18n.t("backup:profiles.allOrgs")}
                      </span>
                    )}
                    {!profile.isActive && (
                      <span className="rounded-full bg-yellow-500/15 px-2 py-0.5 text-[10px] font-semibold text-yellow-700">
                        {i18n.t("common:states.inactive")}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {selectionChips(profile.selections).map((chip) => (
                      <span
                        key={chip}
                        className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                      >
                        {chip}
                      </span>
                    ))}
                    <span className="text-[11px] text-muted-foreground">
                      {i18n.t("backup:profiles.inUseCount", {
                        count: profile.inUseByPolicies,
                      })}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => startEdit(profile)}
                    className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition hover:bg-muted"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    {i18n.t("common:actions.edit")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteTarget(profile);
                      setDeleteBlockedBy(null);
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2.5 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {i18n.t("common:actions.delete")}
                  </button>
                </div>
                {deleteTarget?.id === profile.id && (
                  <div className="w-full rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800">
                    {profile.inUseByPolicies > 0 || deleteBlockedBy ? (
                      <p className="text-xs">
                        {i18n.t("backup:profiles.deleteInUse", {
                          count: profile.inUseByPolicies,
                        })}
                      </p>
                    ) : (
                      <>
                        <p className="text-xs">
                          {i18n.t("backup:profiles.deleteConfirmBody", {
                            name: profile.name,
                          })}
                        </p>
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            onClick={() => void handleDelete(profile)}
                            className="rounded-md border border-amber-600/40 bg-amber-600/10 px-3 py-1.5 text-xs font-medium text-amber-900"
                          >
                            {i18n.t("common:actions.delete")}
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(null)}
                            className="rounded-md border border-amber-600/40 bg-background px-3 py-1.5 text-xs font-medium text-amber-900"
                          >
                            {i18n.t("common:actions.cancel")}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Template picker ──────────────────────────────────────────────────────────
  if (view === "templates") {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setView("list")}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {i18n.t("common:actions.back")}
        </button>
        <div>
          <h2 className="text-lg font-semibold">
            {i18n.t("backup:profiles.templateTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {i18n.t("backup:profiles.templatePickPrompt")}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => {
            const Icon = template.icon;
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => startFromTemplate(template)}
                className="flex flex-col gap-1.5 rounded-md border p-4 text-left transition hover:border-primary/40 hover:bg-primary/5 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  {template.title}
                </span>
                <span className="text-xs text-muted-foreground">
                  {template.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Editor ───────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-3xl space-y-5">
      <button
        type="button"
        onClick={() => setView("list")}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {i18n.t("common:actions.back")}
      </button>

      <div>
        <h2 className="text-lg font-semibold">
          {editingId
            ? i18n.t("backup:profiles.editTitle")
            : i18n.t("backup:profiles.createTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {i18n.t("backup:profiles.editorSubtitle")}
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            {i18n.t("backup:profiles.nameLabel")}
          </label>
          <input
            value={draft.name}
            onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
            placeholder={i18n.t("backup:profiles.namePlaceholder")}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
          <FieldError message={fieldErrors.name} />
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground">
            {i18n.t("backup:profiles.descriptionLabel")}
          </label>
          <input
            value={draft.description}
            onChange={(e) =>
              setDraft((prev) => ({ ...prev, description: e.target.value }))
            }
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Ownership axis is create-only (immutable after, like every dual-axis table) */}
        {!editingId && (
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {i18n.t("backup:profiles.scopeLabel")}
            </label>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {(
                [
                  {
                    value: "organization" as const,
                    label: i18n.t("backup:profiles.scopeOrg"),
                    hint: i18n.t("backup:profiles.scopeOrgHint"),
                  },
                  {
                    value: "partner" as const,
                    label: i18n.t("backup:profiles.scopePartner"),
                    hint: i18n.t("backup:profiles.scopePartnerHint"),
                  },
                ] as const
              ).map((option) => (
                <label
                  key={option.value}
                  className={`flex cursor-pointer flex-col gap-0.5 rounded-md border p-3 text-sm transition has-focus-visible:ring-2 has-focus-visible:ring-ring ${
                    draft.ownerScope === option.value
                      ? "border-primary/40 bg-primary/10"
                      : "border-muted hover:border-muted-foreground/30"
                  }`}
                >
                  <input
                    type="radio"
                    name="profileOwnerScope"
                    value={option.value}
                    checked={draft.ownerScope === option.value}
                    onChange={() =>
                      setDraft((prev) => ({ ...prev, ownerScope: option.value }))
                    }
                    className="sr-only"
                  />
                  <span className="font-medium text-foreground">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.hint}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <ToggleRow
          label={i18n.t("backup:profiles.activeLabel")}
          description={i18n.t("backup:profiles.activeDescription")}
          checked={draft.isActive}
          onChange={(checked) => setDraft((prev) => ({ ...prev, isActive: checked }))}
        />
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">
            {i18n.t("backup:profiles.sourcesTitle")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {i18n.t("backup:profiles.sourcesSubtitle")}
          </p>
          <FieldError message={fieldErrors.sources} />
        </div>

        <SourceSection
          title={i18n.t("backup:profiles.sourceFile")}
          description={i18n.t("backup:profiles.fileDesc")}
          enabled={draft.selections.file.enabled}
          onToggle={(v) => updateSelections("file", { enabled: v })}
        >
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {i18n.t("backup:profiles.pathsLabel")}
            </label>
            <div className="mt-2">
              <PathList
                items={draft.selections.file.paths}
                onAdd={(value) =>
                  updateSelections("file", {
                    paths: [...draft.selections.file.paths, value],
                  })
                }
                onRemove={(value) =>
                  updateSelections("file", {
                    paths: draft.selections.file.paths.filter((p) => p !== value),
                  })
                }
                placeholder={i18n.t("backup:profiles.pathsPlaceholder")}
                emptyLabel={i18n.t("backup:profiles.noPaths")}
              />
            </div>
            <FieldError message={fieldErrors.filePaths} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {i18n.t("backup:profiles.excludesLabel")}
            </label>
            <div className="mt-2">
              <PathList
                items={draft.selections.file.excludes}
                onAdd={(value) =>
                  updateSelections("file", {
                    excludes: [...draft.selections.file.excludes, value],
                  })
                }
                onRemove={(value) =>
                  updateSelections("file", {
                    excludes: draft.selections.file.excludes.filter((p) => p !== value),
                  })
                }
                placeholder={i18n.t("backup:profiles.excludesPlaceholder")}
                emptyLabel={i18n.t("backup:profiles.noExcludes")}
              />
            </div>
          </div>
        </SourceSection>

        <SourceSection
          title={i18n.t("backup:profiles.sourceSystemState")}
          description={i18n.t("backup:profiles.systemStateDesc")}
          enabled={draft.selections.system_image.enabled}
          onToggle={(v) => updateSelections("system_image", { enabled: v })}
        >
          <ToggleRow
            label={i18n.t("backup:profiles.includeSystemStateLabel")}
            description={i18n.t("backup:profiles.includeSystemStateDesc")}
            checked={draft.selections.system_image.includeSystemState}
            onChange={(checked) =>
              updateSelections("system_image", { includeSystemState: checked })
            }
          />
        </SourceSection>

        <SourceSection
          title={i18n.t("backup:profiles.sourceSql")}
          description={i18n.t("backup:profiles.sqlDesc")}
          enabled={draft.selections.mssql.enabled}
          onToggle={(v) => updateSelections("mssql", { enabled: v })}
        >
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {i18n.t("backup:profiles.sqlBackupTypeLabel")}
            </label>
            <select
              value={draft.selections.mssql.backupType}
              onChange={(e) =>
                updateSelections("mssql", { backupType: e.target.value })
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="full">{i18n.t("backup:profiles.sqlFull")}</option>
              <option value="differential">
                {i18n.t("backup:profiles.sqlDifferential")}
              </option>
              <option value="log">{i18n.t("backup:profiles.sqlLog")}</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {i18n.t("backup:profiles.sqlExcludeDbLabel")}
            </label>
            <div className="mt-2">
              <PathList
                items={draft.selections.mssql.excludeDatabases}
                onAdd={(value) =>
                  updateSelections("mssql", {
                    excludeDatabases: [
                      ...draft.selections.mssql.excludeDatabases,
                      value,
                    ],
                  })
                }
                onRemove={(value) =>
                  updateSelections("mssql", {
                    excludeDatabases: draft.selections.mssql.excludeDatabases.filter(
                      (name) => name !== value,
                    ),
                  })
                }
                placeholder={i18n.t("backup:profiles.sqlExcludeDbPlaceholder")}
                emptyLabel={i18n.t("backup:profiles.noExcludedDbs")}
              />
            </div>
          </div>
        </SourceSection>

        <SourceSection
          title={i18n.t("backup:profiles.sourceHyperv")}
          description={i18n.t("backup:profiles.hypervDesc")}
          enabled={draft.selections.hyperv.enabled}
          onToggle={(v) => updateSelections("hyperv", { enabled: v })}
        >
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {i18n.t("backup:profiles.hypervConsistencyLabel")}
            </label>
            <select
              value={draft.selections.hyperv.consistencyType}
              onChange={(e) =>
                updateSelections("hyperv", { consistencyType: e.target.value })
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="application">
                {i18n.t("backup:profiles.hypervConsistencyApp")}
              </option>
              <option value="crash">
                {i18n.t("backup:profiles.hypervConsistencyCrash")}
              </option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {i18n.t("backup:profiles.hypervExcludeVmsLabel")}
            </label>
            <div className="mt-2">
              <PathList
                items={draft.selections.hyperv.excludeVms}
                onAdd={(value) =>
                  updateSelections("hyperv", {
                    excludeVms: [...draft.selections.hyperv.excludeVms, value],
                  })
                }
                onRemove={(value) =>
                  updateSelections("hyperv", {
                    excludeVms: draft.selections.hyperv.excludeVms.filter(
                      (name) => name !== value,
                    ),
                  })
                }
                placeholder={i18n.t("backup:profiles.hypervExcludeVmsPlaceholder")}
                emptyLabel={i18n.t("backup:profiles.noExcludedVms")}
              />
            </div>
          </div>
        </SourceSection>
      </div>

      <div className="flex items-center justify-end gap-2 border-t pt-4">
        <button
          type="button"
          onClick={() => setView("list")}
          className="rounded-md border px-4 py-2 text-sm font-medium transition hover:bg-muted"
        >
          {i18n.t("common:actions.cancel")}
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {i18n.t("common:actions.save")}
        </button>
      </div>
    </div>
  );
}
