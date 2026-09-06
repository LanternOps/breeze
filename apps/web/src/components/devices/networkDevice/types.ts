// Local types shared across the network device detail page's modules — the
// page's own props, the fields the single-asset endpoint adds on top of the
// list mapper, the proxy/manual-link device picker shape, and the tab union.
// Kept separate so a module that only needs a type doesn't have to import a
// component file to get it.

export type NetworkDeviceDetailPageProps = {
  assetId: string;
};

// Extra fields the single-asset endpoint (`GET /discovery/assets/:id`) returns
// on top of what `mapAsset` normalizes for the list. Kept local so we read the
// monitoring/identity extras without forking the shared mapper.
export type NetworkAssetExtras = {
  model?: string | null;
  netbiosName?: string | null;
  siteId?: string | null;
  siteName?: string | null;
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
};

export type DeviceOption = { id: string; name: string; online: boolean };

export const VALID_TABS = ['overview', 'monitoring'] as const;
export type Tab = (typeof VALID_TABS)[number];
