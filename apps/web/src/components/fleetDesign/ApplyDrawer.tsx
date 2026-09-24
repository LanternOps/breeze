import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  FleetDesignApplyDisplacement,
  FleetDesignApplyPreview,
  FleetDesignApplyResult,
  FleetDesignApproval,
  FleetDesignRollbackResult,
} from "@breeze/shared";
import { Drawer } from "../shared/Drawer";
import { ActionError, runAction } from "@/lib/runAction";
import { apply, previewApply, rollback } from "@/lib/api/fleetDesign";

/**
 * Fleet Designer W03 (#5653) — the apply drawer: preview -> confirm -> apply,
 * with a rollback offer on a `partial` result. Opening the drawer always
 * fetches a FRESH preview against the CURRENT selection (`approvalBase`,
 * `previewApply.ts`'s docstring: "the technician approves exactly what the
 * apply will do, item by item"), so `displacementsAccepted` starts empty on
 * every open even if a previous open of the same drawer had some accepted.
 */
export interface ApplyDrawerProps {
  open: boolean;
  onClose: () => void;
  reportRunId: string;
  /** Current selection, everything but `displacementsAccepted` (this drawer owns that). */
  approvalBase: Omit<FleetDesignApproval, "displacementsAccepted">;
  /** Called after a successful (including partial) apply or rollback, so the
   *  page can reload the design's ledger. */
  onApplied: () => void;
  /**
   * The report's per-function confidence (0-1), keyed by functionKey — the
   * SAME source FleetDesignViewer reads (`outcome.sections.functions[].confidence`).
   * The apply preview itself carries no confidence field, so without this the
   * drawer has nothing but a hardcoded guess.
   */
  functionConfidence?: Record<string, number>;
}

function selectionCount(base: Omit<FleetDesignApproval, "displacementsAccepted">): number {
  return (
    base.functions.length + base.monitoring.length + base.retired.length + base.automation.length + base.roleCorrections.length
  );
}

export default function ApplyDrawer({ open, onClose, reportRunId, approvalBase, onApplied, functionConfidence }: ApplyDrawerProps) {
  const { t } = useTranslation("fleetDesign");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<FleetDesignApplyPreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<FleetDesignApplyResult | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackResult, setRollbackResult] = useState<FleetDesignRollbackResult | null>(null);
  // Set when either the preview or the apply request comes back 403
  // `{ error: 'scripts_write_required' }` (W04 #5654) — the caller's
  // approval contains automation refs but they lack Scripts write. Shown as
  // a persistent message in the drawer body in addition to the toast
  // `friendly()` already produces, since a toast alone can disappear before
  // the technician reads it.
  const [scriptsWriteRequired, setScriptsWriteRequired] = useState(false);

  // Latest-ref: the effect below fires only on the open/reportRunId edge, but
  // must still read the CURRENT selection at that moment, not a stale one
  // captured when the effect was first defined.
  const approvalBaseRef = useRef(approvalBase);
  approvalBaseRef.current = approvalBase;

  const friendly = (code: string): string | undefined => {
    if (code === "blocked") return t("errors.blocked");
    if (code === "site_restricted") return t("errors.site_restricted");
    if (code === "no_designer_agent") return t("errors.no_designer_agent");
    if (code === "not_found") return t("errors.not_found");
    if (code === "scripts_write_required") return t("errors.scripts_write_required");
    return undefined;
  };

  /** Preview and apply both answer 403 `{ error: 'scripts_write_required' }`
   *  (W04 #5654) when the approval carries automation refs but the caller
   *  lacks Scripts write. `runAction` already toasts the friendly() text
   *  above; this just flags the persistent, dedicated message below. */
  const isScriptsWriteRequired = (err: unknown): boolean =>
    err instanceof ActionError &&
    err.status === 403 &&
    !!err.body &&
    typeof err.body === "object" &&
    (err.body as Record<string, unknown>).error === "scripts_write_required";

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setRollbackResult(null);
    setPreview(null);
    setPreviewFailed(false);
    setScriptsWriteRequired(false);
    setAccepted(new Set());
    setPreviewLoading(true);
    void (async () => {
      try {
        const body: FleetDesignApproval = { ...approvalBaseRef.current, displacementsAccepted: [] };
        const data = await runAction<FleetDesignApplyPreview>({
          request: () => previewApply(reportRunId, body),
          errorFallback: t("errors.genericPreview"),
          friendly,
          parseSuccess: (d) => d as FleetDesignApplyPreview,
        });
        setPreview(data);
      } catch (err) {
        setPreviewFailed(true);
        if (isScriptsWriteRequired(err)) setScriptsWriteRequired(true);
      } finally {
        setPreviewLoading(false);
      }
    })();
  }, [open, reportRunId]);

  const displacements: FleetDesignApplyDisplacement[] = preview?.policies.flatMap((p) => p.displaces) ?? [];
  const allDisplacementsAccepted = displacements.every((d) => accepted.has(d.policyId));
  const hasSelection = selectionCount(approvalBase) > 0;
  const canConfirm = !!preview && preview.blockers.length === 0 && allDisplacementsAccepted && hasSelection && !applying;

  const toggleAccepted = (policyId: string) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(policyId)) next.delete(policyId);
      else next.add(policyId);
      return next;
    });
  };

  const handleConfirm = async () => {
    if (!preview) return;
    setApplying(true);
    setScriptsWriteRequired(false);
    try {
      const body: FleetDesignApproval = { ...approvalBaseRef.current, displacementsAccepted: [...accepted] };
      const data = await runAction<FleetDesignApplyResult>({
        request: () => apply(reportRunId, body),
        errorFallback: t("errors.genericApply"),
        friendly,
        parseSuccess: (d) => d as FleetDesignApplyResult,
      });
      setResult(data);
      onApplied();
    } catch (err) {
      if (err instanceof ActionError && err.status === 409 && err.body && typeof err.body === "object") {
        const body = err.body as { blockers?: FleetDesignApplyPreview["blockers"]; unaccepted?: FleetDesignApplyDisplacement[] };
        // The world moved under us between preview and apply — surface what
        // apply itself just discovered rather than a stale confirm state.
        setPreview((prev) => (prev ? { ...prev, blockers: body.blockers ?? prev.blockers } : prev));
      }
      if (isScriptsWriteRequired(err)) setScriptsWriteRequired(true);
      // 401: the auth redirect is the feedback. Every other ActionError was
      // already toasted by runAction via the friendly/fallback message.
    } finally {
      setApplying(false);
    }
  };

  const handleRollback = async () => {
    setRollingBack(true);
    try {
      const data = await runAction<FleetDesignRollbackResult>({
        request: () => rollback(reportRunId),
        errorFallback: t("errors.genericRollback"),
        successMessage: (d) => t("result.rollbackDone", { count: d.rolledBack.length }),
        parseSuccess: (d) => d as FleetDesignRollbackResult,
      });
      setRollbackResult(data);
      onApplied();
    } catch {
      // Already toasted.
    } finally {
      setRollingBack(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t("drawer.title")}
      dataTestId="fleet-design-apply-drawer"
      closeDisabled={applying || rollingBack}
      closeDisabledReason={applying ? t("drawer.applyingCloseBlocked") : rollingBack ? t("drawer.rollingBackCloseBlocked") : undefined}
    >
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {scriptsWriteRequired && (
          <p className="mb-3 text-sm text-destructive" data-testid="fleet-design-apply-drawer-scripts-write-required">
            {t("errors.scripts_write_required")}
          </p>
        )}

        {previewLoading && <p className="text-sm text-muted-foreground">{t("drawer.loadingPreview")}</p>}

        {!previewLoading && previewFailed && !preview && !scriptsWriteRequired && (
          <p className="text-sm text-destructive" data-testid="fleet-design-apply-drawer-preview-error">
            {t("errors.genericPreview")}
          </p>
        )}

        {result && (
          <div className="space-y-3" data-testid="fleet-design-apply-drawer-result">
            <p className="text-sm">{t("result.applied", { count: result.applied.length })}</p>
            {result.skipped.length > 0 && <p className="text-sm text-muted-foreground">{t("result.skipped", { count: result.skipped.length })}</p>}
            {result.partial && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                <p>{t("result.partial", { step: result.partial.failedStep, reason: result.partial.reason })}</p>
                {result.rollbackAvailable && !rollbackResult && (
                  <button
                    type="button"
                    onClick={() => void handleRollback()}
                    disabled={rollingBack}
                    data-testid="fleet-design-apply-drawer-rollback"
                    className="mt-2 inline-flex items-center rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                  >
                    {t("result.rollback")}
                  </button>
                )}
              </div>
            )}
            {rollbackResult && (
              <div data-testid="fleet-design-apply-drawer-rollback-result" className="space-y-1 text-sm">
                <p>{t("result.rollbackDone", { count: rollbackResult.rolledBack.length })}</p>
                {rollbackResult.refused.length > 0 && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    <p>{t("result.rollbackRefused")}</p>
                    <ul className="mt-1 list-disc pl-4">
                      {rollbackResult.refused.map((r) => (
                        <li key={r.itemRef}>
                          {r.itemRef}: {r.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {!result && preview && (
          <div className="space-y-4">
            {!hasSelection && (
              <p className="text-sm text-muted-foreground" data-testid="fleet-design-apply-drawer-nothing-selected">
                {t("drawer.nothingSelected")}
              </p>
            )}

            {(preview.functions.length > 0 || preview.policies.length > 0) && (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("drawer.creates")}</h3>
                <ul className="mt-1 space-y-1 text-sm">
                  {preview.functions.map((f) => (
                    <li key={f.functionKey}>
                      {f.groupName} — {t("items.functionMeta", {
                        count: f.deviceCount,
                        pct: Math.round((functionConfidence?.[f.functionKey] ?? 0) * 100),
                      })}
                    </li>
                  ))}
                  {preview.policies.map((p) => (
                    <li key={p.functionKey}>
                      {p.policyName} — {t("drawer.watchCount", { count: p.watchCount })}, {t("drawer.ruleCount", { count: p.ruleCount })}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {preview.retired.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("drawer.retires")}</h3>
                <ul className="mt-1 space-y-1 text-sm">
                  {preview.retired.map((r) => (
                    <li key={r.itemRef}>{r.itemName}</li>
                  ))}
                </ul>
              </section>
            )}

            {preview.scripts.length > 0 && (
              <section data-testid="fleet-design-apply-drawer-scripts">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("drawer.createsScripts")}</h3>
                <ul className="mt-1 space-y-1 text-sm">
                  {preview.scripts.map((s) => (
                    <li key={s.itemRef}>
                      {s.name} — {s.language} · {s.osTypes.join("/")}
                      {s.alreadyExists && <span className="text-xs text-muted-foreground"> ({t("drawer.scriptRenamed")})</span>}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-muted-foreground">{t("drawer.scriptsNote")}</p>
              </section>
            )}

            {displacements.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("drawer.displaces")}</h3>
                <ul className="mt-1 space-y-1.5">
                  {displacements.map((d) => (
                    <li key={`${d.policyId}:${d.featureType}`} className="flex items-center justify-between gap-2 text-sm">
                      <span>
                        {d.policyName} — {t("drawer.displacesCount", { count: d.deviceCount })}
                      </span>
                      <label className="flex shrink-0 items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={accepted.has(d.policyId)}
                          onChange={() => toggleAccepted(d.policyId)}
                          data-testid={`fleet-design-apply-drawer-accept-${d.policyId}`}
                        />
                        {t("drawer.acceptDisplacement")}
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {preview.roleCorrections.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("drawer.roleCorrections")}</h3>
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t("drawer.billingWarning")}</p>
                <ul className="mt-1 space-y-1 text-sm">
                  {preview.roleCorrections.map((rc) => (
                    <li key={rc.deviceId}>
                      {rc.hostname}: {rc.from} → {rc.to}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {preview.alreadyApplied.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("drawer.alreadyApplied")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{preview.alreadyApplied.length}</p>
              </section>
            )}

            {preview.blockers.length > 0 && (
              <section data-testid="fleet-design-apply-drawer-blockers">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-destructive">{t("drawer.blockers")}</h3>
                <ul className="mt-1 space-y-1 text-sm text-destructive">
                  {preview.blockers.map((b) => (
                    <li key={b.itemRef}>
                      {b.itemRef}: {b.reason}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>

      {!result && (
        <div className="flex items-center justify-end gap-2 border-t px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={applying}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            {t("drawer.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!canConfirm}
            data-testid="fleet-design-apply-drawer-confirm"
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {t("drawer.confirm")}
          </button>
        </div>
      )}
      {result && (
        <div className="flex items-center justify-end gap-2 border-t px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            {t("result.close")}
          </button>
        </div>
      )}
    </Drawer>
  );
}
