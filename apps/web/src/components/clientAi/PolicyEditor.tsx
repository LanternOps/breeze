import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { showToast } from "../shared/Toast";
import { runAction, handleActionError } from "@/lib/runAction";
import { navigateTo } from "@/lib/navigation";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

/**
 * AI for Office — per-org policy editor (spec §9.2). Reached via
 * #policy/<orgId> from the OrgsTab. Endpoints (Plan 1 + Plan-4 Task 2):
 *   GET /client-ai/admin/orgs/:orgId/policy  → { policy }
 *   PUT /client-ai/admin/orgs/:orgId/policy  ← putPolicySchema (STRICT — keys below only)
 *   GET /client-ai/admin/orgs/:orgId/users   → { data: entra portal users } (decision 9)
 * The dlpConfig payload is the Plan-4 Task-1 clientAiDlpConfigSchema contract.
 */

type DlpAction = "redact" | "block" | "log" | "off";
type DlpBuiltinKey =
  | "creditCard"
  | "ssn"
  | "iban"
  | "apiKey"
  | "email"
  | "phone";
type CustomRule = {
  id: string;
  name: string;
  pattern: string;
  action: DlpAction;
};

const DLP_ACTIONS: { value: DlpAction; label: string }[] = [
  { value: "redact", label: "Redact" },
  { value: "block", label: "Block request" },
  { value: "log", label: "Log only" },
  { value: "off", label: "Off" },
];

// Mirrors CLIENT_AI_DLP_DEFAULT_BUILTINS (apps/api/src/routes/clientAi/schemas.ts,
// Plan-4 Task 1): redact financial/credential types, email/phone off (spec §6).
const DLP_BUILTINS: {
  key: DlpBuiltinKey;
  label: string;
  defaultAction: DlpAction;
}[] = [
  {
    key: "creditCard",
    label: "Credit card numbers (Luhn-validated)",
    defaultAction: "redact",
  },
  { key: "ssn", label: "SSN / national IDs", defaultAction: "redact" },
  { key: "iban", label: "IBAN account numbers", defaultAction: "redact" },
  { key: "apiKey", label: "API keys & tokens", defaultAction: "redact" },
  { key: "email", label: "Email addresses", defaultAction: "off" },
  { key: "phone", label: "Phone numbers", defaultAction: "off" },
];

// The models priced in apps/api/src/services/aiCostTracker.ts:17-18. Empty
// selection = all available models (Plan-1 default allowedModels: []).
const KNOWN_MODELS: { id: string; label: string }[] = [
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

interface PolicyDto {
  orgId: string;
  enabled: boolean;
  userAccess: "all" | "selected";
  selectedUserIds: string[];
  allowedProviders: string[];
  allowedModels: string[];
  writeMode: "readwrite" | "readonly";
  writeApproval?: "ask" | "allow_auto";
  dlpConfig: {
    builtins?: Partial<Record<DlpBuiltinKey, DlpAction>>;
    customRules?: CustomRule[];
  } | null;
  dailyBudgetCents: number | null;
  monthlyBudgetCents: number | null;
  perUserMessagesPerMinute: number;
  orgMessagesPerHour: number;
  retentionDays: number | null;
  branding: { displayName?: string | null; logoUrl?: string | null } | null;
}

interface EntraUser {
  id: string;
  email: string;
  name: string | null;
  lastLoginAt: string | null;
}

function defaultBuiltins(): Record<DlpBuiltinKey, DlpAction> {
  return Object.fromEntries(
    DLP_BUILTINS.map((b) => [b.key, b.defaultAction]),
  ) as Record<DlpBuiltinKey, DlpAction>;
}

/** Live regex test (spec §9.2): compile client-side, count matches in the sample. */
export function testPattern(
  pattern: string,
  sample: string,
): { ok: true; matches: number } | { ok: false; error: string } {
  try {
    const re = new RegExp(pattern, "g");
    return { ok: true, matches: sample ? (sample.match(re) ?? []).length : 0 };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Invalid pattern",
    };
  }
}

export default function PolicyEditor({
  orgId,
  onBack,
}: {
  orgId: string;
  onBack: () => void;
}) {
  const { t } = useTranslation("ai");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [orgUsers, setOrgUsers] = useState<EntraUser[]>([]);

  // Form state — buildPayload() below is the single source of the PUT body.
  const [enabled, setEnabled] = useState(false);
  const [userAccess, setUserAccess] = useState<"all" | "selected">("all");
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [writeMode, setWriteMode] = useState<"readwrite" | "readonly">(
    "readwrite",
  );
  const [writeApproval, setWriteApproval] = useState<"ask" | "allow_auto">(
    "ask",
  );
  const [builtins, setBuiltins] =
    useState<Record<DlpBuiltinKey, DlpAction>>(defaultBuiltins);
  const [customRules, setCustomRules] = useState<CustomRule[]>([]);
  const [dailyBudgetDollars, setDailyBudgetDollars] = useState("");
  const [monthlyBudgetDollars, setMonthlyBudgetDollars] = useState("");
  const [perUserPerMinute, setPerUserPerMinute] = useState("10");
  const [orgPerHour, setOrgPerHour] = useState("500");
  const [retentionDays, setRetentionDays] = useState("");
  const [brandDisplayName, setBrandDisplayName] = useState("");
  const [brandLogoUrl, setBrandLogoUrl] = useState("");
  const [dlpSample, setDlpSample] = useState("");

  const load = useCallback(async () => {
    try {
      setLoadError(false);
      const [policyRes, usersRes] = await Promise.all([
        fetchWithAuth(`/client-ai/admin/orgs/${orgId}/policy`),
        fetchWithAuth(`/client-ai/admin/orgs/${orgId}/users`),
      ]);
      if (policyRes.status === 401 || usersRes.status === 401) {
        void navigateTo("/login", { replace: true });
        return;
      }
      if (!policyRes.ok) throw new Error(`HTTP ${policyRes.status}`);
      const { policy } = (await policyRes.json()) as { policy: PolicyDto };
      setEnabled(policy.enabled);
      setUserAccess(policy.userAccess);
      setSelectedUserIds(policy.selectedUserIds ?? []);
      setAllowedModels(policy.allowedModels ?? []);
      setWriteMode(policy.writeMode);
      // Default-deny: anything other than the explicit 'allow_auto' is 'ask'.
      setWriteApproval(
        policy.writeApproval === "allow_auto" ? "allow_auto" : "ask",
      );
      const cfg = policy.dlpConfig ?? {};
      setBuiltins({ ...defaultBuiltins(), ...(cfg.builtins ?? {}) });
      setCustomRules(cfg.customRules ?? []);
      setDailyBudgetDollars(
        policy.dailyBudgetCents != null
          ? (policy.dailyBudgetCents / 100).toFixed(2)
          : "",
      );
      setMonthlyBudgetDollars(
        policy.monthlyBudgetCents != null
          ? (policy.monthlyBudgetCents / 100).toFixed(2)
          : "",
      );
      setPerUserPerMinute(String(policy.perUserMessagesPerMinute));
      setOrgPerHour(String(policy.orgMessagesPerHour));
      setRetentionDays(
        policy.retentionDays != null ? String(policy.retentionDays) : "",
      );
      const branding = policy.branding ?? {};
      setBrandDisplayName(branding.displayName ?? "");
      setBrandLogoUrl(branding.logoUrl ?? "");
      if (usersRes.ok) {
        const usersBody = (await usersRes.json()) as { data: EntraUser[] };
        setOrgUsers(usersBody.data ?? []);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const ruleResults = useMemo(
    () =>
      new Map(
        customRules.map((r) => [r.id, testPattern(r.pattern, dlpSample)]),
      ),
    [customRules, dlpSample],
  );

  const dollarsToCents = (v: string): number | null => {
    const t = v.trim();
    if (!t) return null;
    const n = Number.parseFloat(t);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  };
  const toInt = (v: string, fallback: number): number => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  /** Exactly putPolicySchema's keys (Plan 1; dlpConfig tightened by Plan-4 Task 1). */
  const buildPayload = () => ({
    enabled,
    userAccess,
    selectedUserIds: userAccess === "selected" ? selectedUserIds : [],
    allowedModels,
    writeMode,
    writeApproval,
    dlpConfig: {
      builtins,
      customRules: customRules.map((r) => ({
        id: r.id,
        name: r.name.trim(),
        pattern: r.pattern,
        action: r.action,
      })),
    },
    dailyBudgetCents: dollarsToCents(dailyBudgetDollars),
    monthlyBudgetCents: dollarsToCents(monthlyBudgetDollars),
    perUserMessagesPerMinute: toInt(perUserPerMinute, 10),
    orgMessagesPerHour: toInt(orgPerHour, 500),
    retentionDays: retentionDays.trim() ? toInt(retentionDays, 1) : null,
    branding: {
      displayName: brandDisplayName.trim() || null,
      logoUrl: brandLogoUrl.trim() || null,
    },
  });

  const save = async () => {
    if (saving) return;
    // Client-side pre-validation of the DLP contract (the server schema
    // rejects non-compiling patterns with a 400 — fail here with a clear toast).
    for (const rule of customRules) {
      if (!rule.name.trim()) {
        showToast({
          type: "error",
          message: t("policyEditor.errors.ruleNameRequired"),
        });
        return;
      }
      const result = testPattern(rule.pattern, "");
      if (!result.ok) {
        showToast({
          type: "error",
          message: t("policyEditor.errors.invalidPattern", {
            ruleName: rule.name,
          }),
        });
        return;
      }
    }
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/client-ai/admin/orgs/${orgId}/policy`, {
            method: "PUT",
            body: JSON.stringify(buildPayload()),
          }),
        errorFallback: t("policyEditor.errors.save"),
        successMessage: t("policyEditor.messages.saved"),
        onUnauthorized: () => void navigateTo("/login", { replace: true }),
      });
    } catch (err) {
      handleActionError(err, t("policyEditor.errors.save"));
    } finally {
      setSaving(false);
    }
  };

  const toggleModel = (id: string) =>
    setAllowedModels((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id],
    );
  const toggleUser = (id: string) =>
    setSelectedUserIds((prev) =>
      prev.includes(id) ? prev.filter((u) => u !== id) : [...prev, id],
    );
  const updateRule = (id: string, patch: Partial<CustomRule>) =>
    setCustomRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  const addRule = () =>
    setCustomRules((prev) => [
      ...prev,
      { id: crypto.randomUUID(), name: "", pattern: "", action: "redact" },
    ]);
  const removeRule = (id: string) =>
    setCustomRules((prev) => prev.filter((r) => r.id !== id));

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
        data-testid="ai-office-policy-load-error"
      >
        {t("policyEditor.errors.load")}{" "}
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
    <div className="space-y-6" data-testid="ai-office-policy-editor">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-sm hover:bg-muted"
          data-testid="ai-office-policy-back"
        >
          <ArrowLeft className="h-4 w-4" /> {t("policyEditor.organizations")}
        </button>
        <div>
          <h2 className="text-lg font-semibold">{t("policyEditor.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("policyEditor.description")}
          </p>
        </div>
      </div>

      {/* General */}
      <section className="rounded-lg border bg-card p-6">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t("policyEditor.sections.general")}
        </h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">
              {t("policyEditor.assistant")}
            </span>
            <select
              value={enabled ? "true" : "false"}
              onChange={(e) => setEnabled(e.target.value === "true")}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-enabled"
            >
              <option value="true">{t("common:states.enabled")}</option>
              <option value="false">{t("common:states.disabled")}</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">
              {t("policyEditor.workbookAccess")}
            </span>
            <select
              value={writeMode}
              onChange={(e) =>
                setWriteMode(e.target.value as "readwrite" | "readonly")
              }
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-writemode"
            >
              <option value="readwrite">
                {t("policyEditor.workbookAccessOptions.readWrite")}
              </option>
              <option value="readonly">
                {t("policyEditor.workbookAccessOptions.readOnly")}
              </option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">
              {t("policyEditor.workbookWrites")}
            </span>
            <select
              value={writeApproval}
              onChange={(e) =>
                setWriteApproval(e.target.value as "ask" | "allow_auto")
              }
              disabled={writeMode === "readonly"}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-50"
              data-testid="ai-office-policy-writeapproval"
            >
              <option value="ask">{t("policyEditor.writeOptions.ask")}</option>
              <option value="allow_auto">
                {t("policyEditor.writeOptions.allowAuto")}
              </option>
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("policyEditor.autoApplyHint")}
            </p>
          </label>
          <div className="text-sm">
            <span className="text-muted-foreground">
              {t("policyEditor.allowedModels")}
            </span>
            <div className="mt-1 space-y-1.5">
              {KNOWN_MODELS.map((m) => (
                <label key={m.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={allowedModels.includes(m.id)}
                    onChange={() => toggleModel(m.id)}
                    className="rounded border-border"
                    data-testid={`ai-office-policy-model-${m.id}`}
                  />
                  {m.label}
                </label>
              ))}
              <p className="text-xs text-muted-foreground">
                {t("policyEditor.allModelsHint")}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* User access */}
      <section className="rounded-lg border bg-card p-6">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t("policyEditor.sections.userAccess")}
        </h3>
        <label className="block max-w-xs text-sm">
          <span className="text-muted-foreground">
            {t("policyEditor.whoCanUse")}
          </span>
          <select
            value={userAccess}
            onChange={(e) =>
              setUserAccess(e.target.value as "all" | "selected")
            }
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            data-testid="ai-office-policy-useraccess"
          >
            <option value="all">
              {t("policyEditor.userAccessOptions.all")}
            </option>
            <option value="selected">
              {t("policyEditor.userAccessOptions.selected")}
            </option>
          </select>
        </label>
        {userAccess === "selected" && (
          <div
            className="mt-3 max-h-56 space-y-1.5 overflow-y-auto rounded-md border p-3"
            data-testid="ai-office-policy-userlist"
          >
            {orgUsers.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t("policyEditor.noUsersHint")}
              </p>
            )}
            {orgUsers.map((u) => (
              <label key={u.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedUserIds.includes(u.id)}
                  onChange={() => toggleUser(u.id)}
                  className="rounded border-border"
                  data-testid={`ai-office-policy-user-${u.id}`}
                />
                <span>{u.email}</span>
                {u.name && (
                  <span className="text-xs text-muted-foreground">
                    {u.name}
                  </span>
                )}
              </label>
            ))}
          </div>
        )}
      </section>

      {/* Budgets & rate limits */}
      <section className="rounded-lg border bg-card p-6">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t("policyEditor.sections.budgets")}
        </h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">
              {t("policyEditor.dailyBudget")}
            </span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={dailyBudgetDollars}
              onChange={(e) => setDailyBudgetDollars(e.target.value)}
              placeholder={t("policyEditor.noLimit")}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-daily-budget"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">
              {t("policyEditor.monthlyBudget")}
            </span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={monthlyBudgetDollars}
              onChange={(e) => setMonthlyBudgetDollars(e.target.value)}
              placeholder={t("policyEditor.noLimit")}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-monthly-budget"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">
              {t("policyEditor.messagesPerMinute")}
            </span>
            <input
              type="number"
              min="1"
              max="600"
              value={perUserPerMinute}
              onChange={(e) => setPerUserPerMinute(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-per-user-rate"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">
              {t("policyEditor.messagesPerHour")}
            </span>
            <input
              type="number"
              min="1"
              value={orgPerHour}
              onChange={(e) => setOrgPerHour(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-org-rate"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">
              {t("policyEditor.retentionDays")}
            </span>
            <input
              type="number"
              min="1"
              max="3650"
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              placeholder={t("policyEditor.keepForever")}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-retention"
            />
          </label>
        </div>
      </section>

      {/* Branding */}
      <section className="rounded-lg border bg-card p-6">
        <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t("policyEditor.sections.branding")}
        </h3>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("policyEditor.brandingDescription")}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-muted-foreground">
              {t("policyEditor.displayName")}
            </span>
            <input
              type="text"
              value={brandDisplayName}
              onChange={(e) => setBrandDisplayName(e.target.value)}
              placeholder={t("policyEditor.mspNamePlaceholder")}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-brand-name"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">
              {t("policyEditor.logoUrl")}
            </span>
            <input
              type="url"
              value={brandLogoUrl}
              onChange={(e) => setBrandLogoUrl(e.target.value)}
              placeholder="https://…/logo.png"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="ai-office-policy-brand-logo"
            />
          </label>
        </div>
      </section>

      {/* DLP */}
      <section className="rounded-lg border bg-card p-6">
        <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t("policyEditor.sections.dlp")}
        </h3>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("policyEditor.dlpDescription")}
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {DLP_BUILTINS.map((b) => (
            <label key={b.key} className="block text-sm">
              <span className="text-muted-foreground">
                {t(`policyEditor.builtins.${b.key}`)}
              </span>{" "}
              {/* i18n-dynamic */}
              <select
                value={builtins[b.key]}
                onChange={(e) =>
                  setBuiltins((prev) => ({
                    ...prev,
                    [b.key]: e.target.value as DlpAction,
                  }))
                }
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                data-testid={`ai-office-policy-dlp-${b.key}`}
              >
                {DLP_ACTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {t(`policyEditor.actions.${a.value}`)} {/* i18n-dynamic */}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        <div className="mt-6">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">
              {t("policyEditor.customRules")}
            </h4>
            <button
              type="button"
              onClick={addRule}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
              data-testid="ai-office-policy-dlp-add-rule"
            >
              <Plus className="h-3.5 w-3.5" /> {t("policyEditor.addRule")}
            </button>
          </div>
          {customRules.length > 0 && (
            <label className="mt-3 block text-sm">
              <span className="text-muted-foreground">
                {t("policyEditor.testSample")}
              </span>
              <textarea
                value={dlpSample}
                onChange={(e) => setDlpSample(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
                data-testid="ai-office-policy-dlp-sample"
              />
            </label>
          )}
          <div className="mt-3 space-y-3">
            {customRules.map((rule, idx) => {
              const result = ruleResults.get(rule.id);
              return (
                <div
                  key={rule.id}
                  className="rounded-md border p-3"
                  data-testid={`ai-office-policy-dlp-rule-${idx}`}
                >
                  <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto_auto]">
                    <input
                      type="text"
                      value={rule.name}
                      onChange={(e) =>
                        updateRule(rule.id, { name: e.target.value })
                      }
                      placeholder={t("policyEditor.ruleName")}
                      className="rounded-md border bg-background px-3 py-2 text-sm"
                      data-testid={`ai-office-policy-dlp-rule-name-${idx}`}
                    />
                    <input
                      type="text"
                      value={rule.pattern}
                      onChange={(e) =>
                        updateRule(rule.id, { pattern: e.target.value })
                      }
                      placeholder={t("policyEditor.regexPlaceholder")}
                      className="rounded-md border bg-background px-3 py-2 font-mono text-sm"
                      data-testid={`ai-office-policy-dlp-rule-pattern-${idx}`}
                    />
                    <select
                      value={rule.action}
                      onChange={(e) =>
                        updateRule(rule.id, {
                          action: e.target.value as DlpAction,
                        })
                      }
                      className="rounded-md border bg-background px-3 py-2 text-sm"
                      data-testid={`ai-office-policy-dlp-rule-action-${idx}`}
                    >
                      {DLP_ACTIONS.filter((a) => a.value !== "off").map((a) => (
                        <option key={a.value} value={a.value}>
                          {t(`policyEditor.actions.${a.value}`)}{" "}
                          {/* i18n-dynamic */}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => removeRule(rule.id)}
                      className="rounded-md border px-2 py-2 text-destructive hover:bg-destructive/10"
                      title={t("policyEditor.removeRule")}
                      data-testid={`ai-office-policy-dlp-rule-remove-${idx}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  {result && rule.pattern.trim() !== "" && (
                    <p
                      className={`mt-1.5 text-xs ${result.ok ? "text-muted-foreground" : "text-destructive"}`}
                      data-testid={`ai-office-policy-dlp-rule-result-${idx}`}
                    >
                      {result.ok
                        ? dlpSample
                          ? t("policyEditor.matchCount", {
                              count: result.matches,
                            })
                          : t("policyEditor.patternCompiles")
                        : t("policyEditor.patternError", {
                            error: result.error,
                          })}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="ai-office-policy-save"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {t("policyEditor.savePolicy")}
        </button>
      </div>
    </div>
  );
}
