import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchWithAuth } from "../../../stores/auth";
import { ActionError, runAction } from "@/lib/runAction";
import { formatDate, formatDateTime } from "@/lib/dateTimeFormat";
import { navigateTo } from "@/lib/navigation";
import { showToast } from "../../shared/Toast";

/**
 * Storage keys this organization's S3 backup destinations used before backups
 * were written only through storage sessions (GET /backup/storage-credentials).
 * Devices may have received those keys, so each one stays listed until it is
 * replaced on its destination, disabled with the storage provider, and either
 * checked here (the server tries the old key) or confirmed by the operator.
 * Renders nothing when no key needs attention.
 */
export type StorageKeyNeedingAction = {
  id: string;
  configId: string | null;
  configName: string | null;
  bucket: string | null;
  endpoint: string | null;
  usedBefore: string;
  replacedAt: string | null;
  canCheck: boolean;
  lastCheckedAt: string | null;
  lastCheckOutcome: "still_live" | "inconclusive" | null;
  /** Storage error code of the most recent inconclusive check. */
  lastCheckCode: string | null;
};

type CheckOutcome = "revoked" | "still_live" | "inconclusive";
type CheckResult = { outcome: CheckOutcome; code: string | null };

/** Storage refused the old key for listing; it may still work for uploads. */
const REFUSED_FOR_LISTING_CODES = new Set(["AccessDenied", "SignatureDoesNotMatch"]);



export default function StorageKeyRevocationCard() {
  const { t } = useTranslation("policies");
  const outcomeMessage = ({ outcome, code }: CheckResult): string => {
    if (outcome === "revoked") return t("configurationPolicies.featureTabs.backupTab.storageKeys.outcome.revoked");
    if (outcome === "still_live") return t("configurationPolicies.featureTabs.backupTab.storageKeys.outcome.stillLive");
    if (code !== null && REFUSED_FOR_LISTING_CODES.has(code)) {
      return t("configurationPolicies.featureTabs.backupTab.storageKeys.outcome.refusedForListing");
    }
    return t("configurationPolicies.featureTabs.backupTab.storageKeys.outcome.inconclusive");
  };
  const [rows, setRows] = useState<StorageKeyNeedingAction[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, CheckResult>>({});

  const load = useCallback(async () => {
    try {
      const response = await fetchWithAuth("/backup/storage-credentials");
      if (!response.ok) {
        setLoadFailed(true);
        return;
      }
      const body = (await response.json()) as { data?: StorageKeyNeedingAction[] };
      setRows(Array.isArray(body.data) ? body.data : []);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onUnauthorized = () => void navigateTo("/login", { replace: true });

  const check = async (row: StorageKeyNeedingAction) => {
    setBusyId(row.id);
    try {
      const result = await runAction<CheckResult>({
        request: () => fetchWithAuth(`/backup/storage-credentials/${row.id}/check`, { method: "POST" }),
        parseSuccess: (value) => {
          const body = value as { outcome: CheckOutcome; code?: string | null };
          return { outcome: body.outcome, code: body.code ?? null };
        },
        errorFallback: t("configurationPolicies.featureTabs.backupTab.storageKeys.checkFailed"),
        onUnauthorized,
      });
      setOutcomes((prev) => ({ ...prev, [row.id]: result }));
      showToast({
        type: result.outcome === "revoked" ? "success" : "warning",
        message: outcomeMessage(result),
      });
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: "error", message: t("configurationPolicies.featureTabs.backupTab.storageKeys.checkFailed") });
    } finally {
      setBusyId(null);
    }
  };

  const confirmDisabled = async (row: StorageKeyNeedingAction) => {
    setBusyId(row.id);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/backup/storage-credentials/${row.id}/confirm-disabled`, {
            method: "POST",
            body: JSON.stringify({ confirm: true }),
          }),
        errorFallback: t("configurationPolicies.featureTabs.backupTab.storageKeys.confirmFailed"),
        successMessage: t("configurationPolicies.featureTabs.backupTab.storageKeys.confirmed"),
        onUnauthorized,
      });
      setConfirmingId(null);
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: "error", message: t("configurationPolicies.featureTabs.backupTab.storageKeys.confirmFailed") });
    } finally {
      setBusyId(null);
    }
  };

  if (loadFailed) {
    return (
      <div className="rounded-md border border-muted p-3 text-xs text-muted-foreground">
        {t("configurationPolicies.featureTabs.backupTab.storageKeys.loadFailed")}{" "}
        <button type="button" onClick={() => void load()} className="text-primary hover:underline">
          {t("common:actions.retry")}
        </button>
      </div>
    );
  }
  if (rows.length === 0) return null;

  const earliest = rows.reduce((min, r) => (r.usedBefore < min ? r.usedBefore : min), rows[0]!.usedBefore);

  return (
    <div
      className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm"
      data-testid="storage-credential-revocation"
      role="region"
      aria-label={t("configurationPolicies.featureTabs.backupTab.storageKeys.title", { date: formatDate(earliest) })}
    >
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
        <div>
          <p className="font-medium">{t("configurationPolicies.featureTabs.backupTab.storageKeys.title", { date: formatDate(earliest) })}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("configurationPolicies.featureTabs.backupTab.storageKeys.body", { date: formatDate(earliest) })}</p>
        </div>
      </div>
      <ul className="space-y-2">
        {rows.map((row) => {
          const outcome: CheckResult | null = outcomes[row.id]
            ?? (row.lastCheckOutcome ? { outcome: row.lastCheckOutcome, code: row.lastCheckCode } : null);
          const busy = busyId === row.id;
          return (
            <li
              key={row.id}
              className="rounded-md border bg-background p-3"
              data-testid="storage-credential-revocation-row"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{row.configName ?? t("configurationPolicies.featureTabs.backupTab.storageKeys.deletedDestination")}</span>
                <span className="text-xs text-muted-foreground">
                  {[row.bucket, row.endpoint].filter(Boolean).join(" · ")}
                </span>
              </div>
              {row.replacedAt === null ? (
                <p className="mt-1 text-xs text-muted-foreground">{t("configurationPolicies.featureTabs.backupTab.storageKeys.inUse")}</p>
              ) : (
                <>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("configurationPolicies.featureTabs.backupTab.storageKeys.replacedOn", { date: formatDateTime(row.replacedAt) })}
                  </p>
                  {outcome && outcome.outcome !== "revoked" ? (
                    <p className="mt-1 text-xs text-amber-700">{outcomeMessage(outcome)}</p>
                  ) : null}
                  {!row.canCheck ? <p className="mt-1 text-xs text-muted-foreground">{t("configurationPolicies.featureTabs.backupTab.storageKeys.cannotCheck")}</p> : null}
                  {confirmingId === row.id ? (
                    <div className="mt-2 space-y-2 rounded-md border border-muted bg-muted/20 p-2 text-xs">
                      <p>{t("configurationPolicies.featureTabs.backupTab.storageKeys.confirmPrompt")}</p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void confirmDisabled(row)}
                          className="rounded-md border border-primary px-2 py-1 font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
                        >
                          {t("common:actions.confirm")}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmingId(null)}
                          className="rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-50"
                        >
                          {t("common:actions.cancel")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {row.canCheck ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void check(row)}
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                        >
                          {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                          {t("configurationPolicies.featureTabs.backupTab.storageKeys.checkOldKey")}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmingId(row.id)}
                        className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                      >
                        {t("configurationPolicies.featureTabs.backupTab.storageKeys.confirmDisabled")}
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
