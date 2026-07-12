import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  History,
  Loader2,
  Plug,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, handleActionError, ActionError } from "../../lib/runAction";
import { navigateTo } from "@/lib/navigation";
import { loginPathWithNext, getJwtClaims } from "../../lib/authScope";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { formatNumber } from "@/lib/i18n/format";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

type ConnectionStatus = "connected" | "error" | "reauth_required";

// Mirrors the GET /unifi contract: `{ connected: false }` when not connected, otherwise
// `{ connected: true, connectionType, status, accountLabel, lastSyncAt, lastSyncStatus, lastSyncError }`.
type UnifiConnectionType = "cloud" | "self_hosted";
interface UnifiStatus {
  connected: boolean;
  connectionType?: UnifiConnectionType;
  status?: ConnectionStatus;
  accountLabel?: string | null;
  lastSyncAt?: string | null;
  lastSyncStatus?: string | null;
  lastSyncError?: string | null;
}

// Live host+site list discovered from GET /unifi/hosts (calls UniFi directly).
interface UnifiHostOption {
  id: string;
  name: string;
  model?: string | null;
  sites: Array<{ id: string; name: string }>;
}
// Breeze sites/orgs that a UniFi site can be mapped onto (from GET /orgs/*).
interface BreezeSiteOption {
  id: string;
  name: string;
  orgId: string;
}
interface OrgOption {
  id: string;
  name: string;
}
// Currently-saved mappings (from GET /unifi/mappings).
interface SavedMapping {
  id: string;
  orgId: string;
  siteId: string;
  unifiHostId: string;
  unifiSiteId: string;
  unifiHostName: string | null;
  unifiSiteName: string | null;
}
// Sync-run ledger rows (from GET /unifi/sync-runs).
interface SyncRun {
  id: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  hostsSeen: number;
  devicesCreated: number;
  devicesUpdated: number;
  devicesUnchanged: number;
  devicesRemoved: number;
  error: string | null;
}

// Per-console deep-telemetry collector config (from GET /unifi/collectors).
// `unifiHostId` is null for self-hosted controllers (no cloud host) — they're
// keyed on their own row id instead.
interface UnifiCollector {
  id: string;
  unifiHostId: string | null;
  siteId: string;
  collectorDeviceId: string;
  controllerUrl: string;
  isEnabled: boolean;
  status: string;
  firmwareOk: boolean | null;
  lastPollAt: string | null;
  lastPollStatus: string | null;
  lastPollError: string | null;
}
// Agent devices eligible to be a collector (from GET /devices).
interface AgentDevice {
  id: string;
  name: string | null;
  siteId: string | null;
  status?: string | null;
}
// Deep telemetry rows (from GET /unifi/telemetry?siteId=).
interface TelemetryDevice {
  id: string;
  unifiDeviceId: string;
  name: string | null;
  mac: string | null;
  uptimeSeconds: number | null;
  numClients: number | null;
  isStale: boolean;
  poePorts: Array<{
    port_idx?: number;
    name?: string;
    poe_mode?: string;
    poe_power_w?: number;
    link_speed_mbps?: number;
    up?: boolean;
  }> | null;
}
interface TelemetryClient {
  id: string;
  mac: string;
  hostname: string | null;
  ipAddress: string | null;
  connectedDeviceId: string | null;
  isWired: boolean | null;
  ssid: string | null;
  signalDbm: number | null;
  isStale: boolean;
}
// Per-host draft for the collector config form.
interface CollectorDraft {
  siteId: string;
  collectorDeviceId: string;
  controllerUrl: string;
  apiKey: string;
}
// Agent-discovered local site on a self-hosted controller (from GET /unifi/controller-sites).
// `collectorId` is the unifi_collectors row id, used as the sentinel host id when mapping.
interface ControllerSite {
  collectorId: string;
  localSiteId: string;
  name: string | null;
  mapped: boolean;
}
// Registration draft for a self-hosted controller (Task D2).
interface ControllerDraft {
  controllerUrl: string;
  collectorDeviceId: string;
  siteId: string;
  apiKey: string;
}
const emptyControllerDraft: ControllerDraft = {
  controllerUrl: "",
  collectorDeviceId: "",
  siteId: "",
  apiKey: "",
};

// Stable key for a discovered UniFi site within a host (host ids repeat across hosts otherwise).
const mapKey = (hostId: string, unifiSiteId: string) =>
  `${hostId}::${unifiSiteId}`;

export default function UnifiIntegration() {
  const { t } = useTranslation("integrations");
  const claims = getJwtClaims();
  const isOrgScoped = claims.scope === "organization";

  const [status, setStatus] = useState<UnifiStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  // Not-connected screen: choose between a UniFi cloud account vs a self-hosted
  // controller polled by an on-network Breeze agent. Cloud is the default.
  const [connectMode, setConnectMode] = useState<UnifiConnectionType>("cloud");
  const [accountLabel, setAccountLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Site-mapping + sync-history state (only loaded once connected).
  const [hosts, setHosts] = useState<UnifiHostOption[] | null>(null);
  const [hostsLoading, setHostsLoading] = useState(false);
  const [hostsError, setHostsError] = useState<string | null>(null);
  const [breezeSites, setBreezeSites] = useState<BreezeSiteOption[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [savingMappings, setSavingMappings] = useState(false);
  const [syncRuns, setSyncRuns] = useState<SyncRun[]>([]);

  // Deep-telemetry collector state.
  const [collectors, setCollectors] = useState<Record<string, UnifiCollector>>(
    {},
  );
  const [agents, setAgents] = useState<AgentDevice[]>([]);
  const [collectorDrafts, setCollectorDrafts] = useState<
    Record<string, CollectorDraft>
  >({});
  const [savingCollector, setSavingCollector] = useState<string | null>(null);

  // Self-hosted controller state (Task D2): registered controllers, agent-discovered
  // local sites to map, and the registration form draft.
  const [selfHostedCollectors, setSelfHostedCollectors] = useState<
    UnifiCollector[]
  >([]);
  const [controllerSites, setControllerSites] = useState<
    ControllerSite[] | null
  >(null);
  const [controllerDraft, setControllerDraft] =
    useState<ControllerDraft>(emptyControllerDraft);
  const [registeringController, setRegisteringController] = useState(false);
  const [savingControllerMappings, setSavingControllerMappings] =
    useState(false);
  // Telemetry viewer state.
  const [telemetrySite, setTelemetrySite] = useState<string>("");
  const [telemetry, setTelemetry] = useState<{
    devices: TelemetryDevice[];
    clients: TelemetryClient[];
  } | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  // Monotonic id so a slow telemetry request can't overwrite a newer one's result.
  const telemetryReqId = useRef(0);
  // Surfaced when the connected-panel detail fetches (sites/orgs/mappings/etc.) fail.
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const onUnauthorized = useCallback(() => {
    navigateTo(loginPathWithNext());
  }, []);

  // Breeze sites grouped by organization, for the <optgroup> picker.
  const sitesByOrg = useMemo(() => {
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    // Key the group by orgId, not name — two orgs can share a display name in an
    // MSP fleet, which would collide as duplicate React <optgroup> keys.
    const groups = new Map<
      string,
      { id: string; name: string; sites: BreezeSiteOption[] }
    >();
    for (const s of breezeSites) {
      const group = groups.get(s.orgId) ?? {
        id: s.orgId,
        name: orgName.get(s.orgId) ?? t("unifiIntegration.organization"),
        sites: [],
      };
      group.sites.push(s);
      groups.set(s.orgId, group);
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [breezeSites, orgs]);

  const fetchStatus = useCallback(async () => {
    const res = await fetchWithAuth("/unifi");
    if (res.status === 401) {
      onUnauthorized();
      return null;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        t("unifiIntegration.failedToLoadStatusCode", { status: res.status }),
      );
    }
    return json as UnifiStatus;
  }, [onUnauthorized]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchStatus();
      if (data) setStatus(data);
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : t("unifiIntegration.failedToLoadStatus"),
      );
    } finally {
      setLoading(false);
    }
  }, [fetchStatus]);

  useEffect(() => {
    if (isOrgScoped) {
      setLoading(false);
      return;
    }
    void load();
  }, [isOrgScoped, load]);

  // GET /unifi/hosts is a LIVE call to UniFi — slow and able to fail (bad key → 502),
  // so it carries its own loading/error state and never blocks the rest of the panel.
  const loadHosts = useCallback(async () => {
    setHostsLoading(true);
    setHostsError(null);
    try {
      const res = await fetchWithAuth("/unifi/hosts");
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setHosts(null);
        setHostsError(
          (json as { message?: string }).message ??
            t("unifiIntegration.couldNotLoadSitesCode", {
              status: res.status,
            }),
        );
        return;
      }
      setHosts((json as { hosts?: UnifiHostOption[] }).hosts ?? []);
    } catch {
      setHosts(null);
      setHostsError(t("unifiIntegration.couldNotReachUniFi"));
    } finally {
      setHostsLoading(false);
    }
  }, [onUnauthorized]);

  const loadDetails = useCallback(async () => {
    setDetailsError(null);
    try {
      const [
        sitesRes,
        orgsRes,
        mappingsRes,
        runsRes,
        collectorsRes,
        devicesRes,
      ] = await Promise.all([
        fetchWithAuth("/orgs/sites?limit=500"),
        fetchWithAuth("/orgs/organizations?limit=500"),
        fetchWithAuth("/unifi/mappings"),
        fetchWithAuth("/unifi/sync-runs"),
        fetchWithAuth("/unifi/collectors"),
        fetchWithAuth("/devices?limit=500"),
      ]);
      if (
        [
          sitesRes,
          orgsRes,
          mappingsRes,
          runsRes,
          collectorsRes,
          devicesRes,
        ].some((r) => r.status === 401)
      ) {
        onUnauthorized();
        return;
      }
      // Track per-section failures so a non-401 error doesn't leave a picker
      // mysteriously empty with no explanation.
      const failed: string[] = [];
      const sitesJson = await sitesRes.json().catch(() => ({}));
      if (sitesRes.ok)
        setBreezeSites((sitesJson as { data?: BreezeSiteOption[] }).data ?? []);
      else failed.push("sites");
      const orgsJson = await orgsRes.json().catch(() => ({}));
      if (orgsRes.ok) setOrgs((orgsJson as { data?: OrgOption[] }).data ?? []);
      else failed.push("organizations");
      const mappingsJson = await mappingsRes.json().catch(() => ({}));
      if (mappingsRes.ok) {
        const saved =
          (mappingsJson as { mappings?: SavedMapping[] }).mappings ?? [];
        // Seed the picker selections from what's already persisted.
        setSelection(
          Object.fromEntries(
            saved.map((m) => [mapKey(m.unifiHostId, m.unifiSiteId), m.siteId]),
          ),
        );
      } else failed.push("mappings");
      const runsJson = await runsRes.json().catch(() => ({}));
      if (runsRes.ok)
        setSyncRuns((runsJson as { runs?: SyncRun[] }).runs ?? []);
      else failed.push("sync history");
      const collectorsJson = await collectorsRes.json().catch(() => ({}));
      if (collectorsRes.ok) {
        const list =
          (collectorsJson as { collectors?: UnifiCollector[] }).collectors ??
          [];
        // These maps are keyed by UniFi host id (cloud collectors only). Self-hosted
        // collectors have a null host id and are managed by the Controllers card, so
        // exclude them here to keep the cloud collectors card behaving as before.
        const cloudList = list.filter(
          (col): col is UnifiCollector & { unifiHostId: string } =>
            col.unifiHostId != null,
        );
        setCollectors(
          Object.fromEntries(cloudList.map((col) => [col.unifiHostId, col])),
        );
        // Pre-fill each host's draft from its saved collector (key stays blank — never echoed back).
        setCollectorDrafts((prev) => {
          const next = { ...prev };
          for (const col of cloudList) {
            next[col.unifiHostId] = {
              siteId: col.siteId,
              collectorDeviceId: col.collectorDeviceId,
              controllerUrl: col.controllerUrl,
              apiKey: next[col.unifiHostId]?.apiKey ?? "",
            };
          }
          return next;
        });
      } else failed.push("collectors");
      const devicesJson = await devicesRes.json().catch(() => ({}));
      if (devicesRes.ok) {
        const list =
          (devicesJson as { data?: AgentDevice[]; devices?: AgentDevice[] })
            .data ??
          (devicesJson as { devices?: AgentDevice[] }).devices ??
          (Array.isArray(devicesJson) ? (devicesJson as AgentDevice[]) : []);
        setAgents(list);
      } else failed.push("agent devices");
      if (failed.length > 0) {
        setDetailsError(
          t("unifiIntegration.someConfigurationFailed", {
            details: failed.join(", "),
          }),
        );
      }
      await loadHosts();
    } catch {
      // A rejected fetch (network drop, CORS) would otherwise be an unhandled
      // promise that silently leaves every picker empty.
      setDetailsError(t("unifiIntegration.couldNotLoadConfiguration"));
    }
  }, [onUnauthorized, loadHosts]);

  // Self-hosted controller view: load the Breeze sites/orgs (for the pickers), agents
  // (for the collector select), registered controllers, saved mappings, and the
  // agent-discovered controller sites. No live api.ui.com /hosts call — sites come from
  // the on-network agent's poll (GET /unifi/controller-sites).
  const loadSelfHosted = useCallback(async () => {
    setDetailsError(null);
    try {
      const [
        sitesRes,
        orgsRes,
        mappingsRes,
        collectorsRes,
        devicesRes,
        controllerSitesRes,
      ] = await Promise.all([
        fetchWithAuth("/orgs/sites?limit=500"),
        fetchWithAuth("/orgs/organizations?limit=500"),
        fetchWithAuth("/unifi/mappings"),
        fetchWithAuth("/unifi/collectors"),
        fetchWithAuth("/devices?limit=500"),
        fetchWithAuth("/unifi/controller-sites"),
      ]);
      if (
        [
          sitesRes,
          orgsRes,
          mappingsRes,
          collectorsRes,
          devicesRes,
          controllerSitesRes,
        ].some((r) => r.status === 401)
      ) {
        onUnauthorized();
        return;
      }
      const failed: string[] = [];
      const sitesJson = await sitesRes.json().catch(() => ({}));
      if (sitesRes.ok)
        setBreezeSites((sitesJson as { data?: BreezeSiteOption[] }).data ?? []);
      else failed.push("sites");
      const orgsJson = await orgsRes.json().catch(() => ({}));
      if (orgsRes.ok) setOrgs((orgsJson as { data?: OrgOption[] }).data ?? []);
      else failed.push("organizations");
      const mappingsJson = await mappingsRes.json().catch(() => ({}));
      if (mappingsRes.ok) {
        const saved =
          (mappingsJson as { mappings?: SavedMapping[] }).mappings ?? [];
        setSelection(
          Object.fromEntries(
            saved.map((m) => [mapKey(m.unifiHostId, m.unifiSiteId), m.siteId]),
          ),
        );
      } else failed.push("mappings");
      const collectorsJson = await collectorsRes.json().catch(() => ({}));
      if (collectorsRes.ok)
        setSelfHostedCollectors(
          (collectorsJson as { collectors?: UnifiCollector[] }).collectors ??
            [],
        );
      else failed.push("controllers");
      const devicesJson = await devicesRes.json().catch(() => ({}));
      if (devicesRes.ok) {
        const list =
          (devicesJson as { data?: AgentDevice[]; devices?: AgentDevice[] })
            .data ??
          (devicesJson as { devices?: AgentDevice[] }).devices ??
          (Array.isArray(devicesJson) ? (devicesJson as AgentDevice[]) : []);
        setAgents(list);
      } else failed.push("agent devices");
      const controllerSitesJson = await controllerSitesRes
        .json()
        .catch(() => ({}));
      if (controllerSitesRes.ok)
        setControllerSites(
          (controllerSitesJson as { sites?: ControllerSite[] }).sites ?? [],
        );
      else failed.push("controller sites");
      if (failed.length > 0) {
        setDetailsError(
          t("unifiIntegration.someConfigurationFailed", {
            details: failed.join(", "),
          }),
        );
      }
    } catch {
      setDetailsError(t("unifiIntegration.couldNotLoadConfiguration"));
    }
  }, [onUnauthorized]);

  // Load mapping/history detail once the connection status resolves to connected.
  // Only cloud connections have api.ui.com hosts/sites to map — the self-hosted
  // controller view (Task D2) is driven separately, so skip the cloud fetches.
  useEffect(() => {
    if (status?.connected === true && status?.connectionType !== "self_hosted")
      void loadDetails();
  }, [status?.connected, status?.connectionType, loadDetails]);

  useEffect(() => {
    if (status?.connected === true && status?.connectionType === "self_hosted")
      void loadSelfHosted();
  }, [status?.connected, status?.connectionType, loadSelfHosted]);

  const handleSaveMappings = useCallback(async () => {
    if (!hosts) return;
    const mappings = hosts.flatMap((h) =>
      h.sites.flatMap((s) => {
        const siteId = selection[mapKey(h.id, s.id)];
        if (!siteId) return [];
        return [
          {
            unifiHostId: h.id,
            unifiSiteId: s.id,
            unifiHostName: h.name,
            unifiSiteName: s.name,
            siteId,
          },
        ];
      }),
    );
    setSavingMappings(true);
    try {
      await runAction({
        // Send the full enumerated host set so the server's replace-all cleanup is
        // scoped to hosts the user actually saw — a host transiently missing from this
        // live list must not have its mapping (and synced devices) deleted.
        request: () =>
          fetchWithAuth("/unifi/mappings", {
            method: "PUT",
            body: JSON.stringify({ mappings, hostIds: hosts.map((h) => h.id) }),
          }),
        errorFallback: t("unifiIntegration.failedToSaveSiteMappings"),
        successMessage: t("unifiIntegration.siteMappingsSaved"),
        onUnauthorized,
      });
      await loadDetails();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError))
        handleActionError(err, t("unifiIntegration.failedToSaveSiteMappings"));
    } finally {
      setSavingMappings(false);
    }
  }, [hosts, selection, onUnauthorized, loadDetails]);

  // Register/update a self-hosted controller, then reload collectors + controller sites.
  const handleRegisterController = useCallback(async () => {
    const { controllerUrl, collectorDeviceId, siteId, apiKey } =
      controllerDraft;
    if (
      !siteId ||
      !collectorDeviceId ||
      !controllerUrl.trim() ||
      !apiKey.trim()
    ) {
      setLoadError(
        t("unifiIntegration.pickTheSiteThisControllerServesACollector"),
      );
      return;
    }
    setRegisteringController(true);
    setLoadError(null);
    try {
      await runAction({
        request: () =>
          fetchWithAuth("/unifi/controllers", {
            method: "PUT",
            body: JSON.stringify({
              siteId,
              collectorDeviceId,
              controllerUrl: controllerUrl.trim(),
              apiKey: apiKey.trim(),
            }),
          }),
        errorFallback: t("unifiIntegration.failedToRegisterTheController"),
        successMessage: t("unifiIntegration.controllerRegistered"),
        onUnauthorized,
      });
      setControllerDraft(emptyControllerDraft);
      await loadSelfHosted();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError))
        handleActionError(
          err,
          t("unifiIntegration.failedToRegisterTheController"),
        );
    } finally {
      setRegisteringController(false);
    }
  }, [controllerDraft, onUnauthorized, loadSelfHosted]);

  // Map each agent-discovered controller site to a Breeze site via the shared
  // PUT /unifi/mappings, using the collector id as the sentinel unifiHostId.
  const handleSaveControllerMappings = useCallback(async () => {
    if (!controllerSites) return;
    const mappings = controllerSites.flatMap((s) => {
      const siteId = selection[mapKey(s.collectorId, s.localSiteId)];
      if (!siteId) return [];
      return [
        {
          unifiHostId: s.collectorId,
          unifiSiteId: s.localSiteId,
          unifiSiteName: s.name ?? undefined,
          siteId,
        },
      ];
    });
    setSavingControllerMappings(true);
    try {
      await runAction({
        // Scope replace-all to the controller sites enumerated here (keyed by collector
        // id, the sentinel host id), so other controllers' mappings are never purged.
        request: () =>
          fetchWithAuth("/unifi/mappings", {
            method: "PUT",
            body: JSON.stringify({
              mappings,
              hostIds: controllerSites.map((s) => s.collectorId),
            }),
          }),
        errorFallback: t("unifiIntegration.failedToSaveSiteMappings"),
        successMessage: t("unifiIntegration.siteMappingsSaved"),
        onUnauthorized,
      });
      await loadSelfHosted();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError))
        handleActionError(err, t("unifiIntegration.failedToSaveSiteMappings"));
    } finally {
      setSavingControllerMappings(false);
    }
  }, [controllerSites, selection, onUnauthorized, loadSelfHosted]);

  const updateDraft = useCallback(
    (hostId: string, patch: Partial<CollectorDraft>) => {
      setCollectorDrafts((prev) => {
        const base = prev[hostId] ?? {
          siteId: "",
          collectorDeviceId: "",
          controllerUrl: "",
          apiKey: "",
        };
        return { ...prev, [hostId]: { ...base, ...patch } };
      });
    },
    [],
  );

  const handleSaveCollector = useCallback(
    async (hostId: string) => {
      const draft = collectorDrafts[hostId];
      if (
        !draft?.siteId ||
        !draft.collectorDeviceId ||
        !draft.controllerUrl.trim() ||
        !draft.apiKey.trim()
      ) {
        setLoadError(t("unifiIntegration.pickABreezeSiteACollectorAgentAnd"));
        return;
      }
      setSavingCollector(hostId);
      setLoadError(null);
      try {
        await runAction({
          request: () =>
            fetchWithAuth("/unifi/collectors", {
              method: "PUT",
              body: JSON.stringify({
                unifiHostId: hostId,
                siteId: draft.siteId,
                collectorDeviceId: draft.collectorDeviceId,
                controllerUrl: draft.controllerUrl.trim(),
                apiKey: draft.apiKey.trim(),
              }),
            }),
          errorFallback: t("unifiIntegration.failedToSaveTheUniFiCollector"),
          successMessage: t("unifiIntegration.unifiCollectorSaved"),
          onUnauthorized,
        });
        // Clear the entered key from memory; reload status.
        updateDraft(hostId, { apiKey: "" });
        await loadDetails();
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) return;
        if (!(err instanceof ActionError))
          handleActionError(
            err,
            t("unifiIntegration.failedToSaveTheUniFiCollector"),
          );
      } finally {
        setSavingCollector(null);
      }
    },
    [collectorDrafts, onUnauthorized, loadDetails, updateDraft],
  );

  const handleLoadTelemetry = useCallback(
    async (siteId: string) => {
      setTelemetrySite(siteId);
      setTelemetry(null);
      setTelemetryError(null);
      if (!siteId) return;
      const reqId = ++telemetryReqId.current;
      setTelemetryLoading(true);
      try {
        const res = await fetchWithAuth(
          `/unifi/telemetry?siteId=${encodeURIComponent(siteId)}`,
        );
        if (reqId !== telemetryReqId.current) return; // superseded by a newer site selection
        if (res.status === 401) return onUnauthorized();
        const json = await res.json().catch(() => ({}));
        if (res.ok) {
          setTelemetry({
            devices: (json as { devices?: TelemetryDevice[] }).devices ?? [],
            clients: (json as { clients?: TelemetryClient[] }).clients ?? [],
          });
        } else {
          // Surface 403/404/500 instead of rendering an empty panel that reads as
          // "no data" — the backend computes a precise message we'd otherwise drop.
          setTelemetryError(
            (json as { error?: string }).error ??
              t("unifiIntegration.failedToLoadTelemetryCode", {
                status: res.status,
              }),
          );
        }
      } catch {
        if (reqId === telemetryReqId.current)
          setTelemetryError(t("unifiIntegration.couldNotReachTelemetry"));
      } finally {
        if (reqId === telemetryReqId.current) setTelemetryLoading(false);
      }
    },
    [onUnauthorized],
  );

  const handleConnect = useCallback(async () => {
    const key = apiKey.trim();
    if (!key) {
      setLoadError(t("unifiIntegration.enterAUniFiSiteManagerAPIKeyTo"));
      return;
    }
    setConnecting(true);
    setLoadError(null);
    try {
      await runAction({
        request: () =>
          fetchWithAuth("/unifi/connect", {
            method: "POST",
            body: JSON.stringify({ apiKey: key }),
          }),
        errorFallback: t("unifiIntegration.failedToConnectToUniFi"),
        successMessage: t("unifiIntegration.unifiConnected"),
        onUnauthorized,
      });
      setApiKey("");
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError))
        handleActionError(err, t("unifiIntegration.failedToConnectToUniFi"));
    } finally {
      setConnecting(false);
    }
  }, [apiKey, load, onUnauthorized]);

  const handleConnectSelfHosted = useCallback(async () => {
    const label = accountLabel.trim();
    setConnecting(true);
    setLoadError(null);
    try {
      await runAction({
        request: () =>
          fetchWithAuth("/unifi/connect-self-hosted", {
            method: "POST",
            body: JSON.stringify({ accountLabel: label || undefined }),
          }),
        errorFallback: t(
          "unifiIntegration.failedToConnectTheSelfHostedUniFiController",
        ),
        successMessage: t(
          "unifiIntegration.selfHostedUniFiControllerConnected",
        ),
        onUnauthorized,
      });
      setAccountLabel("");
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError))
        handleActionError(
          err,
          t("unifiIntegration.failedToConnectTheSelfHostedUniFiController"),
        );
    } finally {
      setConnecting(false);
    }
  }, [accountLabel, load, onUnauthorized]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      await runAction({
        request: () => fetchWithAuth("/unifi/sync", { method: "POST" }),
        errorFallback: t("unifiIntegration.failedToSyncUniFiSites"),
        successMessage: t("unifiIntegration.unifiSyncStarted"),
        onUnauthorized,
      });
      await load();
      await loadDetails();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError))
        handleActionError(err, t("unifiIntegration.failedToSyncUniFiSites"));
    } finally {
      setSyncing(false);
    }
  }, [load, loadDetails, onUnauthorized]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      await runAction({
        request: () => fetchWithAuth("/unifi/disconnect", { method: "POST" }),
        errorFallback: t("unifiIntegration.failedToDisconnectUniFi"),
        successMessage: t("unifiIntegration.unifiDisconnected"),
        onUnauthorized,
      });
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError))
        handleActionError(err, t("unifiIntegration.failedToDisconnectUniFi"));
    } finally {
      setDisconnecting(false);
    }
  }, [load, onUnauthorized]);

  if (isOrgScoped) {
    return (
      <div className="space-y-6" data-testid="unifi-panel">
        <Header />
        <p
          className="text-center text-sm text-muted-foreground"
          data-testid="unifi-org-scope"
        >
          {t("unifiIntegration.theUniFiNetworkIntegrationIsAvailableToPartner")}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className="flex items-center gap-2 py-12 text-sm text-muted-foreground"
        data-testid="unifi-loading"
      >
        <Loader2 className="h-4 w-4 animate-spin" />{" "}
        {t("unifiIntegration.loadingUniFiStatus")}
      </div>
    );
  }

  // Connected vs. not is the API's `connected` boolean. The `status` string then
  // distinguishes healthy ('connected') from degraded ('error' / 'reauth_required').
  const isConnected = status?.connected === true;
  // Cloud connections expose api.ui.com-backed affordances (Sync now, host/site mapping,
  // collectors, sync history). Self-hosted controllers (Task D2) don't, so those are hidden.
  const isSelfHosted = isConnected && status?.connectionType === "self_hosted";
  const isCloud = isConnected && !isSelfHosted;
  const needsReauth = isConnected && status?.status === "reauth_required";
  const hasError = isConnected && status?.status === "error";

  return (
    <div className="space-y-6" data-testid="unifi-panel">
      <div className="flex items-center gap-3">
        <Header />
        {needsReauth ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700"
            data-testid="unifi-status-reauth"
          >
            <AlertTriangle className="h-3.5 w-3.5" />{" "}
            {t("unifiIntegration.reconnectRequired")}
          </span>
        ) : hasError ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700"
            data-testid="unifi-status-error"
          >
            <AlertTriangle className="h-3.5 w-3.5" />{" "}
            {t("unifiIntegration.syncError")}
          </span>
        ) : isConnected ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700"
            data-testid="unifi-status-connected"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />{" "}
            {t("unifiIntegration.connected")}
          </span>
        ) : (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600"
            data-testid="unifi-status-disconnected"
          >
            <Unplug className="h-3.5 w-3.5" /> {t("unifiIntegration.notConnected")}
          </span>
        )}
      </div>

      {loadError && (
        <p
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          data-testid="unifi-load-error"
        >
          {loadError}
        </p>
      )}

      {detailsError && (
        <p
          className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          data-testid="unifi-details-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" /> {detailsError}
        </p>
      )}

      {!isConnected && (
        <div
          className="rounded-lg border bg-card p-5"
          data-testid="unifi-disconnected"
        >
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
                onClick={() => void handleConnect()}
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
                onClick={() => void handleConnectSelfHosted()}
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
      )}

      {isConnected && status && (
        <div
          className="space-y-5 rounded-lg border bg-card p-5"
          data-testid="unifi-connected"
        >
          {/* Degraded states must be loud — a connection in 'error' or 'reauth_required'
              still renders the connected view, but with a prominent banner so the
              operator sees the backend's message instead of silently failing syncs. */}
          {needsReauth && (
            <div
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800"
              data-testid="unifi-reauth-banner"
            >
              <p className="font-medium">
                {t("unifiIntegration.unifiNeedsToBeReconnectedTheStoredAPI")}
              </p>
              {status.lastSyncError && (
                <p
                  className="mt-1 text-xs text-amber-700"
                  data-testid="unifi-last-error"
                >
                  {status.lastSyncError}
                </p>
              )}
              <button
                type="button"
                onClick={() => void handleDisconnect()}
                disabled={disconnecting}
                className="mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                data-testid="unifi-reconnect"
              >
                {disconnecting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plug className="h-4 w-4" />
                )}
                {t("unifiIntegration.reconnectUniFi")}
              </button>
            </div>
          )}
          {hasError && status.lastSyncError && (
            <p
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
              data-testid="unifi-last-error"
            >
              {status.lastSyncError}
            </p>
          )}

          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">
                {t("unifiIntegration.account")}
              </dt>
              <dd className="font-medium" data-testid="unifi-account-label">
                {status.accountLabel ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t("unifiIntegration.lastSync")}
              </dt>
              <dd className="font-medium" data-testid="unifi-last-sync">
                {status.lastSyncAt
                  ? formatDateTime(status.lastSyncAt)
                  : t("unifiIntegration.never")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t("unifiIntegration.lastSyncStatus")}
              </dt>
              <dd className="font-medium" data-testid="unifi-last-sync-status">
                {status.lastSyncStatus ?? "—"}
              </dd>
            </div>
          </dl>

          <div className="flex items-center gap-3 border-t pt-4">
            {isCloud && (
              <button
                type="button"
                onClick={() => void handleSync()}
                disabled={syncing}
                className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
                data-testid="unifi-sync"
              >
                {syncing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {t("unifiIntegration.syncNow")}
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleDisconnect()}
              disabled={disconnecting}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-red-200 px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              data-testid="unifi-disconnect"
            >
              {disconnecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Unplug className="h-4 w-4" />
              )}
              {t("unifiIntegration.disconnect")}
            </button>
          </div>
        </div>
      )}

      {isSelfHosted && (
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
                        {a.name ?? a.id}
                      </option>
                    ))}
                </select>
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
              onClick={() => void handleRegisterController()}
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
      )}

      {isSelfHosted && (
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
              onClick={() => void loadSelfHosted()}
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
                        <tr
                          key={key}
                          data-testid="unifi-controller-mapping-row"
                        >
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
                  onClick={() => void handleSaveControllerMappings()}
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
      )}

      {isCloud && (
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
              onClick={() => void loadHosts()}
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
                  onClick={() => void handleSaveMappings()}
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
      )}

      {isCloud && hosts && hosts.length > 0 && (
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
                            {a.name ?? a.id}
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
                    onClick={() => void handleSaveCollector(h.id)}
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
      )}

      {isCloud && (
        <div
          className="rounded-xl border bg-card p-5 shadow-xs"
          data-testid="unifi-telemetry-card"
        >
          <h2 className="text-lg font-semibold">
            {t("unifiIntegration.deepTelemetry")}
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            {t("unifiIntegration.livePerDevicePoEHealthAndConnectedClients")}
          </p>
          <label className="block max-w-xs text-sm">
            <span className="text-muted-foreground">
              {t("common:labels.site")}
            </span>
            <select
              value={telemetrySite}
              onChange={(e) => void handleLoadTelemetry(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              data-testid="unifi-telemetry-site"
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

          {telemetryLoading ? (
            <div
              className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="unifi-telemetry-loading"
            >
              <Loader2 className="h-4 w-4 animate-spin" />{" "}
              {t("unifiIntegration.loadingTelemetry")}
            </div>
          ) : telemetryError ? (
            <div
              className="mt-4 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="unifi-telemetry-error"
            >
              <AlertTriangle className="h-4 w-4 shrink-0" /> {telemetryError}
            </div>
          ) : telemetry ? (
            <div className="mt-4 space-y-6">
              <div>
                <h3 className="mb-2 text-sm font-semibold">
                  {t("unifiIntegration.devices")}
                  {telemetry.devices.length})
                </h3>
                {telemetry.devices.length === 0 ? (
                  <p
                    className="text-sm text-muted-foreground"
                    data-testid="unifi-telemetry-devices-empty"
                  >
                    {t("unifiIntegration.noDeviceTelemetryYet")}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table
                      className="min-w-full divide-y text-sm"
                      data-testid="unifi-telemetry-devices"
                    >
                      <thead>
                        <tr className="text-left text-muted-foreground">
                          <th className="px-3 py-2 font-medium">
                            {t("common:labels.device")}
                          </th>
                          <th className="px-3 py-2 font-medium">MAC</th>
                          <th className="px-3 py-2 font-medium">
                            {t("unifiIntegration.clients")}
                          </th>
                          <th className="px-3 py-2 font-medium">
                            {t("unifiIntegration.poePorts")}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {telemetry.devices.map((d) => (
                          <tr
                            key={d.id}
                            className={d.isStale ? "text-muted-foreground" : ""}
                            data-testid="unifi-telemetry-device-row"
                          >
                            <td className="px-3 py-2 font-medium">
                              {d.name ?? d.unifiDeviceId}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {d.mac ?? "—"}
                            </td>
                            <td className="px-3 py-2 tabular-nums">
                              {d.numClients ?? "—"}
                            </td>
                            <td className="px-3 py-2">
                              {Array.isArray(d.poePorts) &&
                              d.poePorts.length > 0
                                ? `${d.poePorts.filter((p) => p.up).length}/${d.poePorts.length} up · ${formatNumber(
                                    d.poePorts.reduce(
                                      (sum, p) => sum + (p.poe_power_w ?? 0),
                                      0,
                                    ),
                                    {
                                      minimumFractionDigits: 1,
                                      maximumFractionDigits: 1,
                                    },
                                  )}W`
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold">
                  {t("unifiIntegration.clients2")}
                  {telemetry.clients.length})
                </h3>
                {telemetry.clients.length === 0 ? (
                  <p
                    className="text-sm text-muted-foreground"
                    data-testid="unifi-telemetry-clients-empty"
                  >
                    {t("unifiIntegration.noClientsReported")}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table
                      className="min-w-full divide-y text-sm"
                      data-testid="unifi-telemetry-clients"
                    >
                      <thead>
                        <tr className="text-left text-muted-foreground">
                          <th className="px-3 py-2 font-medium">
                            {t("unifiIntegration.host")}
                          </th>
                          <th className="px-3 py-2 font-medium">IP</th>
                          <th className="px-3 py-2 font-medium">MAC</th>
                          <th className="px-3 py-2 font-medium">
                            {t("unifiIntegration.link")}
                          </th>
                          <th className="px-3 py-2 font-medium">
                            {t("unifiIntegration.signal")}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {telemetry.clients.map((cl) => (
                          <tr
                            key={cl.id}
                            className={
                              cl.isStale ? "text-muted-foreground" : ""
                            }
                            data-testid="unifi-telemetry-client-row"
                          >
                            <td className="px-3 py-2 font-medium">
                              {cl.hostname ?? "—"}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {cl.ipAddress ?? "—"}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {cl.mac}
                            </td>
                            <td className="px-3 py-2">
                              {cl.isWired
                                ? t("unifiIntegration.wired")
                                : cl.ssid
                                  ? `Wi-Fi · ${cl.ssid}`
                                  : "Wi-Fi"}
                            </td>
                            <td className="px-3 py-2 tabular-nums">
                              {cl.signalDbm != null
                                ? `${cl.signalDbm} dBm`
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {isCloud && (
        <div
          className="rounded-xl border bg-card p-5 shadow-xs"
          data-testid="unifi-history-card"
        >
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-lg font-semibold">
              {t("unifiIntegration.syncHistory")}
            </h2>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            {t("unifiIntegration.theMostRecentSyncRunsNewestFirst")}
          </p>

          {syncRuns.length === 0 ? (
            <p
              className="py-6 text-sm text-muted-foreground"
              data-testid="unifi-history-empty"
            >
              {t("unifiIntegration.noSyncRunsYetTriggerASyncTo")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="min-w-full divide-y text-sm"
                data-testid="unifi-history-table"
              >
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">
                      {t("unifiIntegration.started")}
                    </th>
                    <th className="px-3 py-2 font-medium">
                      {t("unifiIntegration.trigger")}
                    </th>
                    <th className="px-3 py-2 font-medium">
                      {t("common:labels.status")}
                    </th>
                    <th
                      className="px-3 py-2 font-medium"
                      title={t("unifiIntegration.hostsSeen")}
                    >
                      {t("unifiIntegration.hosts")}
                    </th>
                    <th
                      className="px-3 py-2 font-medium"
                      title={t("unifiIntegration.devicesCreated")}
                    >
                      {t("unifiIntegration.new")}
                    </th>
                    <th
                      className="px-3 py-2 font-medium"
                      title={t("unifiIntegration.devicesUpdated")}
                    >
                      {t("unifiIntegration.upd")}
                    </th>
                    <th
                      className="px-3 py-2 font-medium"
                      title={t("unifiIntegration.devicesUnchanged")}
                    >
                      {t("unifiIntegration.same")}
                    </th>
                    <th
                      className="px-3 py-2 font-medium"
                      title={t("unifiIntegration.devicesRemovedStale")}
                    >
                      {t("unifiIntegration.gone")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {syncRuns.map((run) => (
                    <tr key={run.id} data-testid="unifi-history-row">
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatDateTime(run.startedAt)}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {run.trigger}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${runStatusClasses(run.status)}`}
                          title={run.error ?? undefined}
                          data-testid="unifi-history-status"
                        >
                          {run.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {run.hostsSeen}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {run.devicesCreated}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {run.devicesUpdated}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {run.devicesUnchanged}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {run.devicesRemoved}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Sync-run status → badge colors (mirrors SyncRunResult.status: success | partial | failed,
// plus the transient 'running' the worker writes at start).
function runStatusClasses(status: string): string {
  switch (status) {
    case "success":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "partial":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "failed":
      return "border-red-200 bg-red-50 text-red-700";
    default:
      return "border-slate-200 bg-slate-50 text-slate-600";
  }
}

// Collector status → badge colors (unifi_collectors.status:
// pending | connected | unreachable | error | firmware_too_old).
function collectorStatusClasses(status: string): string {
  switch (status) {
    case "connected":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "unreachable":
    case "firmware_too_old":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "error":
      return "border-red-200 bg-red-50 text-red-700";
    default:
      return "border-slate-200 bg-slate-50 text-slate-600";
  }
}

function Header() {
  const { t } = useTranslation("integrations");
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <span className="text-sm font-bold">UI</span>
      </div>
      <div>
        <h1 className="text-2xl font-semibold">
          {t("unifiIntegration.unifiNetwork")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "unifiIntegration.discoverAndReconcileUniFiNetworkAssetsAcrossYour",
          )}
        </p>
      </div>
    </div>
  );
}
