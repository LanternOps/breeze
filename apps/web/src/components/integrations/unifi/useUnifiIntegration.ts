// State + data hook for the UniFi integration panel, split out of
// UnifiIntegration.tsx (#2382). Owns status, hosts, orgs/sites, collectors,
// controllers, and telemetry state plus the fetch/handlers — verbatim moves,
// no behavior change.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchWithAuth } from "../../../stores/auth";
import { runAction, handleActionError, ActionError } from "../../../lib/runAction";
import { navigateTo } from "@/lib/navigation";
import { loginPathWithNext, getJwtClaims } from "../../../lib/authScope";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { loadAgentDevices } from "./unifiHelpers";
import {
  mapKey,
  type AgentDevice,
  type BreezeSiteOption,
  type CollectorDraft,
  type ControllerDraft,
  type ControllerSite,
  type OrgOption,
  type SavedMapping,
  type SiteGroup,
  type SyncRun,
  type TelemetryClient,
  type TelemetryDevice,
  type UnifiCollector,
  type UnifiConnectionType,
  type UnifiHostOption,
  type UnifiStatus,
} from "./unifiTypes";

const emptyControllerDraft: ControllerDraft = {
  controllerUrl: "",
  collectorDeviceId: "",
  siteId: "",
  apiKey: "",
};

export function useUnifiIntegration() {
  const { t } = useTranslation("integrations");
  const claims = getJwtClaims();
  const isOrgScoped = claims.scope === "organization";

  const [status, setStatus] = useState<UnifiStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  // Not-connected screen: choose between a UniFi cloud account (Site Manager API
  // key) vs a self-hosted controller polled by an on-network Breeze agent. Cloud
  // is the default.
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
  // True only when the device walk hit its safety ceiling, so the agent the
  // operator is looking for may genuinely not be in the list.
  const [agentsTruncated, setAgentsTruncated] = useState(false);
  // device_status values are already translated in the `devices` namespace for
  // every locale — reuse them rather than duplicating the enum here.
  const translateDeviceStatus = useCallback(
    (deviceStatus: string) =>
      t(
        /* i18n-dynamic */ `devices:deviceList.statuses.full.${deviceStatus}`,
        // An enum value we don't have copy for renders as itself, never as a
        // raw i18n key.
        { defaultValue: deviceStatus },
      ),
    [t],
  );
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
  const sitesByOrg = useMemo<SiteGroup[]>(() => {
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    // Key the group by orgId, not name — two orgs can share a display name in an
    // MSP fleet, which would collide as duplicate React <optgroup> keys.
    const groups = new Map<string, SiteGroup>();
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
        agentLoad,
      ] = await Promise.all([
        fetchWithAuth("/orgs/sites?limit=500"),
        fetchWithAuth("/orgs/organizations?limit=500"),
        fetchWithAuth("/unifi/mappings"),
        fetchWithAuth("/unifi/sync-runs"),
        fetchWithAuth("/unifi/collectors"),
        loadAgentDevices(),
      ]);
      if (
        [sitesRes, orgsRes, mappingsRes, runsRes, collectorsRes].some(
          (r) => r.status === 401,
        ) ||
        agentLoad.kind === "unauthorized"
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
      if (agentLoad.kind === "ok") {
        setAgents(agentLoad.devices);
        setAgentsTruncated(agentLoad.truncated);
      } else {
        // Clear BOTH. Leaving a stale list under an error banner is bad enough;
        // leaving the truncation notice asserting "only the first N were
        // loaded" about a fetch that loaded nothing is a false factual claim.
        setAgents([]);
        setAgentsTruncated(false);
        failed.push(agentLoad.label);
      }
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
        agentLoad,
        controllerSitesRes,
      ] = await Promise.all([
        fetchWithAuth("/orgs/sites?limit=500"),
        fetchWithAuth("/orgs/organizations?limit=500"),
        fetchWithAuth("/unifi/mappings"),
        fetchWithAuth("/unifi/collectors"),
        loadAgentDevices(),
        fetchWithAuth("/unifi/controller-sites"),
      ]);
      if (
        [
          sitesRes,
          orgsRes,
          mappingsRes,
          collectorsRes,
          controllerSitesRes,
        ].some((r) => r.status === 401) ||
        agentLoad.kind === "unauthorized"
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
      if (agentLoad.kind === "ok") {
        setAgents(agentLoad.devices);
        setAgentsTruncated(agentLoad.truncated);
      } else {
        // Clear BOTH. Leaving a stale list under an error banner is bad enough;
        // leaving the truncation notice asserting "only the first N were
        // loaded" about a fetch that loaded nothing is a false factual claim.
        setAgents([]);
        setAgentsTruncated(false);
        failed.push(agentLoad.label);
      }
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

  // Connected vs. not is the API's `connected` boolean. The `status` string then
  // distinguishes healthy ('connected') from degraded ('error' / 'reauth_required').
  const isConnected = status?.connected === true;
  // Cloud connections expose api.ui.com-backed affordances (Sync now, host/site mapping,
  // collectors, sync history). Self-hosted controllers (Task D2) don't, so those are hidden.
  const isSelfHosted = isConnected && status?.connectionType === "self_hosted";
  const isCloud = isConnected && !isSelfHosted;
  const needsReauth = isConnected && status?.status === "reauth_required";
  const hasError = isConnected && status?.status === "error";

  return {
    isOrgScoped,
    status,
    apiKey,
    setApiKey,
    connectMode,
    setConnectMode,
    accountLabel,
    setAccountLabel,
    loading,
    loadError,
    connecting,
    syncing,
    disconnecting,
    hosts,
    hostsLoading,
    hostsError,
    selection,
    setSelection,
    savingMappings,
    syncRuns,
    collectors,
    agents,
    agentsTruncated,
    translateDeviceStatus,
    collectorDrafts,
    savingCollector,
    selfHostedCollectors,
    controllerSites,
    controllerDraft,
    setControllerDraft,
    registeringController,
    savingControllerMappings,
    telemetrySite,
    telemetry,
    telemetryLoading,
    telemetryError,
    detailsError,
    sitesByOrg,
    isConnected,
    isSelfHosted,
    isCloud,
    needsReauth,
    hasError,
    loadHosts,
    loadSelfHosted,
    updateDraft,
    handleSaveMappings,
    handleRegisterController,
    handleSaveControllerMappings,
    handleSaveCollector,
    handleLoadTelemetry,
    handleConnect,
    handleConnectSelfHosted,
    handleSync,
    handleDisconnect,
  };
}
