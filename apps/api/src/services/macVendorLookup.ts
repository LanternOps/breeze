import { toVendor, isRandomMac } from '@network-utils/vendor-lookup';

export function lookupMacVendor(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const trimmed = mac.trim();
  if (trimmed.length === 0) return null;
  const vendor = toVendor(trimmed);
  return vendor || null;
}

export { isRandomMac };

// Conservative vendor-to-asset-type mapping: only single-purpose vendors
// where the OUI strongly implies a specific device category.
const VENDOR_ROLE_KEYWORDS: Array<[string[], string]> = [
  // Access points
  [['ubiquiti', 'ruckus', 'cambium', 'mist systems'], 'access_point'],
  // Firewalls
  [['fortinet', 'sonicwall', 'watchguard', 'palo alto', 'barracuda', 'sophos'], 'firewall'],
  // NAS
  [['synology', 'qnap', 'buffalo', 'drobo'], 'nas'],
  // Cameras
  [['hikvision', 'dahua', 'axis communications', 'vivotek', 'hanwha', 'avigilon', 'reolink'], 'camera'],
  // Printers
  [['brother', 'canon', 'epson', 'lexmark', 'xerox', 'ricoh', 'konica', 'kyocera', 'zebra'], 'printer'],
  // IoT
  [['espressif', 'tuya', 'shelly', 'sonoff', 'raspberry pi'], 'iot'],
  // Phones (VoIP-specific manufacturers only)
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
