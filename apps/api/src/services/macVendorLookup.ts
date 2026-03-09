import { toVendor } from '@network-utils/vendor-lookup';

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
const VENDOR_ROLE_KEYWORDS: Array<[string[], string]> = [
  [['ubiquiti', 'ruckus', 'cambium', 'mist systems'], 'access_point'],
  [['fortinet', 'sonicwall', 'watchguard', 'palo alto', 'barracuda', 'sophos'], 'firewall'],
  [['synology', 'qnap', 'buffalo', 'drobo'], 'nas'],
  [['hikvision', 'dahua', 'axis communications', 'vivotek', 'hanwha', 'avigilon', 'reolink'], 'camera'],
  [['brother', 'canon', 'epson', 'lexmark', 'xerox', 'ricoh', 'konica', 'kyocera', 'zebra'], 'printer'],
  [['espressif', 'tuya', 'shelly', 'sonoff', 'raspberry pi'], 'iot'],
  // VoIP-specific manufacturers only
  [['polycom', 'yealink', 'grandstream'], 'phone'],
];

export function inferAssetTypeFromVendor(vendor: string | null | undefined): string | null {
  if (!vendor) return null;
  const lower = vendor.toLowerCase();
  for (const [keywords, role] of VENDOR_ROLE_KEYWORDS) {
    if (keywords.some(kw => lower.includes(kw))) return role;
  }
  return null;
}
