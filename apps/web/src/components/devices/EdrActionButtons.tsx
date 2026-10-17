import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { showToast } from "../shared/Toast";
import {
  edrProviderLabel,
  requestEdrEndpointAction,
  type EdrActionItemResult,
  type EdrEndpoint,
} from "@/lib/edrProviders";
import { ActionError, handleActionError } from "@/lib/runAction";
import "@/lib/i18n";

/** Mirrors `EDR_ACTIONS_DISABLED_REASON` (apps/api/src/services/edrProviders/actions.ts). */
const KILL_SWITCH_REASON = "Response actions are disabled on this server";

/**
 * The actions an adapter implements today (W03: isolate / unisolate / scan, the
 * same set the AI tool offers). Others (update_agent, kill_process) would only
 * render as permanently disabled buttons.
 */
const SUPPORTED = ["isolate", "unisolate", "scan"] as const;
type SupportedAction = (typeof SUPPORTED)[number];
const NEEDS_CONFIRM: ReadonlySet<string> = new Set(["isolate", "unisolate"]);

const isSupported = (a: string): a is SupportedAction => (SUPPORTED as readonly string[]).includes(a);
const outcomeUnknown = (r: { data?: EdrActionItemResult[] } | undefined) =>
  r?.data?.some((i) => i.outcomeUnknown === true) === true;

type Props = {
  endpoint: EdrEndpoint;
  deviceName: string;
  /** Called after a request is accepted so the parent can refresh the ledger. */
  onActionTaken: () => void;
};

export default function EdrActionButtons({ endpoint, deviceName, onActionTaken }: Props) {
  const { t } = useTranslation("devices");
  const [busy, setBusy] = useState<SupportedAction | null>(null);
  const [pending, setPending] = useState<SupportedAction | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);

  const actions = (endpoint.actions ?? []).filter((a) => isSupported(a.action));
  if (actions.length === 0) return null;
  if (actions.every((a) => !a.available && a.reason === KILL_SWITCH_REASON)) return null;

  const vendor = edrProviderLabel(endpoint.provider) ?? endpoint.provider;
  const label = (a: string) => t(/* i18n-dynamic */ `deviceEdrGenericSection.actions.label.${a}`);
  const needsMfa = actions.some((a) => a.mfaRequired);

  const run = async (action: SupportedAction, why: string) => {
    setBusy(action);
    try {
      await requestEdrEndpointAction(endpoint.id, action, why.trim() || undefined, {
        errorFallback: t("deviceEdrGenericSection.actions.error"),
        // An unknown outcome is neither a success nor an error: stay quiet and
        // show the neutral "confirming" note instead.
        successMessage: (r) =>
          outcomeUnknown(r) ? "" : t("deviceEdrGenericSection.actions.requested", { action: label(action), device: deviceName }),
        suppressErrorToast: (status, code) => status === 409 && code === "action_in_progress",
      }).then((r) => {
        if (outcomeUnknown(r)) setConfirming(true);
      });
      onActionTaken();
    } catch (err) {
      if (err instanceof ActionError && err.status === 409 && err.code === "action_in_progress") {
        showToast({ type: "warning", message: t("deviceEdrGenericSection.actions.inProgress") });
      } else {
        handleActionError(err, t("deviceEdrGenericSection.actions.error"));
      }
    } finally {
      setBusy(null);
      setPending(null);
      setReason("");
    }
  };

  const onClick = (action: SupportedAction) => {
    if (NEEDS_CONFIRM.has(action)) {
      setPending(action);
      return;
    }
    void run(action, "");
  };

  return (
    <div className="mt-3" data-testid="edr-actions">
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((a) => (
          <button
            key={a.action}
            type="button"
            data-testid={`edr-action-${a.action}`}
            disabled={!a.available || busy !== null}
            title={a.available ? undefined : (a.reason ?? t("deviceEdrGenericSection.actions.unavailable"))}
            onClick={() => onClick(a.action as SupportedAction)}
            className="rounded-md border bg-card px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            {label(a.action)}
          </button>
        ))}
      </div>
      {needsMfa && (
        <p data-testid="edr-actions-mfa" className="mt-2 text-xs text-muted-foreground">
          {t("deviceEdrGenericSection.actions.mfaRequired")}
        </p>
      )}
      {confirming && (
        <p data-testid="edr-action-confirming" className="mt-2 text-xs text-muted-foreground">
          {t("deviceEdrGenericSection.actions.confirming", { vendor })}
        </p>
      )}
      <ConfirmDialog
        open={pending !== null}
        onClose={() => {
          if (busy === null) {
            setPending(null);
            setReason("");
          }
        }}
        onConfirm={() => pending && void run(pending, reason)}
        title={t(/* i18n-dynamic */ `deviceEdrGenericSection.actions.confirm.${pending ?? "isolate"}.title`, { device: deviceName })}
        message={t(/* i18n-dynamic */ `deviceEdrGenericSection.actions.confirm.${pending ?? "isolate"}.message`, {
          device: deviceName,
          vendor,
        })}
        confirmLabel={label(pending ?? "isolate")}
        variant={pending === "isolate" ? "destructive" : "warning"}
        isLoading={busy !== null}
        confirmTestId="edr-action-confirm"
      >
        <label className="mt-3 block text-sm">
          <span className="text-xs text-muted-foreground">{t("deviceEdrGenericSection.actions.reasonLabel")}</span>
          <textarea
            data-testid="edr-action-reason"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
          />
        </label>
      </ConfirmDialog>
    </div>
  );
}
