import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { Dialog } from "../shared/Dialog";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { runAction, handleActionError } from "@/lib/runAction";
import { navigateTo } from "@/lib/navigation";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

/**
 * AI for Office — prompt template manager (spec §9.5, §10). Templates surface
 * in the add-in's empty-chat picker (Plan-4 Task 6 client route). Scope:
 * orgId NULL = partner-wide ("All orgs") row, else org-scoped. Scope is
 * immutable after create (templateUpdateSchema has no orgId — Plan-4 Task 5;
 * move a template by delete + recreate).
 */

/** The four Office hosts a template can target. Empty/all ⇒ shown everywhere. */
const TEMPLATE_HOSTS = [
  { value: "excel", label: "Excel" },
  { value: "word", label: "Word" },
  { value: "powerpoint", label: "PowerPoint" },
  { value: "outlook", label: "Outlook" },
] as const;
type TemplateHost = (typeof TEMPLATE_HOSTS)[number]["value"];
const HOST_LABEL: Record<string, string> = Object.fromEntries(
  TEMPLATE_HOSTS.map((h) => [h.value, h.label]),
);

/** Row shape of GET /client-ai/admin/templates (Plan-4 Task 5). */
interface TemplateRow {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  orgName: string | null;
  name: string;
  description: string | null;
  promptBody: string;
  category: string | null;
  /** Host targeting: null ⇒ all apps; a subset ⇒ only those. */
  hosts: string[] | null;
  createdAt: string;
  updatedAt: string;
}

/** Compact app-target indicator for the list — "All apps" when unscoped. */
function HostBadges({ hosts }: { hosts: string[] | null }) {
  const { t } = useTranslation("ai");
  if (!hosts || hosts.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {t("templatesTab.allApps")}
      </span>
    );
  }
  return (
    <div
      className="flex flex-wrap gap-1"
      data-testid="ai-office-template-hosts"
    >
      {hosts.map((h) => (
        <span
          key={h}
          className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-1.5 py-0.5 chart-legend-xs text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-400"
        >
          {HOST_LABEL[h] ?? h}
        </span>
      ))}
    </div>
  );
}

type EditorState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; template: TemplateRow };

function ScopeBadge({ row }: { row: TemplateRow }) {
  const { t } = useTranslation("ai");
  if (row.orgId === null) {
    return (
      <span
        className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-400"
        data-testid="ai-office-template-scope-partner"
      >
        {t("templatesTab.allOrgs")}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600 dark:border-slate-500/30 dark:bg-slate-500/10 dark:text-slate-400"
      data-testid="ai-office-template-scope-org"
    >
      {row.orgName ?? t("templatesTab.org")}
    </span>
  );
}

export default function TemplatesTab() {
  const { t } = useTranslation("ai");
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [orgs, setOrgs] = useState<{ orgId: string; orgName: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [editor, setEditor] = useState<EditorState>({ mode: "closed" });
  const [deleting, setDeleting] = useState<TemplateRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoadError(false);
      const res = await fetchWithAuth("/client-ai/admin/templates");
      if (res.status === 401) {
        void navigateTo("/login", { replace: true });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data: TemplateRow[] };
      setRows(body.data ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Org options for the create-dialog scope selector.
  useEffect(() => {
    void fetchWithAuth("/client-ai/admin/orgs")
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              data?: { orgId: string; orgName: string }[];
            }>)
          : null,
      )
      .then((b) => {
        if (b?.data)
          setOrgs(b.data.map(({ orgId, orgName }) => ({ orgId, orgName })));
      })
      .catch(() => {});
  }, []);

  const confirmDelete = async () => {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/client-ai/admin/templates/${deleting.id}`, {
            method: "DELETE",
          }),
        errorFallback: t("templatesTab.errors.delete"),
        successMessage: t("templatesTab.messages.deleted", {
          name: deleting.name,
        }),
        onUnauthorized: () => void navigateTo("/login", { replace: true }),
      });
      setDeleting(null);
      await load();
    } catch (err) {
      handleActionError(err, t("templatesTab.errors.delete"));
    } finally {
      setDeleteBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div
        className="rounded-lg border bg-card p-6 text-sm text-muted-foreground"
        data-testid="ai-office-templates-load-error"
      >
        {t("templatesTab.errors.load")}{" "}
        <button
          type="button"
          className="text-primary underline"
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          {t("common:actions.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">{t("templatesTab.title")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("templatesTab.description")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEditor({ mode: "create" })}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            data-testid="ai-office-template-create"
          >
            <Plus className="h-4 w-4" /> {t("templatesTab.newTemplate")}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2">{t("common:labels.name")}</th>
                <th className="px-4 py-2">{t("templatesTab.columns.scope")}</th>
                <th className="px-4 py-2">{t("templatesTab.columns.apps")}</th>
                <th className="px-4 py-2">
                  {t("templatesTab.columns.category")}
                </th>
                <th className="px-4 py-2">
                  {t("templatesTab.columns.updated")}
                </th>
                <th className="px-4 py-2 text-right">
                  {t("common:labels.actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b last:border-0 hover:bg-muted/20"
                  data-testid={`ai-office-template-row-${row.id}`}
                >
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{row.name}</p>
                    {row.description && (
                      <p className="max-w-[360px] truncate text-xs text-muted-foreground">
                        {row.description}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <ScopeBadge row={row} />
                  </td>
                  <td className="px-4 py-2.5">
                    <HostBadges hosts={row.hosts} />
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {row.category ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {new Date(row.updatedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setEditor({ mode: "edit", template: row })
                        }
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                        data-testid={`ai-office-template-edit-${row.id}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />{" "}
                        {t("common:actions.edit")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleting(row)}
                        className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                        data-testid={`ai-office-template-delete-${row.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />{" "}
                        {t("common:actions.delete")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    {t("templatesTab.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editor.mode !== "closed" && (
        <TemplateEditorDialog
          state={editor}
          orgs={orgs}
          onClose={() => setEditor({ mode: "closed" })}
          onSaved={() => {
            setEditor({ mode: "closed" });
            void load();
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
        title={t("templatesTab.deleteDialog.title")}
        message={
          deleting
            ? t("templatesTab.deleteDialog.message", { name: deleting.name })
            : ""
        }
        confirmLabel={t("common:actions.delete")}
        isLoading={deleteBusy}
        confirmTestId="ai-office-template-delete-confirm"
      />
    </div>
  );
}

// ── Create/edit dialog ────────────────────────────────────────────────────────

function TemplateEditorDialog({
  state,
  orgs,
  onClose,
  onSaved,
}: {
  state: Exclude<EditorState, { mode: "closed" }>;
  orgs: { orgId: string; orgName: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation("ai");
  const editing = state.mode === "edit" ? state.template : null;
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [category, setCategory] = useState(editing?.category ?? "");
  const [body, setBody] = useState(editing?.promptBody ?? "");
  // 'partner' or an orgId. Immutable in edit mode (templateUpdateSchema has no
  // orgId — Plan-4 Task 5).
  const [scope, setScope] = useState<string>(
    editing ? (editing.orgId ?? "partner") : "partner",
  );
  // Host targeting — empty array ⇒ "all apps" (server canonicalizes to null).
  const [hosts, setHosts] = useState<TemplateHost[]>(
    (editing?.hosts as TemplateHost[] | null | undefined) ?? [],
  );
  const [saving, setSaving] = useState(false);

  const toggleHost = (host: TemplateHost) =>
    setHosts((prev) =>
      prev.includes(host) ? prev.filter((h) => h !== host) : [...prev, host],
    );

  const valid = name.trim().length > 0 && body.trim().length > 0;

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      if (editing) {
        // templateUpdateSchema: name/description/promptBody/category only.
        await runAction({
          request: () =>
            fetchWithAuth(`/client-ai/admin/templates/${editing.id}`, {
              method: "PUT",
              body: JSON.stringify({
                name: name.trim(),
                description: description.trim() ? description.trim() : null,
                promptBody: body,
                category: category.trim() ? category.trim() : null,
                hosts,
              }),
            }),
          errorFallback: t("templatesTab.errors.update"),
          successMessage: t("templatesTab.messages.updated"),
          onUnauthorized: () => void navigateTo("/login", { replace: true }),
        });
      } else {
        // templateBodySchema: orgId null ⇒ partner-wide row. A 403
        // partner_scope_required (org-scope caller) surfaces via the toast.
        await runAction({
          request: () =>
            fetchWithAuth("/client-ai/admin/templates", {
              method: "POST",
              body: JSON.stringify({
                name: name.trim(),
                description: description.trim() ? description.trim() : null,
                promptBody: body,
                category: category.trim() ? category.trim() : null,
                hosts,
                orgId: scope === "partner" ? null : scope,
              }),
            }),
          errorFallback: t("templatesTab.errors.create"),
          successMessage: t("templatesTab.messages.created"),
          onUnauthorized: () => void navigateTo("/login", { replace: true }),
        });
      }
      onSaved();
    } catch (err) {
      handleActionError(
        err,
        editing
          ? t("templatesTab.errors.update")
          : t("templatesTab.errors.create"),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        editing ? t("templatesTab.editTemplate") : t("templatesTab.newTemplate")
      }
      maxWidth="3xl"
      className="p-6"
    >
      <h2 className="text-lg font-semibold">
        {editing
          ? t("templatesTab.editTemplate")
          : t("templatesTab.newTemplate")}
      </h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-muted-foreground">
            {t("common:labels.name")}
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            data-testid="ai-office-template-name"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">
            {t("templatesTab.columns.category")}
          </span>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            maxLength={100}
            placeholder={t("templatesTab.categoryPlaceholder")}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            data-testid="ai-office-template-category"
          />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="text-muted-foreground">
            {t("common:labels.description")}
          </span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            data-testid="ai-office-template-description"
          />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="text-muted-foreground">
            {t("templatesTab.promptBody")}
          </span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            maxLength={20000}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
            data-testid="ai-office-template-body"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">
            {t("templatesTab.columns.scope")}
          </span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={editing !== null}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60"
            data-testid="ai-office-template-scope"
          >
            <option value="partner">{t("templatesTab.partnerWide")}</option>
            {orgs.map((o) => (
              <option key={o.orgId} value={o.orgId}>
                {o.orgName}
              </option>
            ))}
          </select>
          {editing !== null && (
            <span className="mt-1 block text-xs text-muted-foreground">
              {t("templatesTab.scopeImmutable")}
            </span>
          )}
        </label>
        <div className="block text-sm">
          <span className="text-muted-foreground">
            {t("templatesTab.columns.apps")}
          </span>
          <div className="mt-1 flex flex-wrap gap-3 rounded-md border bg-background px-3 py-2">
            {TEMPLATE_HOSTS.map((h) => (
              <label
                key={h.value}
                className="inline-flex items-center gap-1.5 text-sm"
              >
                <input
                  type="checkbox"
                  checked={hosts.includes(h.value)}
                  onChange={() => toggleHost(h.value)}
                  data-testid={`ai-office-template-host-${h.value}`}
                />
                {h.label}
              </label>
            ))}
          </div>
          <span className="mt-1 block text-xs text-muted-foreground">
            {t("templatesTab.appsHint")}
          </span>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          {t("common:actions.cancel")}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!valid || saving}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          data-testid="ai-office-template-save"
        >
          {saving
            ? t("common:states.saving")
            : editing
              ? t("templatesTab.saveChanges")
              : t("templatesTab.createTemplate")}
        </button>
      </div>
    </Dialog>
  );
}
