// Local types shared across the network device detail page's modules — the
// page's own props, the fields the single-asset endpoint adds on top of the
// list mapper, the proxy/manual-link device picker shape, and the tab union.
// Kept separate so a module that only needs a type doesn't have to import a
// component file to get it.

export type NetworkDeviceDetailPageProps = {
  assetId: string;
};

export type ReachabilityState = 'responding' | 'not_responding' | 'unverified';
export type ReachabilitySource = 'network_check' | 'probe' | 'scan' | 'unifi' | 'snmp';

export type Reachability = {
  state: ReachabilityState;
  source: ReachabilitySource | null;
  observedAt: string | null;
  lastKnown: { state: 'responding' | 'not_responding'; source: ReachabilitySource; observedAt: string } | null;
  detail: {
    networkCheck?: { state: 'online' | 'degraded' | 'offline'; observedAt: string; responseMs: number | null; monitorId: string };
    probe?: { state: 'ok' | 'failed' | 'pending'; observedAt: string | null; responseMs: number | null };
    snmp?: { state: 'ok' | 'failing' | 'no_template' | 'no_agent' | 'asset_moved' | 'never_polled'; observedAt: string | null; consecutiveFailures: number };
    scan?: { state: 'seen' | 'missed'; observedAt: string | null; source: 'scan' | 'unifi' };
  };
};

export type AssetProbe = {
  state: 'ok' | 'failed' | 'pending';
  responseMs: number | null;
  observedAt: string | null;
  agentId?: string | null;
};

export type CollectionOidState = 'collecting' | 'unsupported' | 'stale' | 'never_polled' | 'unknown';
export type CollectionOidInstance = { oid: string; instance: string; value: string | null; valueType: string; observedAt: string };
export type CollectionOid = {
  baseOid: string;
  name: string;
  mode: 'get' | 'walk';
  cadence: 'fast' | 'slow';
  state: CollectionOidState;
  observedAt: string | null;
  instances: CollectionOidInstance[];
  error: string | null;
};
export type Collection = {
  templateId: string | null;
  lastPolledAt: string | null;
  pollingInterval: number | null;
  status: 'ok' | 'failing' | 'no_template' | 'no_agent' | 'asset_moved' | 'never_polled' | 'paused';
  consecutiveFailures: number;
  oids: CollectionOid[];
};

// Extra fields the single-asset endpoint (`GET /discovery/assets/:id`) returns
// on top of what `mapAsset` normalizes for the list. Kept local so we read the
// monitoring/identity extras without forking the shared mapper.
export type NetworkAssetExtras = {
  model?: string | null;
  netbiosName?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  // The site's IANA zone (`sites.timezone`, always set, defaults to 'UTC').
  // Null only for a site-less asset or an API that predates W05 — the page
  // falls back to the browser zone via `resolveAssetTimezone`.
  siteTimezone?: string | null;
  firstSeenAt?: string | null;
  snmpMonitoringEnabled?: boolean;
  networkMonitoringEnabled?: boolean;
  // The agent device that ran this asset's last discovery scan (or null).
  // This is the proxy bridge default — deliberately separate from
  // `linkedDeviceId`, which is an identity link and would be a loopback if
  // used to bridge a proxy connection to the asset it IS.
  suggestedBridgeDeviceId?: string | null;
  // Set by a manual unlink (#3261 Task 2); cleared by any manual link. Only
  // meaningful while unlinked — explains why auto-linking hasn't re-found
  // this asset instead of leaving "Not linked" unexplained.
  autoLinkSuppressedAt?: string | null;
  // W01 (spec §4.2, §5, §9). Null on a pre-W01 API, which is why every
  // consumer takes `Reachability | null` rather than assuming presence.
  reachability?: Reachability | null;
  probe?: AssetProbe | null;
  nicVendor?: string | null;
};

export type DeviceOption = { id: string; name: string; online: boolean };

export const VALID_TABS = ['overview', 'monitoring'] as const;
export type Tab = (typeof VALID_TABS)[number];
