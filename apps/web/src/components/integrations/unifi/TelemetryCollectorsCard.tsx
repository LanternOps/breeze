// Deep-telemetry collector config per UniFi host (cloud). Split out of
// UnifiIntegration.tsx (#2382) — verbatim move, no behavior change.

import { Loader2, Plug } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { agentOptionLabel, collectorStatusClasses } from "./unifiHelpers";
import type {
  AgentDevice,
  CollectorDraft,
  SiteGroup,
  UnifiCollector,
  UnifiHostOption,
} from "./unifiTypes";

interface TelemetryCollectorsCardProps {
  hosts: UnifiHostOption[];
  collectors: Record<string, UnifiCollector>;
  collectorDrafts: Record<string, CollectorDraft>;
  agents: AgentDevice[];
  agentsTruncated: boolean;
  sitesByOrg: SiteGroup[];
  translateDeviceStatus: (status: string) => string;
  savingCollector: string | null;
  updateDraft: (hostId: string, patch: Partial<CollectorDraft>) => void;
  onSaveCollector: (hostId: string) => void;
}

export default function TelemetryCollectorsCard({
  hosts,
  collectors,
  collectorDrafts,
  agents,
  agentsTruncated,
  sitesByOrg,
  translateDeviceStatus,
  savingCollector,
  updateDraft,
  onSaveCollector,
}: TelemetryCollectorsCardProps) {
  const { t } = useTranslation("integrations");
  return (
    <div
      className="rounded-xl border bg-card p-5 shadow-xs"
      data-testid="unifi-collectors-card"
    >
      <h2 className="text-lg font-semibold">
        {t("unifiIntegration.deepTelemetryCollectors")}
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        {t("unifiIntegration.assignABreezeAgentAtTheSiteTo")}
      </p>
      {agentsTruncated && (
        <p
          className="mb-4 text-xs text-amber-600"
          data-testid="unifi-agents-truncated"
        >
          {t("unifiIntegration.agentListTruncated")}
        </p>
      )}
      <div className="space-y-4">
        {hosts.map((h) => {
          const collector = collectors[h.id];
          const draft = collectorDrafts[h.id] ?? {
            siteId: "",
            collectorDeviceId: "",
            controllerUrl: "",
            apiKey: "",
          };
          const eligibleAgents = agents.filter(
            (a) => !draft.siteId || a.siteId === draft.siteId,
          );
          return (
            <div
              key={h.id}
              className="rounded-lg border p-4"
              data-testid="unifi-collector-row"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{h.name}</span>
                {h.model && (
                  <span className="text-xs text-muted-foreground">
                    {h.model}
                  </span>
                )}
                {collector && (
                  <span
                    className={`ml-auto inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${collectorStatusClasses(collector.status)}`}
                    title={collector.lastPollError ?? undefined}
                    data-testid="unifi-collector-status"
                  >
                    {collector.status}
                    {collector.lastPollAt
                      ? ` · ${formatDateTime(collector.lastPollAt)}`
                      : ""}
                  </span>
                )}
              </div>
              {collector?.lastPollError && (
                <p
                  className="mt-1 text-xs text-red-600"
                  data-testid="unifi-collector-error"
                >
                  {collector.lastPollError}
                </p>
              )}
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="text-muted-foreground">
                    {t("unifiIntegration.breezeSiteThisConsoleServes")}
                  </span>
                  <select
                    value={draft.siteId}
                    onChange={(e) =>
                      updateDraft(h.id, {
                        siteId: e.target.value,
                        collectorDeviceId: "",
                      })
                    }
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                    data-testid="unifi-collector-site"
                  >
                    <option value="">
                      {t("unifiIntegration.selectSite")}
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
                </label>
                <label className="text-sm">
                  <span className="text-muted-foreground">
                    {t("unifiIntegration.collectorAgent")}
                  </span>
                  <select
                    value={draft.collectorDeviceId}
                    onChange={(e) =>
                      updateDraft(h.id, {
                        collectorDeviceId: e.target.value,
                      })
                    }
                    disabled={!draft.siteId}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm disabled:opacity-50"
                    data-testid="unifi-collector-agent"
                  >
                    <option value="">
                      {draft.siteId
                        ? "— Select agent —"
                        : t("unifiIntegration.pickSiteFirst")}
                    </option>
                    {eligibleAgents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {agentOptionLabel(a, translateDeviceStatus)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="text-muted-foreground">
                    {t("unifiIntegration.controllerURL")}
                  </span>
                  <input
                    type="text"
                    value={draft.controllerUrl}
                    onChange={(e) =>
                      updateDraft(h.id, { controllerUrl: e.target.value })
                    }
                    placeholder="https://192.168.1.1"
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                    data-testid="unifi-collector-url"
                  />
                </label>
                <label className="text-sm">
                  <span className="text-muted-foreground">
                    {t("unifiIntegration.localAPIKey")}
                    {collector ? " (leave blank to keep)" : ""}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={draft.apiKey}
                    onChange={(e) =>
                      updateDraft(h.id, { apiKey: e.target.value })
                    }
                    placeholder={t(
                      "unifiIntegration.networkIntegrationAPIKey",
                    )}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                    data-testid="unifi-collector-key"
                  />
                </label>
              </div>
              <button
                type="button"
                onClick={() => void onSaveCollector(h.id)}
                disabled={savingCollector === h.id}
                className="mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                data-testid="unifi-collector-save"
              >
                {savingCollector === h.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plug className="h-4 w-4" />
                )}
                {collector
                  ? t("unifiIntegration.updateCollector")
                  : t("unifiIntegration.enableDeepTelemetry")}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
