// The device's one LAN address for the page header. Same four tiers as the
// Devices list's LAN IP column (apps/api/src/routes/devices/core.ts, the
// `lanIpRows` LATERAL query) so the header and the list never disagree:
//   1. is_primary rows first
//   2. IPv4 before IPv6 (techs type v4 addresses)
//   3. routable before APIPA / loopback / link-local (case-insensitive fe80:)
//   4. interface name, for a stable tiebreak

type NetworkRow = {
  interfaceName?: unknown;
  ipAddress?: unknown;
  ipType?: unknown;
  isPrimary?: unknown;
};

function isUnroutable(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower.startsWith('169.254.') || lower.startsWith('127.') || lower.startsWith('fe80:') || lower === '::1';
}

export function pickLanIp(networkInterfaces: unknown): string | null {
  if (!Array.isArray(networkInterfaces)) return null;
  const rows = (networkInterfaces as NetworkRow[])
    .filter((r): r is NetworkRow & { ipAddress: string } =>
      Boolean(r) && typeof r.ipAddress === 'string' && r.ipAddress.trim().length > 0)
    .map((r) => ({
      ip: r.ipAddress.trim(),
      name: typeof r.interfaceName === 'string' ? r.interfaceName : '',
      primary: r.isPrimary === true,
      v4: (typeof r.ipType === 'string' ? r.ipType : 'ipv4') === 'ipv4',
    }));
  if (rows.length === 0) return null;
  rows.sort((a, b) =>
    Number(b.primary) - Number(a.primary) ||
    Number(b.v4) - Number(a.v4) ||
    Number(isUnroutable(a.ip)) - Number(isUnroutable(b.ip)) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows[0]!.ip;
}
