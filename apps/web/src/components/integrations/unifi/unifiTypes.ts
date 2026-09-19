// Shared types + small pure helpers for the UniFi integration panel, split out
// of UnifiIntegration.tsx (#2382) so `useUnifiIntegration` and the per-card
// components can share a single definition instead of redeclaring shapes.

export type ConnectionStatus = "connected" | "error" | "reauth_required";

// Mirrors the GET /unifi contract: `{ connected: false }` when not connected, otherwise
// `{ connected: true, connectionType, status, accountLabel, lastSyncAt, lastSyncStatus, lastSyncError }`.
export type UnifiConnectionType = "cloud" | "self_hosted";
export interface UnifiStatus {
  connected: boolean;
  connectionType?: UnifiConnectionType;
  status?: ConnectionStatus;
  accountLabel?: string | null;
  lastSyncAt?: string | null;
  lastSyncStatus?: string | null;
  lastSyncError?: string | null;
}

// Live host+site list discovered from GET /unifi/hosts (calls UniFi directly).
export interface UnifiHostOption {
  id: string;
  name: string;
  model?: string | null;
  sites: Array<{ id: string; name: string }>;
}
// Breeze sites/orgs that a UniFi site can be mapped onto (from GET /orgs/*).
export interface BreezeSiteOption {
  id: string;
  name: string;
  orgId: string;
}
export interface OrgOption {
  id: string;
  name: string;
}
// Currently-saved mappings (from GET /unifi/mappings).
export interface SavedMapping {
  id: string;
  orgId: string;
  siteId: string;
  unifiHostId: string;
  unifiSiteId: string;
  unifiHostName: string | null;
  unifiSiteName: string | null;
}
// Sync-run ledger rows (from GET /unifi/sync-runs).
export interface SyncRun {
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
export interface UnifiCollector {
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
// Field names mirror the devices list response (apps/api/src/routes/devices/core.ts):
// it returns `hostname` + `displayName`, never a `name`.
export interface AgentDevice {
  id: string;
  hostname: string | null;
  displayName: string | null;
  siteId: string | null;
  status?: string | null;
}

// Deep telemetry rows (from GET /unifi/telemetry?siteId=).
export interface TelemetryDevice {
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
export interface TelemetryClient {
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
export interface CollectorDraft {
  siteId: string;
  collectorDeviceId: string;
  controllerUrl: string;
  apiKey: string;
}
// Agent-discovered local site on a self-hosted controller (from GET /unifi/controller-sites).
// `collectorId` is the unifi_collectors row id, used as the sentinel host id when mapping.
export interface ControllerSite {
  collectorId: string;
  localSiteId: string;
  name: string | null;
  mapped: boolean;
}
// Registration draft for a self-hosted controller (Task D2).
export interface ControllerDraft {
  controllerUrl: string;
  collectorDeviceId: string;
  siteId: string;
  apiKey: string;
}

// Breeze sites grouped by organization, for the <optgroup> pickers.
export interface SiteGroup {
  id: string;
  name: string;
  sites: BreezeSiteOption[];
}

// Stable key for a discovered UniFi site within a host (host ids repeat across hosts otherwise).
export const mapKey = (hostId: string, unifiSiteId: string) =>
  `${hostId}::${unifiSiteId}`;
