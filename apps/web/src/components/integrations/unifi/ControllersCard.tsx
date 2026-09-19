// Self-hosted controller registration + list. Split out of
// UnifiIntegration.tsx (#2382) — verbatim move, no behavior change.

import type { Dispatch, SetStateAction } from "react";
import { Loader2, Plug } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { agentOptionLabel, collectorStatusClasses } from "./unifiHelpers";
import type {
  AgentDevice,
  ControllerDraft,
  SiteGroup,
  UnifiCollector,
} from "./unifiTypes";

interface ControllersCardProps {
  selfHostedCollectors: UnifiCollector[];
  controllerDraft: ControllerDraft;
  setControllerDraft: Dispatch<SetStateAction<ControllerDraft>>;
  sitesByOrg: SiteGroup[];
  agents: AgentDevice[];
  agentsTruncated: boolean;
  translateDeviceStatus: (status: string) => string;
  registeringController: boolean;
  onRegisterController: () => void;
}

export default function ControllersCard({
  selfHostedCollectors,
  controllerDraft,
  setControllerDraft,
  sitesByOrg,
  agents,
  agentsTruncated,
  translateDeviceStatus,
  registeringController,
  onRegisterController,
}: ControllersCardProps) {
  const { t } = useTranslation("integrations");
  return (
    <div
      className="rounded-xl border bg-card p-5 shadow-xs"
      data-testid="unifi-controllers-card"
    >
      <h2 className="text-lg font-semibold">
        {t("unifiIntegration.controllers")}
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        {t(
          "unifiIntegration.registerEachSelfHostedUniFiNetworkControllerA",
        )}
      </p>

      {selfHostedCollectors.length > 0 && (
        <ul className="mb-4 space-y-2" data-testid="unifi-controller-list">
          {selfHostedCollectors.map((col) => (
            <li
              key={col.id}
              className="flex items-center gap-2 rounded-lg border p-3 text-sm"
              data-testid="unifi-controller-item"
            >
              <span className="font-medium break-all">
                {col.controllerUrl}
              </span>
              <span
                className={`ml-auto inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${collectorStatusClasses(col.status)}`}
                title={col.lastPollError ?? undefined}
                data-testid="unifi-controller-status"
              >
                {col.status}
                {col.lastPollAt
                  ? ` · ${formatDateTime(col.lastPollAt)}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div
        className="rounded-lg border p-4"
        data-testid="unifi-controller-form"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="text-muted-foreground">
              {t("unifiIntegration.controllerURL")}
            </span>
            <input
              type="text"
              value={controllerDraft.controllerUrl}
              onChange={(e) =>
                setControllerDraft((prev) => ({
                  ...prev,
                  controllerUrl: e.target.value,
                }))
              }
              placeholder="https://192.168.1.1"
              className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              data-testid="unifi-controller-url"
            />
          </label>
          <label className="text-sm">
            <span className="text-muted-foreground">
              {t("unifiIntegration.siteThisControllerServes")}
            </span>
            <select
              value={controllerDraft.siteId}
              onChange={(e) =>
                setControllerDraft((prev) => ({
                  ...prev,
                  siteId: e.target.value,
                  collectorDeviceId: "",
                }))
              }
              className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              data-testid="unifi-controller-site"
            >
              <option value="">{t("unifiIntegration.selectSite")}</option>
              {sitesByOrg.map((group) => (
                <optgroup key={group.id} label={group.name}>
                  {group.sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="text-muted-foreground">
              {t("unifiIntegration.collectorAgent")}
            </span>
            <select
              value={controllerDraft.collectorDeviceId}
              onChange={(e) =>
                setControllerDraft((prev) => ({
                  ...prev,
                  collectorDeviceId: e.target.value,
                }))
              }
              disabled={!controllerDraft.siteId}
              className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm disabled:opacity-50"
              data-testid="unifi-controller-agent"
            >
              <option value="">
                {controllerDraft.siteId
                  ? "— Select agent —"
                  : t("unifiIntegration.pickSiteFirst")}
              </option>
              {agents
                .filter(
                  (a) =>
                    !controllerDraft.siteId ||
                    a.siteId === controllerDraft.siteId,
                )
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {agentOptionLabel(a, translateDeviceStatus)}
                  </option>
                ))}
            </select>
            {agentsTruncated && (
              <span
                className="mt-1 block text-xs text-amber-600"
                data-testid="unifi-agents-truncated"
              >
                {t("unifiIntegration.agentListTruncated")}
              </span>
            )}
          </label>
          <label className="text-sm">
            <span className="text-muted-foreground">
              {t("unifiIntegration.localAPIKey")}
            </span>
            <input
              type="password"
              autoComplete="off"
              value={controllerDraft.apiKey}
              onChange={(e) =>
                setControllerDraft((prev) => ({
                  ...prev,
                  apiKey: e.target.value,
                }))
              }
              placeholder={t("unifiIntegration.networkIntegrationAPIKey")}
              className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              data-testid="unifi-controller-key"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={() => void onRegisterController()}
          disabled={registeringController}
          className="mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          data-testid="unifi-controller-register"
        >
          {registeringController ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plug className="h-4 w-4" />
          )}
          {t("unifiIntegration.registerController")}
        </button>
      </div>
    </div>
  );
}
