import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { showToast } from "../shared/Toast";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, ActionError } from "@/lib/runAction";
import { extractApiError } from "@/lib/apiError";

/**
 * At or above this many target devices the operator must type the count, the
 * same gate BulkPurgeDialog uses for bulk permanent delete. Below it a click is
 * enough — the count, policy and software are still stated in the dialog.
 */
export const TYPED_CONFIRM_THRESHOLD = 10;

type PolicyRef = {
  id: string;
  name: string;
  mode: "allowlist" | "blocklist" | "audit";
};

type RemediationPreview = {
  deviceIds: string[];
  deviceCount: number;
  uninstallCount: number;
  software: Array<{ name: string; deviceCount: number }>;
  softwareDistinctCount: number;
  sampleDevices: Array<{
    deviceId: string;
    hostname: string | null;
    uninstalls: Array<{ name: string; version?: string }>;
  }>;
  totalTargetDevices: number;
  capped: boolean;
  maxDevices: number;
};

// Every settled state carries the policy it was loaded for. The dialog stays
// mounted across close/reopen, so on the first render after reopening for a
// DIFFERENT policy the previous policy's preview is still in state until the
// effect resets it; tagging lets render treat that as loading, so another
// policy's deviceIds can never be confirmed against this one.
type PreviewState =
  | { status: "loading" }
  | { status: "error"; policyId: string; reason: string | null }
  | { status: "ready"; policyId: string; preview: RemediationPreview };

export interface RemediateConfirmDialogProps {
  open: boolean;
  policy: PolicyRef | null;
  onClose: () => void;
  /** Called after the server accepted the remediation. */
  onQueued?: () => void;
}

function isPreview(value: unknown): value is RemediationPreview {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.deviceIds) &&
    typeof v.deviceCount === "number" &&
    Array.isArray(v.software) &&
    Array.isArray(v.sampleDevices)
  );
}

/**
 * Confirmation for software-policy Remediate (#3616, incident #3381).
 *
 * Remediate uninstalls software on real machines. It used to fire from an
 * unlabelled icon with an empty body, letting the server resolve up to 500
 * devices on its own — 259 machines lost software from one click with no count
 * shown. This dialog asks the server for the target set first
 * (GET /:id/remediate/preview), states the blast radius — device count,
 * policy name and mode, the software that will be removed, and a sample of
 * devices — and confirms by POSTing exactly the previewed `deviceIds`, so the
 * set that runs is the set that was shown.
 *
 * Deliberately says nothing about `enforceMode` / auto-uninstall: those govern
 * unattended remediation and are not what authorizes this operator action.
 */
export default function RemediateConfirmDialog({
  open,
  policy,
  onClose,
  onQueued,
}: RemediateConfirmDialogProps) {
  const { t } = useTranslation("policies");
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [typedCount, setTypedCount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const policyId = policy?.id;

  useEffect(() => {
    if (!open || !policyId) return;
    let cancelled = false;
    setState({ status: "loading" });
    // Reset between openings so a count typed for one preview can never arm
    // the button for a different one.
    setTypedCount("");
    (async () => {
      try {
        const res = await fetchWithAuth(
          `/software-policies/${policyId}/remediate/preview`,
        );
        const data: unknown = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !isPreview(data)) {
          console.error(
            "[RemediateConfirmDialog] remediation preview failed",
            res.status,
            data,
          );
          // Surface the server's reason (audit-only policy, not found, …)
          // when it gave one; the generic line covers the rest.
          const reason = res.ok ? null : extractApiError(data, "") || null;
          setState({ status: "error", policyId, reason });
          return;
        }
        setState({ status: "ready", policyId, preview: data });
      } catch (err) {
        if (cancelled) return;
        console.error("[RemediateConfirmDialog] remediation preview failed", err);
        setState({ status: "error", policyId, reason: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, policyId]);

  if (!policy) return null;

  const current: PreviewState =
    state.status !== "loading" && state.policyId !== policy.id
      ? { status: "loading" }
      : state;
  const preview = current.status === "ready" ? current.preview : null;
  const count = preview?.deviceCount ?? 0;
  const needsTypedCount = count >= TYPED_CONFIRM_THRESHOLD;
  const typedOk = !needsTypedCount || typedCount.trim() === String(count);
  const modeLabel =
    policy.mode === "allowlist"
      ? t("software.remediateConfirm.modeAllowlist")
      : t("software.remediateConfirm.modeBlocklist");

  const handleConfirm = async () => {
    if (!preview || preview.deviceIds.length === 0) return;
    setSubmitting(true);
    const requested = preview.deviceIds.length;
    try {
      const data = await runAction<{ queued?: number } | undefined>({
        request: () =>
          fetchWithAuth(`/software-policies/${policy.id}/remediate`, {
            method: "POST",
            body: JSON.stringify({ deviceIds: preview.deviceIds }),
          }),
        errorFallback: t("software.remediateConfirm.failed"),
      });
      // A 200 is not proof anything was queued: devices can leave scope or
      // already have remediation pending between preview and confirm, and the
      // route answers those with `queued: 0` (or fewer than requested). Never
      // report that as a plain success.
      const queued = typeof data?.queued === "number" ? data.queued : 0;
      if (queued === 0) {
        showToast({ type: "warning", message: t("software.remediateConfirm.queuedNone") });
      } else if (queued < requested) {
        showToast({
          type: "warning",
          message: t("software.remediateConfirm.queuedPartial", { queued, requested }),
        });
      } else {
        showToast({
          type: "success",
          message: t("software.remediateConfirm.queued", { count: queued }),
        });
      }
      onQueued?.();
      onClose();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: "error", message: t("software.remediateConfirm.failed") });
      }
    } finally {
      setSubmitting(false);
    }
  };

  let message: string;
  if (current.status === "loading") {
    message = t("software.remediateConfirm.loading");
  } else if (current.status === "error") {
    message = current.reason
      ? t("software.remediateConfirm.previewFailedWithReason", { reason: current.reason })
      : t("software.remediateConfirm.previewFailed");
  } else if (count === 0) {
    message = t("software.remediateConfirm.nothingToRemove");
  } else {
    message = t("software.remediateConfirm.message", {
      count,
      uninstallCount: preview!.uninstallCount,
      name: policy.name,
      mode: modeLabel,
    });
  }

  const moreSoftware = preview
    ? preview.softwareDistinctCount - preview.software.length
    : 0;
  const moreDevices = preview ? count - preview.sampleDevices.length : 0;

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={() => void handleConfirm()}
      title={t("software.remediateConfirm.title", { name: policy.name })}
      message={message}
      confirmLabel={t("software.remediateConfirm.confirm", { count })}
      variant="destructive"
      isLoading={submitting}
      confirmDisabled={current.status !== "ready" || count === 0 || !typedOk}
      confirmTestId="confirm-software-remediate"
      dialogTestId="software-remediate-dialog"
    >
      {current.status === "error" && (
        <p data-testid="software-remediate-preview-error" className="text-sm text-destructive">
          {t("software.remediateConfirm.nothingQueued")}
        </p>
      )}
      {preview && count === 0 && (
        <p data-testid="software-remediate-empty" className="text-sm text-muted-foreground">
          {t("software.remediateConfirm.nothingQueued")}
        </p>
      )}
      {preview && count > 0 && (
        <div data-testid="software-remediate-preview" className="space-y-3 text-sm">
          <p className="font-medium text-foreground">
            {t("software.remediateConfirm.summary", {
              count,
              name: policy.name,
              mode: modeLabel,
            })}
          </p>

          {preview.capped && (
            <p data-testid="software-remediate-capped" className="text-warning">
              {t("software.remediateConfirm.capped", {
                total: preview.totalTargetDevices,
                max: preview.maxDevices,
              })}
            </p>
          )}

          <div>
            <p className="text-xs font-medium uppercase text-muted-foreground">
              {t("software.remediateConfirm.softwareHeading")}
            </p>
            <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
              {preview.software.map((s) => (
                <li key={s.name} className="flex justify-between gap-2">
                  <span className="truncate">{s.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {t("software.remediateConfirm.onDevices", { count: s.deviceCount })}
                  </span>
                </li>
              ))}
              {moreSoftware > 0 && (
                <li className="text-xs text-muted-foreground">
                  {t("software.remediateConfirm.moreSoftware", { count: moreSoftware })}
                </li>
              )}
            </ul>
          </div>

          <div>
            <p className="text-xs font-medium uppercase text-muted-foreground">
              {t("software.remediateConfirm.devicesHeading")}
            </p>
            <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
              {preview.sampleDevices.map((d) => (
                <li key={d.deviceId} className="truncate text-xs">
                  <span className="font-mono">{d.hostname ?? d.deviceId}</span>
                  <span className="text-muted-foreground">
                    {" — "}
                    {d.uninstalls
                      .map((u) => (u.version ? `${u.name} ${u.version}` : u.name))
                      .join(", ")}
                  </span>
                </li>
              ))}
              {moreDevices > 0 && (
                <li className="text-xs text-muted-foreground">
                  {t("software.remediateConfirm.moreDevices", { count: moreDevices })}
                </li>
              )}
            </ul>
          </div>

          {needsTypedCount && (
            <label className="block">
              <span className="text-muted-foreground">
                {t("software.remediateConfirm.typeCount", { count })}
              </span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={typedCount}
                onChange={(e) => setTypedCount(e.target.value)}
                data-testid="software-remediate-count"
                aria-label={t("software.remediateConfirm.typeCount", { count })}
                className="mt-1 w-24 rounded-md border bg-background px-2 py-1 text-sm"
              />
            </label>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}
