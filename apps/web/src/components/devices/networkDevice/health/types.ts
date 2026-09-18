// Props every Health card receives. The registry hands each card the SAME
// shape so adding a card is one file and one registry entry — the page never
// learns which type it is rendering.

import type { JSX } from 'react';
import type { DiscoveredAssetType } from '../../../discovery/DiscoveredAssetList';
import type { Collection } from '../types';

export type HealthCardProps = {
  assetId: string;
  assetType: DiscoveredAssetType;
  collection: Collection | null;
  snmpEnabled: boolean;
  timezone: string;
  /** Opens W04's settings modal at its Monitoring section. */
  onSetUpMonitoring: () => void;
  /** Switches the page to the Monitoring tab. */
  onViewMonitoring: () => void;
};

export type HealthCardComponent = (props: HealthCardProps) => JSX.Element;
