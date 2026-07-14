import { useCallback, useEffect, useState } from "react";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, handleActionError, ActionError } from "../../lib/runAction";
import { showToast } from "../shared/Toast";
import {
  listContracts,
  getContract,
  addContractLine,
  type ContractSummary,
  type ContractLine,
} from "../../lib/api/contracts";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

const NEW_LINE = "__new__";
const MONEY_RE = /^\d+(\.\d{1,2})?$/;

/** Pax8 link/create writes are MFA-gated server-side; a 403 "MFA required" should
 *  read as a setup hint, mirroring the sibling actions in Pax8Integration. */
function isMfaError(err: unknown): boolean {
  return (
    err instanceof ActionError &&
    err.status === 403 &&
    /mfa required/i.test(err.message)
  );
}

/** Seed the new-line "Unit price" from the Pax8 subscription's sell price, which
 *  the partner sets per-subscription in Pax8 and is the accurate price to bill.
 *  The snapshot stores it as a numeric(12,2) string; coerce to a clean 2-decimal
 *  value that satisfies MONEY_RE, falling back to blank for missing, zero, or
 *  unparseable prices. */
function toPriceInput(value: string | null): string {
  if (value == null) return "";
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : "";
}

interface LinkSubscriptionPickerProps {
  integrationId: string;
  subscription: {
    id: string;
    orgId: string;
    productName: string | null;
    quantity: number | null;
    unitPrice: string | null;
  };
  onDone: () => void;
  onCancel: () => void;
}

export default function LinkSubscriptionPicker({
  integrationId,
  subscription,
  onDone,
  onCancel,
}: LinkSubscriptionPickerProps) {
  const { t } = useTranslation("integrations");
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [contractId, setContractId] = useState("");
  const [lines, setLines] = useState<ContractLine[]>([]);
  const [lineId, setLineId] = useState("");
  const [newDesc, setNewDesc] = useState(subscription.productName ?? "");
  const [newPrice, setNewPrice] = useState(() =>
    toPriceInput(subscription.unitPrice),
  );
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await listContracts({ orgId: subscription.orgId });
      if (!res.ok) {
        // Load-bearing read: an empty dropdown must not be mistaken for "no contracts".
        setError(
          t(
            "linkSubscriptionPicker.couldNotLoadContractsForThisOrganizationClose",
          ),
        );
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        data?: ContractSummary[];
      } | null;
      setContracts(
        (body?.data ?? []).filter(
          (c) => c.status !== "cancelled" && c.status !== "expired",
        ),
      );
    })();
  }, [subscription.orgId]);

  const onContract = useCallback(async (id: string) => {
    setContractId(id);
    setLineId("");
    setLines([]);
    setError(null);
    if (!id) return;
    const res = await getContract(id);
    if (!res.ok) {
      // Surface the failure: an empty line list would otherwise invite a duplicate
      // manual line for one that exists but failed to load.
      setError(
        t("linkSubscriptionPicker.couldNotLoadThisContractsLinesPickThe"),
      );
      return;
    }
    const body = (await res.json().catch(() => null)) as {
      data?: { lines?: ContractLine[] };
    } | null;
    setLines((body?.data?.lines ?? []).filter((l) => l.lineType === "manual"));
  }, []);

  const newPriceValid = MONEY_RE.test(newPrice.trim());
  const canSubmit =
    !busy &&
    contractId !== "" &&
    lineId !== "" &&
    (lineId !== NEW_LINE || (newDesc.trim() !== "" && newPriceValid));

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      let contractLineId = lineId;
      if (lineId === NEW_LINE) {
        const line = await runAction<{ id: string }>({
          request: () =>
            addContractLine(contractId, {
              lineType: "manual",
              description: newDesc.trim(),
              unitPrice: newPrice.trim(),
              taxable: false,
              manualQuantity: String(subscription.quantity ?? 0),
            }),
          errorFallback: t(
            "linkSubscriptionPicker.couldNotCreateTheContractLine",
          ),
          parseSuccess: (d) => (d as { data: { id: string } }).data,
        });
        contractLineId = line.id;
      }
      await runAction({
        request: () =>
          fetchWithAuth("/pax8/subscriptions/link", {
            method: "POST",
            body: JSON.stringify({
              integrationId,
              subscriptionSnapshotId: subscription.id,
              contractLineId,
              syncEnabled,
            }),
          }),
        errorFallback: t("linkSubscriptionPicker.couldNotLinkTheSubscription"),
        successMessage: t("linkSubscriptionPicker.subscriptionLinked"),
      });
      onDone();
    } catch (err) {
      // Mirror the sibling Unlink/Pause buttons: surface MFA as an actionable hint
      // rather than the generic fallback (the 403 body is plain text, so runAction
      // can't recover it on its own).
      if (isMfaError(err)) {
        showToast({
          type: "error",
          message: t("linkSubscriptionPicker.mfaRequiredHint"),
        });
        return;
      }
      handleActionError(
        err,
        t("linkSubscriptionPicker.couldNotLinkTheSubscription"),
      );
    } finally {
      setBusy(false);
    }
  }, [
    canSubmit,
    lineId,
    contractId,
    newDesc,
    newPrice,
    subscription,
    integrationId,
    syncEnabled,
    onDone,
  ]);

  return (
    <div
      className="mt-2 rounded-md border bg-background/40 p-3 text-sm"
      data-testid="pax8-link-picker"
    >
      {error && (
        <p
          className="mb-2 text-xs text-destructive"
          data-testid="pax8-link-error"
        >
          {error}
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">
            {t("linkSubscriptionPicker.contract")}
          </span>
          <select
            value={contractId}
            onChange={(e) => void onContract(e.target.value)}
            data-testid="pax8-link-contract"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            <option value="">
              {t("linkSubscriptionPicker.selectAContract")}
            </option>
            {contracts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {contractId && (
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">
              {t("linkSubscriptionPicker.line")}
            </span>
            <select
              value={lineId}
              onChange={(e) => setLineId(e.target.value)}
              data-testid="pax8-link-line"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="">
                {t("linkSubscriptionPicker.selectALine")}
              </option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.description}
                </option>
              ))}
              <option value={NEW_LINE}>
                {t("linkSubscriptionPicker.newManualLine")}
              </option>
            </select>
          </label>
        )}
      </div>

      {lineId === NEW_LINE && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <input
            type="text"
            value={newDesc}
            placeholder={t("linkSubscriptionPicker.lineDescription")}
            onChange={(e) => setNewDesc(e.target.value)}
            data-testid="pax8-link-new-desc"
            className="h-9 rounded-md border bg-background px-3 text-sm"
          />
          <input
            type="text"
            inputMode="decimal"
            value={newPrice}
            placeholder={t("linkSubscriptionPicker.unitPriceEG3600")}
            onChange={(e) => setNewPrice(e.target.value)}
            data-testid="pax8-link-new-price"
            className="h-9 rounded-md border bg-background px-3 text-sm"
          />
        </div>
      )}

      <div className="mt-3 flex items-center justify-between">
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={syncEnabled}
            onChange={(e) => setSyncEnabled(e.target.checked)}
            data-testid="pax8-link-sync"
          />
          {t("linkSubscriptionPicker.trackQuantityForDrift")}
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            data-testid="pax8-link-cancel"
            className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {t("common:actions.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            data-testid="pax8-link-submit"
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {t("linkSubscriptionPicker.linkSubscription")}
          </button>
        </div>
      </div>
    </div>
  );
}
