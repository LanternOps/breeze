// Disconnected screen: choose between a UniFi cloud account (Site Manager API
// key) vs a self-hosted controller polled by an on-network Breeze agent. Split
// out of UnifiIntegration.tsx (#2382) — verbatim move, no behavior change.

import { Loader2, Plug } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import type { UnifiConnectionType } from "./unifiTypes";

interface ConnectionChooserProps {
  connectMode: UnifiConnectionType;
  setConnectMode: (mode: UnifiConnectionType) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  accountLabel: string;
  setAccountLabel: (value: string) => void;
  connecting: boolean;
  onConnect: () => void;
  onConnectSelfHosted: () => void;
}

export default function ConnectionChooser({
  connectMode,
  setConnectMode,
  apiKey,
  setApiKey,
  accountLabel,
  setAccountLabel,
  connecting,
  onConnect,
  onConnectSelfHosted,
}: ConnectionChooserProps) {
  const { t } = useTranslation("integrations");
  return (
    <div className="rounded-lg border bg-card p-5" data-testid="unifi-disconnected">
      {/* Connection-type chooser: a UniFi cloud account (Site Manager API key) vs a
          self-hosted Network controller polled directly by an on-network Breeze agent. */}
      <div
        className="inline-flex rounded-md border bg-muted/40 p-1"
        role="radiogroup"
        aria-label={t("unifiIntegration.unifiConnectionType")}
        data-testid="unifi-connect-mode"
      >
        <button
          type="button"
          role="radio"
          aria-checked={connectMode === "cloud"}
          onClick={() => setConnectMode("cloud")}
          className={`inline-flex h-8 items-center rounded px-3 text-sm font-medium ${connectMode === "cloud" ? "bg-background shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
          data-testid="unifi-connect-mode-cloud"
        >
          {t("unifiIntegration.cloudSiteManagerAPIKey")}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={connectMode === "self_hosted"}
          onClick={() => setConnectMode("self_hosted")}
          className={`inline-flex h-8 items-center rounded px-3 text-sm font-medium ${connectMode === "self_hosted" ? "bg-background shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
          data-testid="unifi-connect-mode-self-hosted"
        >
          {t("unifiIntegration.selfHostedController")}
        </button>
      </div>

      {connectMode === "cloud" ? (
        <div data-testid="unifi-connect-cloud">
          <p className="mt-4 text-sm text-muted-foreground">
            {t("unifiIntegration.connectYourUniFiSiteManagerAccountWithA")}
          </p>
          <label
            className="mt-4 block text-sm font-medium"
            htmlFor="unifi-api-key"
          >
            {t("unifiIntegration.unifiSiteManagerAPIKey")}
          </label>
          <input
            id="unifi-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t("unifiIntegration.pasteYourAPIKey")}
            className="mt-2 h-10 w-full max-w-md rounded-md border bg-background px-3 text-sm"
            data-testid="unifi-api-key"
          />
          <button
            type="button"
            onClick={() => void onConnect()}
            disabled={connecting || !apiKey.trim()}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            data-testid="unifi-connect"
          >
            {connecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plug className="h-4 w-4" />
            )}
            {t("unifiIntegration.connectToUniFi")}
          </button>
        </div>
      ) : (
        <div data-testid="unifi-connect-self-hosted">
          <p className="mt-4 text-sm text-muted-foreground">
            {t(
              "unifiIntegration.connectASelfHostedUniFiNetworkControllerA",
            )}
          </p>
          <label
            className="mt-4 block text-sm font-medium"
            htmlFor="unifi-account-label"
          >
            {t("unifiIntegration.accountLabel")}
            <span className="font-normal text-muted-foreground">
              {t("unifiIntegration.optional")}
            </span>
          </label>
          <input
            id="unifi-account-label"
            type="text"
            autoComplete="off"
            value={accountLabel}
            onChange={(e) => setAccountLabel(e.target.value)}
            placeholder={t("unifiIntegration.eGAcmeHQControllers")}
            className="mt-2 h-10 w-full max-w-md rounded-md border bg-background px-3 text-sm"
            data-testid="unifi-account-label-input"
          />
          <button
            type="button"
            onClick={() => void onConnectSelfHosted()}
            disabled={connecting}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            data-testid="unifi-connect-self-hosted-submit"
          >
            {connecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plug className="h-4 w-4" />
            )}
            {t("unifiIntegration.connect")}
          </button>
        </div>
      )}
    </div>
  );
}
