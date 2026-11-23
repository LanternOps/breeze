// Site Manager API keys for a cloud UniFi connection (#11808). One row per key
// with its health, what only it can see, and the row actions. Remove and
// Disable confirm first and name the MAPPED sites that stop syncing.

import { useMemo, useState } from "react";
import { KeyRound, Loader2, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { uniqueSitesForKey } from "./unifiHelpers";
import { mapKey } from "./unifiTypes";
import type {
  SavedMapping,
  UnifiHostOption,
  UnifiKeyStatus,
  UnifiKeySummary,
} from "./unifiTypes";
import { useUnifiKeys } from "./useUnifiKeys";

interface ApiKeysCardProps {
  keys: UnifiKeySummary[];
  hosts: UnifiHostOption[];
  mappings: SavedMapping[];
  // False when the last live read missed a key: the unique-site counts and the
  // confirm lists are then lower bounds.
  hostsComplete: boolean;
  onChanged: () => void;
}

function statusClasses(status: UnifiKeyStatus): string {
  switch (status) {
    case "connected":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "reauth_required":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "error":
      return "border-red-200 bg-red-50 text-red-700";
    default:
      return "border-slate-200 bg-slate-50 text-slate-600";
  }
}

type Pending = { kind: "remove" | "disable"; key: UnifiKeySummary };

export default function ApiKeysCard({
  keys,
  hosts,
  mappings,
  hostsComplete,
  onChanged,
}: ApiKeysCardProps) {
  const { t } = useTranslation("integrations");
  const k = useUnifiKeys({ onChanged });
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(
    null,
  );
  const [replacing, setReplacing] = useState<{
    id: string;
    value: string;
  } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const mappedKeys = useMemo(
    () => new Set(mappings.map((m) => mapKey(m.unifiHostId, m.unifiSiteId))),
    [mappings],
  );

  const uniqueByKey = useMemo(
    () => new Map(keys.map((key) => [key.id, uniqueSitesForKey(hosts, key.id)])),
    [keys, hosts],
  );

  const statusLabel = (key: UnifiKeySummary): string => {
    if (!key.isEnabled) return t("unifiIntegration.keyStatusDisabled");
    switch (key.status) {
      case "connected":
        return t("unifiIntegration.keyStatusConnected");
      case "reauth_required":
        return t("unifiIntegration.keyStatusReauth");
      case "error":
        return t("unifiIntegration.keyStatusError");
      default:
        return t("unifiIntegration.keyStatusPending");
    }
  };

  const handleAdd = async () => {
    if (!newLabel.trim() || !newKey.trim()) return;
    if (await k.addKey(newLabel, newKey)) {
      setNewLabel("");
      setNewKey("");
    }
  };

  const confirmPending = async () => {
    if (!pending) return;
    if (pending.kind === "remove") await k.removeKey(pending.key.id);
    else await k.disableKey(pending.key.id);
    // Success or refusal, close: a refusal already toasted its reason (for
    // example the last enabled key), and the card must not stay behind a
    // modal the server will keep rejecting.
    setPending(null);
  };

  const affected = pending
    ? (uniqueByKey.get(pending.key.id) ?? []).filter((s) =>
        mappedKeys.has(mapKey(s.hostId, s.siteId)),
      )
    : [];

  return (
    <div
      id="unifi-keys-card"
      className="rounded-xl border bg-card p-5 shadow-xs"
      data-testid="unifi-keys-card"
    >
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">
          {t("unifiIntegration.keysTitle")}
        </h2>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        {t("unifiIntegration.keysDescription")}
      </p>

      {keys.length === 0 ? (
        <p
          className="py-4 text-sm text-muted-foreground"
          data-testid="unifi-keys-empty"
        >
          {t("unifiIntegration.keysEmpty")}
        </p>
      ) : (
        <ul className="divide-y">
          {keys.map((key) => {
            const unique = uniqueByKey.get(key.id) ?? [];
            const rowBusy = k.busy === key.id;
            return (
              <li
                key={key.id}
                className="space-y-2 py-3"
                data-testid={`unifi-key-row-${key.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {renaming?.id === key.id ? (
                    <>
                      <input
                        type="text"
                        value={renaming.value}
                        onChange={(e) =>
                          setRenaming({ id: key.id, value: e.target.value })
                        }
                        className="h-8 rounded-md border bg-background px-2 text-sm"
                        aria-label={t("unifiIntegration.keyLabelField")}
                        data-testid={`unifi-key-rename-input-${key.id}`}
                      />
                      <button
                        type="button"
                        disabled={rowBusy || !renaming.value.trim()}
                        onClick={async () => {
                          if (await k.renameKey(key.id, renaming.value))
                            setRenaming(null);
                        }}
                        className="h-8 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                        data-testid={`unifi-key-rename-save-${key.id}`}
                      >
                        {t("unifiIntegration.keySave")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenaming(null)}
                        className="h-8 rounded-md border px-2.5 text-xs font-medium hover:bg-muted"
                      >
                        {t("common:actions.cancel")}
                      </button>
                    </>
                  ) : (
                    <span className="font-medium" data-testid={`unifi-key-label-${key.id}`}>
                      {key.label}
                    </span>
                  )}
                  <span
                    className="font-mono text-xs text-muted-foreground"
                    data-testid={`unifi-key-mask-${key.id}`}
                  >
                    {`••••${key.keyLast4 ?? ""}`}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${statusClasses(key.isEnabled ? key.status : "pending")}`}
                    data-status={key.status}
                    title={key.lastSyncError ?? undefined}
                    data-testid={`unifi-key-status-${key.id}`}
                  >
                    {statusLabel(key)}
                  </span>
                </div>

                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
                  <div>
                    <dt>{t("unifiIntegration.keyLastOk")}</dt>
                    <dd className="text-foreground" data-testid={`unifi-key-last-ok-${key.id}`}>
                      {key.lastOkAt
                        ? formatDateTime(key.lastOkAt)
                        : t("unifiIntegration.never")}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("unifiIntegration.keyHostsSeen")}</dt>
                    <dd className="text-foreground">{key.hostsSeen ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>{t("unifiIntegration.keySitesSeen")}</dt>
                    <dd className="text-foreground">{key.sitesSeen ?? "—"}</dd>
                  </div>
                  <div data-testid={`unifi-key-unique-sites-${key.id}`}>
                    <dt>{t("unifiIntegration.keyUniqueSites")}</dt>
                    <dd className="text-foreground">
                      <span data-testid={`unifi-key-unique-count-${key.id}`}>
                        {unique.length}
                      </span>
                      {!hostsComplete && (
                        <span
                          className="ml-1 text-amber-700"
                          data-testid={`unifi-key-unique-incomplete-${key.id}`}
                        >
                          {t("unifiIntegration.keyUniqueIncomplete")}
                        </span>
                      )}
                    </dd>
                  </div>
                </dl>

                {replacing?.id === key.id && (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="password"
                      autoComplete="off"
                      value={replacing.value}
                      onChange={(e) =>
                        setReplacing({ id: key.id, value: e.target.value })
                      }
                      placeholder={t("unifiIntegration.keyApiKeyPlaceholder")}
                      aria-label={t("unifiIntegration.keyApiKeyPlaceholder")}
                      className="h-8 w-64 rounded-md border bg-background px-2 text-sm"
                      data-testid={`unifi-key-replace-input-${key.id}`}
                    />
                    <button
                      type="button"
                      disabled={rowBusy || !replacing.value.trim()}
                      onClick={async () => {
                        const ok = await k.replaceKey(key.id, replacing.value);
                        if (ok) setReplacing(null);
                      }}
                      className="h-8 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                      data-testid={`unifi-key-replace-save-${key.id}`}
                    >
                      {t("unifiIntegration.keySave")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setReplacing(null)}
                      className="h-8 rounded-md border px-2.5 text-xs font-medium hover:bg-muted"
                    >
                      {t("common:actions.cancel")}
                    </button>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {rowBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  <button
                    type="button"
                    disabled={rowBusy}
                    onClick={() => setRenaming({ id: key.id, value: key.label })}
                    className="h-8 rounded-md border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    data-testid={`unifi-key-rename-${key.id}`}
                  >
                    {t("unifiIntegration.keyRename")}
                  </button>
                  <button
                    type="button"
                    disabled={rowBusy}
                    onClick={() => setReplacing({ id: key.id, value: "" })}
                    className="h-8 rounded-md border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    data-testid={`unifi-key-replace-${key.id}`}
                  >
                    {t("unifiIntegration.keyReplace")}
                  </button>
                  <button
                    type="button"
                    disabled={rowBusy}
                    onClick={() => {
                      if (key.isEnabled) setPending({ kind: "disable", key });
                      else void k.enableKey(key.id);
                    }}
                    className="h-8 rounded-md border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    data-testid={`unifi-key-toggle-${key.id}`}
                  >
                    {key.isEnabled
                      ? t("unifiIntegration.keyDisable")
                      : t("unifiIntegration.keyEnable")}
                  </button>
                  <button
                    type="button"
                    disabled={rowBusy}
                    onClick={() => void k.testKey(key.id)}
                    className="h-8 rounded-md border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    data-testid={`unifi-key-test-${key.id}`}
                  >
                    {t("unifiIntegration.keyTest")}
                  </button>
                  <button
                    type="button"
                    disabled={rowBusy}
                    onClick={() => setPending({ kind: "remove", key })}
                    className="h-8 rounded-md border border-red-200 px-2.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                    data-testid={`unifi-key-remove-${key.id}`}
                  >
                    {t("unifiIntegration.keyRemove")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-2 border-t pt-4">
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder={t("unifiIntegration.keyLabelPlaceholder")}
          aria-label={t("unifiIntegration.keyLabelField")}
          className="h-9 w-48 rounded-md border bg-background px-2 text-sm"
          data-testid="unifi-key-add-label"
        />
        <input
          type="password"
          autoComplete="off"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder={t("unifiIntegration.keyApiKeyPlaceholder")}
          aria-label={t("unifiIntegration.keyApiKeyPlaceholder")}
          className="h-9 w-64 rounded-md border bg-background px-2 text-sm"
          data-testid="unifi-key-add-key"
        />
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={k.busy === "add" || !newLabel.trim() || !newKey.trim()}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          data-testid="unifi-key-add"
        >
          {k.busy === "add" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {t("unifiIntegration.keyAdd")}
        </button>
      </div>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => void confirmPending()}
        title={
          pending?.kind === "remove"
            ? t("unifiIntegration.keyConfirmRemoveTitle", {
                label: pending.key.label,
              })
            : t("unifiIntegration.keyConfirmDisableTitle", {
                label: pending?.key.label ?? "",
              })
        }
        confirmLabel={
          pending?.kind === "remove"
            ? t("unifiIntegration.keyRemove")
            : t("unifiIntegration.keyDisable")
        }
        isLoading={pending !== null && k.busy === pending.key.id}
        confirmTestId="unifi-key-confirm"
        dialogTestId="unifi-key-confirm-dialog"
        message={
          <div className="space-y-2 text-sm">
            {affected.length > 0 ? (
              <>
                <p>{t("unifiIntegration.keyConfirmAffected")}</p>
                <ul
                  className="list-disc pl-5"
                  data-testid="unifi-key-confirm-sites"
                >
                  {affected.map((s) => (
                    <li key={mapKey(s.hostId, s.siteId)}>
                      {s.hostName} / {s.siteName}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{t("unifiIntegration.keyConfirmNoneAffected")}</p>
            )}
            {!hostsComplete && (
              <p className="text-amber-700">
                {t("unifiIntegration.keyConfirmIncomplete")}
              </p>
            )}
          </div>
        }
      />
    </div>
  );
}
