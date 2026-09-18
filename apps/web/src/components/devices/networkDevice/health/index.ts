// The Health card is the only place the page varies by device type (D8: no
// per-type tabs). A registry keyed on DiscoveredAssetType keeps that variation
// to one lookup — adding a UPS or NAS card later is one entry and one file,
// not a new tab and not a branch inside the page component.

import type { DiscoveredAssetType } from '../../../discovery/DiscoveredAssetList';
import type { Collection } from '../types';
import type { HealthCardComponent } from './types';
import { EmptyHealth } from './EmptyHealth';
import { GenericHealth } from './GenericHealth';
import { PrinterHealth } from './PrinterHealth';

const REGISTRY: Partial<Record<DiscoveredAssetType, HealthCardComponent>> = {
  printer: PrinterHealth,
};

export function resolveHealthCard({
  assetType,
  collection,
  snmpEnabled,
}: {
  assetType: DiscoveredAssetType;
  collection: Collection | null;
  snmpEnabled: boolean;
}): HealthCardComponent {
  // No SNMP device at all (or one that is switched off) is the set-up case.
  // A device WITH SNMP that has no template is a different failure: the type
  // card explains it, because telling someone to "set up monitoring" they have
  // already set up is how the real fix gets missed.
  if (!snmpEnabled || collection === null) return EmptyHealth;
  return REGISTRY[assetType] ?? GenericHealth;
}

export { EmptyHealth, GenericHealth, PrinterHealth };
export type { HealthCardComponent, HealthCardProps } from './types';
