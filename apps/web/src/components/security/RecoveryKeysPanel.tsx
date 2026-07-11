import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Copy,
  Eye,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { cn, friendlyFetchError } from "@/lib/utils";
import { formatDateTime as formatUserDateTime } from "@/lib/dateTimeFormat";
import { fetchWithAuth } from "@/stores/auth";
import { ActionError, handleActionError, runAction } from "@/lib/runAction";
type KeyMeta = {
  id: string;
  keyType: "bitlocker_recovery_password" | "filevault_personal_recovery_key";
  volumeMount: string | null;
  protectorId: string | null;
  status: "active" | "superseded";
  escrowedAt: string;
  supersededAt: string | null;
};
type AccessEvent = {
  id: string;
  keyId: string;
  userEmail: string;
  action: string;
  createdAt: string;
};
type PanelData = {
  device: {
    id: string;
    hostname: string;
    os: string;
  };
  keys: KeyMeta[];
  accessHistory: AccessEvent[];
};
function fmt(value: string | null, timezone?: string): string {
  if (!value) return "-";
  return formatUserDateTime(
    value,
    timezone ? { timeZone: timezone, fallback: "-" } : { fallback: "-" },
  );
}
export default function RecoveryKeysPanel({
  deviceId,
  timezone,
}: {
  deviceId: string;
  timezone?: string;
}) {
  const { t } = useTranslation("security");
  const [data, setData] = useState<PanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateForm, setRotateForm] = useState({
    username: "",
    password: "",
    currentRecoveryKey: "",
  });
  const [rotating, setRotating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const keyTypeLabels: Record<KeyMeta["keyType"], string> = {
    bitlocker_recovery_password: t("securityRecoveryKeysPanel.bitlocker"),
    filevault_personal_recovery_key: t("securityRecoveryKeysPanel.filevault"),
  };
  const fetchKeys = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(undefined);
    try {
      const res = await fetchWithAuth(
        `/security/encryption/devices/${deviceId}/recovery-keys`,
        { signal: controller.signal },
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      setData(json.data ?? null);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [deviceId]);
  useEffect(() => {
    fetchKeys();
    return () => abortRef.current?.abort();
  }, [fetchKeys]);
  const revealKey = async (keyId: string) => {
    setBusyKeyId(keyId);
    try {
      const key = await runAction<string>({
        request: () =>
          fetchWithAuth(
            `/security/encryption/devices/${deviceId}/recovery-keys/${keyId}/reveal`,
            { method: "POST" },
          ),
        errorFallback: t("securityRecoveryKeysPanel.failedToRevealRecoveryKey"),
        parseSuccess: (body) =>
          (
            body as {
              data: {
                recoveryKey: string;
              };
            }
          ).data.recoveryKey,
      });
      setRevealed((prev) => ({ ...prev, [keyId]: key }));
      fetchKeys(); // refresh access history with this reveal
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError))
        handleActionError(
          err,
          t("securityRecoveryKeysPanel.failedToRevealRecoveryKey"),
        );
    } finally {
      setBusyKeyId(null);
    }
  };
  const rotate = async () => {
    const os = data?.device.os ?? "";
    setRotating(true);
    try {
      const body =
        os === "macos"
          ? {
              username: rotateForm.username || undefined,
              password: rotateForm.password || undefined,
              currentRecoveryKey: rotateForm.currentRecoveryKey || undefined,
            }
          : {};
      await runAction({
        request: () =>
          fetchWithAuth(
            `/security/encryption/devices/${deviceId}/recovery-keys/rotate`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
          ),
        errorFallback: t("securityRecoveryKeysPanel.failedToQueueKeyRotation"),
        successMessage: t(
          "securityRecoveryKeysPanel.keyRotationQueuedTheNewKeyWill",
        ),
      });
      setRotateOpen(false);
      setRotateForm({ username: "", password: "", currentRecoveryKey: "" });
      fetchKeys();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError))
        handleActionError(
          err,
          t("securityRecoveryKeysPanel.failedToQueueKeyRotation"),
        );
    } finally {
      setRotating(false);
    }
  };
  const collectNow = async () => {
    try {
      await runAction({
        request: () =>
          fetchWithAuth(
            `/security/encryption/devices/${deviceId}/recovery-keys/collect`,
            { method: "POST" },
          ),
        errorFallback: t(
          "securityRecoveryKeysPanel.failedToQueueKeyCollection",
        ),
        successMessage: t("securityRecoveryKeysPanel.keyCollectionQueued"),
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError))
        handleActionError(
          err,
          t("securityRecoveryKeysPanel.failedToQueueKeyCollection"),
        );
    }
  };
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error) {
    return <p className="py-4 text-sm text-destructive">{error}</p>;
  }
  const os = data?.device.os ?? "";
  const canRotate = os === "windows" || os === "macos";
  const canCollect = os === "windows";
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          <KeyRound className="h-4 w-4" />
          {t("securityRecoveryKeysPanel.recoveryKeys")}
        </h4>
        <div className="flex gap-2">
          {canCollect && (
            <button
              type="button"
              onClick={collectNow}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted/40"
            >
              <RefreshCw className="h-3 w-3" />
              {t("securityRecoveryKeysPanel.collectNow")}
            </button>
          )}
          {canRotate && (
            <button
              type="button"
              onClick={() => setRotateOpen(true)}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted/40"
            >
              <RotateCcw className="h-3 w-3" />
              {t("securityRecoveryKeysPanel.rotateKey")}
            </button>
          )}
        </div>
      </div>

      {(data?.keys.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("securityRecoveryKeysPanel.noRecoveryKeysEscrowed")}
          {os === "macos" &&
            t("securityRecoveryKeysPanel.filevaultKeysCanOnlyBeCapturedBy")}
          {os === "linux" &&
            t("securityRecoveryKeysPanel.recoveryKeyEscrowIsNotSupportedOn")}
        </p>
      ) : (
        <div className="space-y-2">
          {data!.keys.map((k) => (
            <div
              key={k.id}
              className={cn(
                "rounded-md border p-3",
                k.status === "superseded" && "opacity-70",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm">
                  <span className="font-medium">
                    {keyTypeLabels[k.keyType]}
                  </span>
                  {k.volumeMount && (
                    <span className="ml-2 text-muted-foreground">
                      {k.volumeMount}
                    </span>
                  )}
                  <span
                    className={cn(
                      "ml-2 inline-flex rounded-full border px-2 py-0.5 text-xs",
                      k.status === "active"
                        ? "bg-emerald-500/15 text-emerald-700 border-emerald-500/30"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {k.status}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {t("securityRecoveryKeysPanel.escrowed")}
                    {fmt(k.escrowedAt, timezone)}
                  </span>
                  {revealed[k.id] ? (
                    <button
                      type="button"
                      onClick={() =>
                        navigator.clipboard.writeText(revealed[k.id])
                      }
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted/40"
                    >
                      <Copy className="h-3 w-3" />
                      {t("securityRecoveryKeysPanel.copy")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busyKeyId === k.id}
                      onClick={() => revealKey(k.id)}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted/40 disabled:opacity-50"
                    >
                      {busyKeyId === k.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Eye className="h-3 w-3" />
                      )}
                      {t("securityRecoveryKeysPanel.reveal")}
                    </button>
                  )}
                </div>
              </div>
              {revealed[k.id] && (
                <div className="mt-2 rounded bg-muted/40 p-2">
                  <code className="break-all font-mono text-sm">
                    {revealed[k.id]}
                  </code>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(
                      "securityRecoveryKeysPanel.thisAccessHasBeenRecordedInThe",
                    )}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {(data?.accessHistory.length ?? 0) > 0 && (
        <div>
          <h5 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
            {t("securityRecoveryKeysPanel.recentAccess")}
          </h5>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {data!.accessHistory.map((event) => (
              <li key={event.id}>
                {event.userEmail} {event.action} ·{" "}
                {fmt(event.createdAt, timezone)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rotateOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !rotating && setRotateOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg border bg-card p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="text-sm font-semibold">
              {t("securityRecoveryKeysPanel.rotateRecoveryKey")}
            </h4>
            {os === "macos" ? (
              <>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t(
                    "securityRecoveryKeysPanel.macosOnlyRevealsTheFileVaultPersonalRecovery",
                  )}
                </p>
                <div className="mt-3 space-y-2">
                  <input
                    type="text"
                    placeholder={t(
                      "securityRecoveryKeysPanel.filevaultUsername",
                    )}
                    value={rotateForm.username}
                    onChange={(e) =>
                      setRotateForm((f) => ({ ...f, username: e.target.value }))
                    }
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  />
                  <input
                    type="password"
                    placeholder={t("securityRecoveryKeysPanel.password")}
                    value={rotateForm.password}
                    onChange={(e) =>
                      setRotateForm((f) => ({ ...f, password: e.target.value }))
                    }
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  />
                  <p className="text-center text-xs text-muted-foreground">
                    {t("securityRecoveryKeysPanel.or")}
                  </p>
                  <input
                    type="text"
                    placeholder={t(
                      "securityRecoveryKeysPanel.currentRecoveryKey",
                    )}
                    value={rotateForm.currentRecoveryKey}
                    onChange={(e) =>
                      setRotateForm((f) => ({
                        ...f,
                        currentRecoveryKey: e.target.value,
                      }))
                    }
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </div>
              </>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                {t(
                  "securityRecoveryKeysPanel.aNewBitLockerRecoveryPasswordWillBe",
                )}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={rotating}
                onClick={() => setRotateOpen(false)}
                className="rounded-md border px-3 py-1.5 text-sm"
              >
                {t("securityRecoveryKeysPanel.cancel")}
              </button>
              <button
                type="button"
                disabled={
                  rotating ||
                  (os === "macos" &&
                    !(
                      (rotateForm.username && rotateForm.password) ||
                      rotateForm.currentRecoveryKey
                    ))
                }
                onClick={rotate}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
              >
                {rotating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  t("securityRecoveryKeysPanel.rotate")
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
