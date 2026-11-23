// Mutations for the UniFi Site Manager API keys card (#11808): add, rename,
// replace, enable/disable, test, remove. Every one goes through runAction
// (which toasts the outcome); each resolves true only when the API accepted it
// so callers can clear inputs / close dialogs on success and keep them on
// failure. A key value is only ever held in the caller's input state and sent
// once - never logged or echoed back.

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { fetchWithAuth } from "../../../stores/auth";
import { ActionError, runAction } from "../../../lib/runAction";
import { navigateTo } from "@/lib/navigation";
import { loginPathWithNext } from "../../../lib/authScope";
import { showToast } from "../../shared/Toast";

interface UseUnifiKeysArgs {
  onChanged: () => void;
}

export function useUnifiKeys({ onChanged }: UseUnifiKeysArgs) {
  const { t } = useTranslation("integrations");
  // Id of the key (or "add") whose request is in flight.
  const [busy, setBusy] = useState<string | null>(null);

  const friendly = useCallback(
    (code: string, message: string) => {
      switch (code) {
        case "UNIFI_KEY_LIMIT":
          return t("unifiIntegration.keyLimitReached");
        case "UNIFI_KEY_LABEL_TAKEN":
          return t("unifiIntegration.keyLabelTaken");
        case "UNIFI_LAST_ENABLED_KEY":
          return t("unifiIntegration.keyLastEnabled");
        case "UNIFI_KEY_NOT_FOUND":
          return t("unifiIntegration.keyNotFound");
        default:
          return message || undefined;
      }
    },
    [t],
  );

  const run = useCallback(
    async <T,>(
      busyId: string,
      opts: {
        request: () => Promise<Response>;
        errorFallback: string;
        successMessage?: string | ((data: T) => string);
      },
    ): Promise<T | undefined> => {
      setBusy(busyId);
      try {
        const result = await runAction<T>({
          ...opts,
          friendly,
          onUnauthorized: () => navigateTo(loginPathWithNext()),
        });
        onChanged();
        return result;
      } catch (err) {
        // 401: the auth redirect is the feedback. ActionError: already toasted.
        if (!(err instanceof ActionError))
          showToast({ message: opts.errorFallback, type: "error" });
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [friendly, onChanged],
  );

  const addKey = useCallback(
    async (label: string, apiKey: string) =>
      (await run("add", {
        request: () =>
          fetchWithAuth("/unifi/keys", {
            method: "POST",
            body: JSON.stringify({ label: label.trim(), apiKey: apiKey.trim() }),
          }),
        errorFallback: t("unifiIntegration.failedToAddKey"),
        successMessage: t("unifiIntegration.keyAdded"),
      })) !== undefined,
    [run, t],
  );

  const patchKey = useCallback(
    async (
      keyId: string,
      body: { label?: string; isEnabled?: boolean; apiKey?: string },
      successMessage: string,
    ) =>
      (await run(keyId, {
        request: () =>
          fetchWithAuth(`/unifi/keys/${encodeURIComponent(keyId)}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          }),
        errorFallback: t("unifiIntegration.failedToUpdateKey"),
        successMessage,
      })) !== undefined,
    [run, t],
  );

  const renameKey = useCallback(
    (keyId: string, label: string) =>
      patchKey(keyId, { label: label.trim() }, t("unifiIntegration.keyRenamed")),
    [patchKey, t],
  );
  const replaceKey = useCallback(
    (keyId: string, apiKey: string) =>
      patchKey(
        keyId,
        { apiKey: apiKey.trim() },
        t("unifiIntegration.keyReplaced"),
      ),
    [patchKey, t],
  );
  const enableKey = useCallback(
    (keyId: string) =>
      patchKey(keyId, { isEnabled: true }, t("unifiIntegration.keyEnabled")),
    [patchKey, t],
  );
  const disableKey = useCallback(
    (keyId: string) =>
      patchKey(keyId, { isEnabled: false }, t("unifiIntegration.keyDisabled")),
    [patchKey, t],
  );

  const testKey = useCallback(
    async (keyId: string) =>
      (await run<{ hostsFound?: number; sitesFound?: number }>(keyId, {
        request: () =>
          fetchWithAuth(`/unifi/keys/${encodeURIComponent(keyId)}/test`, {
            method: "POST",
          }),
        errorFallback: t("unifiIntegration.failedToTestKey"),
        successMessage: (data) =>
          t("unifiIntegration.keyTestOk", {
            hosts: data?.hostsFound ?? 0,
            sites: data?.sitesFound ?? 0,
          }),
      })) !== undefined,
    [run, t],
  );

  const removeKey = useCallback(
    async (keyId: string) =>
      (await run(keyId, {
        request: () =>
          fetchWithAuth(`/unifi/keys/${encodeURIComponent(keyId)}`, {
            method: "DELETE",
          }),
        errorFallback: t("unifiIntegration.failedToRemoveKey"),
        successMessage: t("unifiIntegration.keyRemoved"),
      })) !== undefined,
    [run, t],
  );

  return {
    busy,
    addKey,
    renameKey,
    replaceKey,
    enableKey,
    disableKey,
    testKey,
    removeKey,
  };
}
