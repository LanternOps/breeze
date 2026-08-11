import { toVendor } from '@network-utils/vendor-lookup';
import type { discoveredAssetTypeEnum } from '../db/schema';

type DiscoveredAssetType = typeof discoveredAssetTypeEnum.enumValues[number];

const SENTINEL_VALUES = new Set(['<random MAC>', '<unknown>', '<private>']);

export function lookupMacVendor(mac: string | null | undefined): string | null {
  if (!mac) return null;
  try {
    const vendor = toVendor(mac.trim());
    if (!vendor || SENTINEL_VALUES.has(vendor)) return null;
    return vendor;
  } catch {
    return null;
  }
}

// Conservative vendor-to-asset-type mapping: only single-purpose vendors
// where the OUI strongly implies a specific device category.
//
// This is the WEAKEST classifier in the precedence ladder (see
// services/discoveredAssetClassification.ts) — a vendor string narrows the
// product category at best and can never identify a product line. Adding a
// multi-line manufacturer here mislabels most of its catalogue, so the bar for
// an entry is that the vendor makes essentially ONE kind of box.
//
// Ubiquiti was removed (#3187): it ships switches (UniFi Switch), gateways
// (UDM/USG), cameras (Protect) and APs under one OUI, so mapping it to
// access_point mislabelled three product lines out of four — and because the
// UniFi sync stamps manufacturer='Ubiquiti' on every row it touches, this rule
// fired on gear the UniFi controller had already classified correctly.
const VENDOR_ROLE_KEYWORDS: Array<[string[], DiscoveredAssetType]> = [
  [['ruckus', 'cambium', 'mist systems'], 'access_point'],
  [['fortinet', 'sonicwall', 'watchguard', 'palo alto', 'barracuda', 'sophos'], 'firewall'],
  [['synology', 'qnap', 'buffalo', 'drobo'], 'nas'],
  [['hikvision', 'dahua', 'axis communications', 'vivotek', 'hanwha', 'avigilon', 'reolink'], 'camera'],
  [['brother', 'canon', 'epson', 'lexmark', 'xerox', 'ricoh', 'konica', 'kyocera', 'zebra'], 'printer'],
  [['espressif', 'tuya', 'shelly', 'sonoff', 'raspberry pi'], 'iot'],
  // VoIP-specific manufacturers only
  [['polycom', 'yealink', 'grandstream'], 'phone'],
];

export function inferAssetTypeFromVendor(
  vendor: string | null | undefined,
): DiscoveredAssetType | null {
  if (!vendor) return null;
  const lower = vendor.toLowerCase();
  for (const [keywords, role] of VENDOR_ROLE_KEYWORDS) {
    if (keywords.some(kw => lower.includes(kw))) return role;
  }
  return null;
}
