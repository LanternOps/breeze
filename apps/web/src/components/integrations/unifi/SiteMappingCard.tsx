// Site mapping — cloud (UniFi host/site → Breeze site) and self-hosted
// (agent-discovered controller site → Breeze site) variants. These were two
// near-duplicate blocks in UnifiIntegration.tsx sharing the "Site mapping"
// heading; kept as one component with a `variant` discriminant rather than
// merged, so each JSX branch stays a verbatim move (#2382, no behavior change).

import type { Dispatch, SetStateAction } from "react";
import { Loader2, Plug, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { mapKey } from "./unifiTypes";
import type { ControllerSite, SiteGroup, UnifiHostOption } from "./unifiTypes";

type SiteMappingCardProps =
  | {
      variant: "cloud";
      hosts: UnifiHostOption[] | null;
      hostsLoading: boolean;
      hostsError: string | null;
      selection: Record<string, string>;
      setSelection: Dispatch<SetStateAction<Record<string, string>>>;
      sitesByOrg: SiteGroup[];
      savingMappings: boolean;
      onRefresh: () => void;
      onSave: () => void;
    }
  | {
      variant: "self_hosted";
      controllerSites: ControllerSite[] | null;
      selection: Record<string, string>;
      setSelection: Dispatch<SetStateAction<Record<string, string>>>;
      sitesByOrg: SiteGroup[];
      savingControllerMappings: boolean;
      onRefresh: () => void;
      onSave: () => void;
    };

export default function SiteMappingCard(props: SiteMappingCardProps) {
  const { t } = useTranslation("integrations");
  const { selection, setSelection, sitesByOrg, onRefresh, onSave } = props;

  if (props.variant === "self_hosted") {
    const { controllerSites, savingControllerMappings } = props;
    return (
      <div
        className="rounded-xl border bg-card p-5 shadow-xs"
        data-testid="unifi-controller-mapping-card"
      >
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">
            {t("unifiIntegration.siteMapping")}
          </h2>
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium hover:bg-muted"
            data-testid="unifi-controller-mapping-refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("common:actions.refresh")}
          </button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("unifiIntegration.mapEachAgentDiscoveredControllerSiteToA")}
        </p>

        {!controllerSites || controllerSites.length === 0 ? (
          <p
            className="py-6 text-sm text-muted-foreground"
            data-testid="unifi-controller-mapping-empty"
          >
            {t("unifiIntegration.noSitesDiscoveredYetOnceTheAssignedAgent")}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table
                className="min-w-full divide-y text-sm"
                data-testid="unifi-controller-mapping-table"
              >
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">
                      {t("unifiIntegration.controllerSite")}
                    </th>
                    <th className="px-3 py-2 font-medium">
                      {t("unifiIntegration.breezeSite")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {controllerSites.map((s) => {
                    const key = mapKey(s.collectorId, s.localSiteId);
                    return (
                      <tr key={key} data-testid="unifi-controller-mapping-row">
                        <td className="px-3 py-2">
                          <span className="font-medium">
                            {s.name ?? s.localSiteId}
                          </span>
                          <span className="ml-1 text-xs text-muted-foreground">
                            {s.localSiteId}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={selection[key] ?? ""}
                            onChange={(e) =>
                              setSelection((prev) => ({
                                ...prev,
                                [key]: e.target.value,
                              }))
                            }
                            className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm"
                            data-testid="unifi-controller-mapping-select"
                          >
                            <option value="">
                              {t("unifiIntegration.notMapped")}
                            </option>
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
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex items-center gap-3 border-t pt-4">
              <button
                type="button"
                onClick={() => void onSave()}
                disabled={savingControllerMappings}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                data-testid="unifi-controller-mapping-save"
              >
                {savingControllerMappings ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plug className="h-4 w-4" />
                )}
                {t("unifiIntegration.saveMappings")}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const { hosts, hostsLoading, hostsError, savingMappings } = props;
  return (
    <div
      className="rounded-xl border bg-card p-5 shadow-xs"
      data-testid="unifi-mapping-card"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">
          {t("unifiIntegration.siteMapping")}
        </h2>
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={hostsLoading}
          className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          data-testid="unifi-mapping-refresh"
        >
          <RefreshCw
            className={
              hostsLoading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"
            }
          />
          {t("common:actions.refresh")}
        </button>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        {t("unifiIntegration.mapEachDiscoveredUniFiSiteToABreeze")}
      </p>

      {hostsLoading ? (
        <div
          className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
          data-testid="unifi-mapping-loading"
        >
          <Loader2 className="h-4 w-4 animate-spin" />{" "}
          {t("unifiIntegration.loadingUniFiSites")}
        </div>
      ) : hostsError ? (
        <div
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          data-testid="unifi-mapping-error"
        >
          {hostsError}
        </div>
      ) : !hosts || hosts.length === 0 ? (
        <p
          className="py-6 text-sm text-muted-foreground"
          data-testid="unifi-mapping-empty"
        >
          {t("unifiIntegration.noUniFiHostsOrSitesWereDiscoveredFor")}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table
              className="min-w-full divide-y text-sm"
              data-testid="unifi-mapping-table"
            >
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">
                    {t("unifiIntegration.unifiHost")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t("unifiIntegration.unifiSite")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t("unifiIntegration.breezeSite")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {hosts.flatMap((h) =>
                  h.sites.map((s) => {
                    const key = mapKey(h.id, s.id);
                    return (
                      <tr key={key} data-testid="unifi-mapping-row">
                        <td className="px-3 py-2">
                          <span className="font-medium">{h.name}</span>
                          {h.model && (
                            <span
                              className="ml-2 text-xs text-muted-foreground"
                              data-testid="unifi-mapping-host-model"
                            >
                              {h.model}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {s.name}
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={selection[key] ?? ""}
                            onChange={(e) =>
                              setSelection((prev) => ({
                                ...prev,
                                [key]: e.target.value,
                              }))
                            }
                            className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm"
                            data-testid="unifi-mapping-select"
                          >
                            <option value="">
                              {t("unifiIntegration.notMapped")}
                            </option>
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
                        </td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex items-center gap-3 border-t pt-4">
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={savingMappings}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              data-testid="unifi-mapping-save"
            >
              {savingMappings ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plug className="h-4 w-4" />
              )}
              {t("unifiIntegration.saveMappings")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
