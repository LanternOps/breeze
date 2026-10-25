import { useEffect, useMemo, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import {
  SECURITY_SCAN_PATH_MAX_CHARS,
  SECURITY_SWEEP_MAX_PATHS,
  SECURITY_SWEEP_SCAN_TYPES,
  SECURITY_SWEEP_SKIP_REASONS,
  SECURITY_SWEEP_TTL_HOURS_DEFAULT,
  SECURITY_SWEEP_TTL_HOURS_MAX,
  type DeploymentTargetConfig,
  type SecuritySweepScanType,
  type SecuritySweepScope,
  type SecuritySweepScopeKind,
} from "@breeze/shared";
import { ActionError } from "@/lib/runAction";
import { navigateTo } from "@/lib/navigation";
import { useOrgStore } from "@/stores/orgStore";
import { Dialog } from "../../shared/Dialog";
import { showToast } from "../../shared/Toast";
import { DeviceTargetSelector } from "../../filters/DeviceTargetSelector";
import {
  createSweep,
  listOrgSites,
  previewSweep,
  sweepErrorDetail,
  type SweepPreview,
  type SweepRequest,
} from "./sweepsApi";

type Step = "scope" | "type" | "duration" | "preview" | "confirm";
const STEP_ORDER: readonly Step[] = ["scope", "type", "duration", "preview", "confirm"];

const SCOPE_KINDS: readonly SecuritySweepScopeKind[] = ["all", "orgs", "sites", "groups", "devices"];

/** Orgs a sweep is never aimed at (no live devices to scan). */
const HIDDEN_ORG_STATUSES = new Set(["archived", "purging", "merging", "churned"]);

export interface SweepDialogPrefill {
  ruleSetIds: string[];
  /** Display names for the scope step (the preview returns the authoritative ones). */
  ruleSetNames?: string[];
  scanType?: SecuritySweepScanType;
  paths?: string[];
  /** Pre-selects the scope kind; members are never remembered, so only `all` is complete. */
  scopeKind?: SecuritySweepScopeKind;
  /** The prefill could not carry the scope members: the scope step says so. */
  rescope?: boolean;
}

const sweepsHash = (groupId: string) => `#sweeps&group=${encodeURIComponent(groupId)}`;

/** Where the Sweeps tab shows one group. */
export const sweepGroupHref = (groupId: string) => `/security/scans${sweepsHash(groupId)}`;

export default function SweepDialog({ prefill, onClose }: { prefill: SweepDialogPrefill; onClose: () => void }) {
  const { t } = useTranslation("security");
  const organizations = useOrgStore((s) => s.organizations);
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const fetchOrganizations = useOrgStore((s) => s.fetchOrganizations);

  const [step, setStep] = useState<Step>("scope");
  // A re-sweep starts with no scope chosen: a sweep never remembers its devices.
  const [scopeKind, setScopeKind] = useState<SecuritySweepScopeKind | null>(
    prefill.scopeKind ?? (prefill.rescope ? null : "all"),
  );
  const [orgIds, setOrgIds] = useState<string[]>([]);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [siteOrgId, setSiteOrgId] = useState<string>(currentOrgId ?? "");
  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([]);
  const [sitesState, setSitesState] = useState<"idle" | "loading" | "failed">("idle");
  const [groupTarget, setGroupTarget] = useState<DeploymentTargetConfig>({ type: "groups", groupIds: [] });
  const [deviceTarget, setDeviceTarget] = useState<DeploymentTargetConfig>({ type: "devices", deviceIds: [] });
  const [scanType, setScanType] = useState<SecuritySweepScanType>(prefill.scanType ?? "quick");
  const [pathsText, setPathsText] = useState((prefill.paths ?? []).join("\n"));
  const [ttl, setTtl] = useState<string>(String(SECURITY_SWEEP_TTL_HOURS_DEFAULT));
  const [preview, setPreview] = useState<SweepPreview | null>(null);
  const [scopeChanged, setScopeChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mfaRequired, setMfaRequired] = useState<{ targeted: number; threshold: number } | null>(null);
  const [runningGroupId, setRunningGroupId] = useState<string | null>(null);

  const orgOptions = useMemo(
    () =>
      (organizations ?? [])
        .filter((o) => !HIDDEN_ORG_STATUSES.has(o.status))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [organizations],
  );

  const needsOrgs = scopeKind === "orgs" || scopeKind === "sites";
  useEffect(() => {
    if (needsOrgs && (organizations ?? []).length === 0) void fetchOrganizations?.();
  }, [needsOrgs, organizations, fetchOrganizations]);

  // The site picker lists one org's sites at a time; picks survive switching org.
  useEffect(() => {
    if (scopeKind !== "sites" || !siteOrgId) return;
    let cancelled = false;
    setSitesState("loading");
    listOrgSites(siteOrgId)
      .then((rows) => {
        if (cancelled) return;
        setSites(rows);
        setSitesState("idle");
      })
      .catch(() => {
        if (cancelled) return;
        setSites([]);
        setSitesState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [scopeKind, siteOrgId]);

  const scope: SecuritySweepScope | null = useMemo(() => {
    switch (scopeKind) {
      case null:
        return null;
      case "all":
        return { kind: "all" };
      case "orgs":
        return orgIds.length > 0 ? { kind: "orgs", orgIds } : null;
      case "sites":
        return siteIds.length > 0 ? { kind: "sites", siteIds } : null;
      case "groups":
        return groupTarget.groupIds && groupTarget.groupIds.length > 0
          ? { kind: "groups", groupIds: groupTarget.groupIds }
          : null;
      case "devices":
        return deviceTarget.deviceIds && deviceTarget.deviceIds.length > 0
          ? { kind: "devices", deviceIds: deviceTarget.deviceIds }
          : null;
    }
  }, [scopeKind, orgIds, siteIds, groupTarget, deviceTarget]);

  const paths = useMemo(
    () =>
      pathsText
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean),
    [pathsText],
  );
  const pathsValid =
    scanType !== "custom" ||
    (paths.length >= 1 && paths.length <= SECURITY_SWEEP_MAX_PATHS && paths.every((p) => p.length <= SECURITY_SCAN_PATH_MAX_CHARS));

  const ttlNumber = Number(ttl);
  const ttlValid = Number.isInteger(ttlNumber) && ttlNumber >= 1 && ttlNumber <= SECURITY_SWEEP_TTL_HOURS_MAX;

  const request = (): SweepRequest | null => {
    if (!scope) return null;
    return {
      ruleSetIds: prefill.ruleSetIds,
      scope,
      scanType,
      ...(scanType === "custom" ? { paths } : {}),
      ttlHours: ttlNumber,
    };
  };

  const canNext =
    !busy &&
    (step === "scope"
      ? scope !== null
      : step === "type"
        ? pathsValid
        : step === "duration"
          ? ttlValid
          : step === "preview"
            ? preview !== null
            : false);

  const clearErrors = () => {
    setError(null);
    setMfaRequired(null);
    setRunningGroupId(null);
  };

  const fail = (err: unknown) => {
    if (err instanceof ActionError && err.status === 401) return;
    if (err instanceof ActionError) {
      setError(err.message);
      return;
    }
    setError(t("common:states.error"));
    showToast({ type: "error", message: t("common:states.error") });
  };

  const runPreview = async () => {
    const body = request();
    if (!body) return;
    clearErrors();
    setBusy(true);
    try {
      setPreview(await previewSweep(body));
      setScopeChanged(false);
      setStep("preview");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    clearErrors();
    if (step === "duration") return void runPreview();
    const i = STEP_ORDER.indexOf(step);
    setStep(STEP_ORDER[i + 1] ?? step);
  };

  const back = () => {
    clearErrors();
    const i = STEP_ORDER.indexOf(step);
    setStep(STEP_ORDER[Math.max(0, i - 1)] ?? step);
  };

  const confirm = async () => {
    const body = request();
    if (!body || !preview) return;
    clearErrors();
    setBusy(true);
    try {
      const created = await createSweep({ ...body, previewDigest: preview.previewDigest });
      onClose();
      if (typeof window !== "undefined" && window.location.pathname === "/security/scans") {
        window.location.hash = sweepsHash(created.groupId);
      } else {
        void navigateTo(sweepGroupHref(created.groupId));
      }
    } catch (err) {
      if (err instanceof ActionError) {
        const detail = sweepErrorDetail(err.body);
        if (err.code === "SWEEP_SCOPE_CHANGED" && detail.preview) {
          setPreview(detail.preview as SweepPreview);
          setScopeChanged(true);
          setStep("preview");
          return;
        }
        if (err.code === "SWEEP_ALREADY_RUNNING") {
          const groups = Array.isArray(detail.groupIds) ? (detail.groupIds as string[]) : [];
          setRunningGroupId(groups[0] ?? null);
          setError(err.message);
          return;
        }
        if (err.code === "MFA_REQUIRED") {
          setMfaRequired({
            targeted: typeof detail.targeted === "number" ? detail.targeted : (preview?.targeted ?? 0),
            threshold: typeof detail.threshold === "number" ? detail.threshold : 0,
          });
          return;
        }
      }
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const setNames = prefill.ruleSetNames?.join(", ");

  return (
    <Dialog open onClose={onClose} title={t("sweeps.dialog.title")} maxWidth="2xl" className="flex max-h-[90vh] flex-col p-6">
      <div data-testid="sweep-dialog" className="flex min-h-0 flex-1 flex-col gap-4">
        <div>
          <h3 className="text-lg font-semibold">{t("sweeps.dialog.title")}</h3>
          {setNames && <p className="text-sm text-muted-foreground">{t("sweeps.dialog.ruleSets", { names: setNames })}</p>}
        </div>

        <p
          data-testid="sweep-dialog-detect-only"
          className="flex items-start gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm"
        >
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          {t("sweeps.detectOnly")}
        </p>

        <ol className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {STEP_ORDER.map((id) => (
            <li
              key={id}
              data-testid={`sweep-dialog-step-${id}`}
              aria-current={step === id ? "step" : undefined}
              className={`rounded-full border px-2 py-0.5 ${step === id ? "border-primary text-primary" : ""}`}
            >
              {t(/* i18n-dynamic */ `sweeps.dialog.steps.${id}`)}
            </li>
          ))}
        </ol>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          {step === "scope" && (
            <div className="space-y-3">
              {prefill.rescope && (
                <p data-testid="sweep-dialog-rescope-note" className="text-sm text-muted-foreground">
                  {t("sweeps.dialog.rescopeNote")}
                </p>
              )}
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t("sweeps.dialog.scope.legend")}</legend>
                {SCOPE_KINDS.map((kind) => (
                  <label key={kind} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="sweep-scope"
                      data-testid={`sweep-dialog-scope-${kind}`}
                      checked={scopeKind === kind}
                      onChange={() => setScopeKind(kind)}
                    />
                    {t(/* i18n-dynamic */ `sweeps.dialog.scope.${kind}`)}
                  </label>
                ))}
              </fieldset>

              {scopeKind === "all" && <p className="text-xs text-muted-foreground">{t("sweeps.dialog.scope.allHelp")}</p>}

              {scopeKind === "orgs" && (
                <div data-testid="sweep-dialog-orgs-list" className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                  {orgOptions.length === 0 && <p className="text-xs text-muted-foreground">{t("sweeps.dialog.scope.noOrgs")}</p>}
                  {orgOptions.map((o) => (
                    <label key={o.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        data-testid={`sweep-dialog-org-${o.id}`}
                        checked={orgIds.includes(o.id)}
                        onChange={() => toggle(orgIds, setOrgIds, o.id)}
                      />
                      {o.name}
                    </label>
                  ))}
                </div>
              )}

              {scopeKind === "sites" && (
                <div className="space-y-2">
                  <label className="block text-sm">
                    <span className="text-xs uppercase text-muted-foreground">{t("sweeps.dialog.scope.siteOrg")}</span>
                    <select
                      data-testid="sweep-dialog-sites-org"
                      value={siteOrgId}
                      onChange={(e) => setSiteOrgId(e.target.value)}
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="">{t("sweeps.dialog.scope.pickOrg")}</option>
                      {orgOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div data-testid="sweep-dialog-sites-list" className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                    {sitesState === "loading" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    {sitesState === "failed" && (
                      <p className="text-xs text-destructive">{t("sweeps.dialog.scope.sitesFailed")}</p>
                    )}
                    {sitesState === "idle" && siteOrgId && sites.length === 0 && (
                      <p className="text-xs text-muted-foreground">{t("sweeps.dialog.scope.noSites")}</p>
                    )}
                    {sites.map((s) => (
                      <label key={s.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          data-testid={`sweep-dialog-site-${s.id}`}
                          checked={siteIds.includes(s.id)}
                          onChange={() => toggle(siteIds, setSiteIds, s.id)}
                        />
                        {s.name}
                      </label>
                    ))}
                  </div>
                  {siteIds.length > 0 && (
                    <p className="text-xs text-muted-foreground">{t("sweeps.dialog.scope.sitesSelected", { selected: siteIds.length })}</p>
                  )}
                </div>
              )}

              {scopeKind === "groups" && (
                <DeviceTargetSelector
                  value={groupTarget}
                  onChange={setGroupTarget}
                  modes={["groups"]}
                  orgId={currentOrgId ?? undefined}
                  showPreview={false}
                  showSavedFilters={false}
                />
              )}

              {scopeKind === "devices" && (
                <DeviceTargetSelector
                  value={deviceTarget}
                  onChange={setDeviceTarget}
                  modes={["manual"]}
                  orgId={currentOrgId ?? undefined}
                  showPreview={false}
                  showSavedFilters={false}
                />
              )}
            </div>
          )}

          {step === "type" && (
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="text-xs uppercase text-muted-foreground">{t("sweeps.dialog.type.label")}</span>
                <select
                  data-testid="sweep-dialog-scan-type"
                  value={scanType}
                  onChange={(e) => setScanType(e.target.value as SecuritySweepScanType)}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  {SECURITY_SWEEP_SCAN_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(/* i18n-dynamic */ `sweeps.dialog.type.${type}`)}
                    </option>
                  ))}
                </select>
              </label>
              {scanType === "custom" && (
                <label className="block text-sm">
                  <span className="text-xs uppercase text-muted-foreground">{t("sweeps.dialog.type.paths")}</span>
                  <textarea
                    data-testid="sweep-dialog-paths"
                    value={pathsText}
                    onChange={(e) => setPathsText(e.target.value)}
                    rows={4}
                    className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
                  />
                  <span className={`mt-1 block text-xs ${pathsValid ? "text-muted-foreground" : "text-destructive"}`}>
                    {t("sweeps.dialog.type.pathsHelp", { max: SECURITY_SWEEP_MAX_PATHS, chars: SECURITY_SCAN_PATH_MAX_CHARS })}
                  </span>
                </label>
              )}
            </div>
          )}

          {step === "duration" && (
            <label className="block text-sm">
              <span className="text-xs uppercase text-muted-foreground">{t("sweeps.dialog.duration.label")}</span>
              <input
                type="number"
                data-testid="sweep-dialog-ttl"
                min={1}
                max={SECURITY_SWEEP_TTL_HOURS_MAX}
                step={1}
                value={ttl}
                onChange={(e) => setTtl(e.target.value)}
                onBlur={() => {
                  const n = Math.round(Number(ttl));
                  if (Number.isFinite(n)) setTtl(String(Math.min(SECURITY_SWEEP_TTL_HOURS_MAX, Math.max(1, n))));
                  else setTtl(String(SECURITY_SWEEP_TTL_HOURS_DEFAULT));
                }}
                className="mt-1 h-10 w-32 rounded-md border bg-background px-3 text-sm"
              />
              <span className={`mt-1 block text-xs ${ttlValid ? "text-muted-foreground" : "text-destructive"}`}>
                {t("sweeps.dialog.duration.help", { max: SECURITY_SWEEP_TTL_HOURS_MAX })}
              </span>
            </label>
          )}

          {step === "preview" && preview && (
            <div className="space-y-3" data-testid="sweep-dialog-preview">
              {scopeChanged && (
                <p
                  data-testid="sweep-dialog-scope-changed"
                  role="status"
                  className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800"
                >
                  {t("sweeps.dialog.preview.scopeChanged")}
                </p>
              )}
              <p data-testid="sweep-dialog-preview-targeted" className="text-sm font-medium">
                {t("sweeps.dialog.preview.targeted", { devices: preview.targeted, orgs: preview.byOrg.length })}
              </p>
              <ul className="space-y-1 text-sm">
                {preview.byOrg.map((o) => (
                  <li key={o.orgId} data-testid={`sweep-dialog-preview-org-${o.orgId}`}>
                    {t("sweeps.dialog.preview.org", { org: o.orgName ?? o.orgId, devices: o.targeted })}
                  </li>
                ))}
              </ul>
              <div>
                <p className="text-xs uppercase text-muted-foreground">{t("sweeps.dialog.preview.ruleSets")}</p>
                <ul className="space-y-1 text-sm">
                  {preview.ruleSets.map((r) => (
                    <li key={r.id} data-testid={`sweep-dialog-preview-set-${r.id}`}>
                      {r.name ?? r.id} · {t("sweeps.version", { version: r.version })}
                    </li>
                  ))}
                </ul>
              </div>
              {SECURITY_SWEEP_SKIP_REASONS.some((reason) => (preview.skipped[reason] ?? 0) > 0) && (
                <div>
                  <p className="text-xs uppercase text-muted-foreground">{t("sweeps.dialog.preview.skipped")}</p>
                  <ul className="space-y-1 text-sm">
                    {SECURITY_SWEEP_SKIP_REASONS.filter((reason) => (preview.skipped[reason] ?? 0) > 0).map((reason) => (
                      <li key={reason} data-testid={`sweep-dialog-preview-skipped-${reason}`}>
                        <span className="font-medium">{preview.skipped[reason]}</span>{" "}
                        {t(/* i18n-dynamic */ `sweeps.skipReasons.${reason}`)}
                        <span className="block text-xs text-muted-foreground">
                          {t(/* i18n-dynamic */ `sweeps.skipExplain.${reason}`)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {step === "confirm" && preview && (
            <p data-testid="sweep-dialog-confirm-summary" className="text-sm">
              {t("sweeps.dialog.confirmSummary", { targeted: preview.targeted, orgs: preview.byOrg.length })}
            </p>
          )}

          {mfaRequired && (
            <p
              data-testid="sweep-dialog-mfa-required"
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {t("sweeps.errors.mfaRequired", mfaRequired)}
            </p>
          )}

          {error && (
            <div
              data-testid="sweep-dialog-error"
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <p>{error}</p>
              {runningGroupId && (
                <a
                  data-testid="sweep-dialog-already-running-link"
                  href={sweepGroupHref(runningGroupId)}
                  className="mt-1 inline-block font-medium underline"
                >
                  {t("sweeps.dialog.viewRunning")}
                </a>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t pt-4">
          <button
            type="button"
            data-testid="sweep-dialog-cancel"
            onClick={onClose}
            className="rounded-md border px-3 py-2 text-sm"
          >
            {t("common:actions.cancel")}
          </button>
          <div className="flex items-center gap-2">
            {step !== "scope" && (
              <button
                type="button"
                data-testid="sweep-dialog-back"
                onClick={back}
                disabled={busy}
                className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
              >
                {t("sweeps.dialog.back")}
              </button>
            )}
            {step !== "confirm" ? (
              <button
                type="button"
                data-testid="sweep-dialog-next"
                onClick={next}
                disabled={!canNext}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {step === "duration" ? t("sweeps.dialog.previewAction") : t("sweeps.dialog.next")}
              </button>
            ) : (
              <button
                type="button"
                data-testid="sweep-dialog-confirm"
                onClick={() => void confirm()}
                disabled={busy || !preview}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("sweeps.dialog.confirm", { targeted: preview?.targeted ?? 0 })}
              </button>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
