const osTypeLabels: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

const linuxNameOverrides: Record<string, string> = {
  'alma linux': 'AlmaLinux',
  almalinux: 'AlmaLinux',
  'amazon linux': 'Amazon Linux',
  amazonlinux: 'Amazon Linux',
  arch: 'Arch',
  bazzite: 'Bazzite',
  cachyos: 'CachyOS',
  centos: 'CentOS',
  debian: 'Debian',
  'elementary os': 'elementary OS',
  elementaryos: 'elementary OS',
  endeavouros: 'EndeavourOS',
  fedora: 'Fedora',
  garuda: 'Garuda',
  kali: 'Kali',
  'kde neon': 'KDE neon',
  kdeneon: 'KDE neon',
  linux: 'Linux',
  'linux lite': 'Linux Lite',
  linuxlite: 'Linux Lite',
  'linux mint': 'Linux Mint',
  linuxmint: 'Linux Mint',
  manjaro: 'Manjaro',
  nixos: 'NixOS',
  nobara: 'Nobara',
  opensuse: 'openSUSE',
  'oracle linux': 'Oracle Linux',
  oraclelinux: 'Oracle Linux',
  os: 'OS',
  'pop os': 'Pop!_OS',
  popos: 'Pop!_OS',
  'proxmox ve': 'Proxmox VE',
  proxmox: 'Proxmox VE',
  proxmoxve: 'Proxmox VE',
  'raspberry pi os': 'Raspberry Pi OS',
  raspberrypios: 'Raspberry Pi OS',
  raspbian: 'Raspbian',
  'red hat enterprise linux': 'Red Hat Enterprise Linux',
  redhat: 'Red Hat',
  redhatenterpriselinux: 'Red Hat Enterprise Linux',
  rhel: 'RHEL',
  rocky: 'Rocky Linux',
  'rocky linux': 'Rocky Linux',
  sles: 'SLES',
  steamos: 'SteamOS',
  suse: 'SUSE',
  'suse linux enterprise server': 'SUSE Linux Enterprise Server',
  suselinuxenterpriseserver: 'SUSE Linux Enterprise Server',
  'truenas scale': 'TrueNAS SCALE',
  truenasscale: 'TrueNAS SCALE',
  ubuntu: 'Ubuntu',
  unraid: 'Unraid',
  zorin: 'Zorin',
};

const linuxPrefixedDistros = new Set(['lite', 'mint']);

function normalizeLinuxNameKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[!]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLinuxName(value: string): string {
  const key = normalizeLinuxNameKey(value);
  const compactKey = key.replace(/\s+/g, '');
  const override = linuxNameOverrides[key] ?? linuxNameOverrides[compactKey];
  if (override) return override;

  return value
    .split(/([ _-])/)
    .map((part) => {
      if (part === ' ' || part === '_' || part === '-') return part === '_' ? ' ' : part;
      const partKey = normalizeLinuxNameKey(part);
      return linuxNameOverrides[partKey] ?? `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join('');
}

function normalizeLinuxDistroName(value: string): string {
  const withoutKernelPrefix = value.replace(/^linux\s+([a-z][a-z0-9!_]*)/i, (match, nextToken: string) => {
    return linuxPrefixedDistros.has(normalizeLinuxNameKey(nextToken)) ? match : nextToken;
  }).trim();

  return withoutKernelPrefix.replace(/^[a-z][a-z0-9!_]*(?:[ _-][a-z][a-z0-9!_]*)*/i, (name) =>
    normalizeLinuxName(name)
  );
}

function versionNamesWindows(version: string): boolean {
  return /windows/i.test(version);
}

function versionNamesMacos(version: string): boolean {
  return /(?:macos|mac\s+os(?:\s+x)?|os\s+x)/i.test(version);
}

function versionNamesLinux(version: string): boolean {
  return /linux/i.test(version);
}

export function formatDeviceOsVersion(
  osType: string | null | undefined,
  osVersion: string | null | undefined,
): string {
  const type = osType?.toLowerCase() ?? '';
  const raw = osVersion?.trim() ?? '';
  if (!raw) return '';

  if (type === 'macos') {
    if (/^macos\b/i.test(raw)) return raw.replace(/^macos\b/i, 'macOS');
    if (versionNamesMacos(raw)) return raw;

    if (/^darwin(?:\s+|$)/i.test(raw)) {
      const withoutDarwin = raw.replace(/^darwin(?:\s+|$)/i, '').trim();
      return withoutDarwin ? `macOS ${withoutDarwin}` : 'macOS';
    }

    return `macOS ${raw}`;
  }

  if (type === 'linux') {
    return normalizeLinuxDistroName(raw);
  }

  return raw;
}

export function formatDeviceDetailOsVersion(
  osType: string | null | undefined,
  osVersion: string | null | undefined,
): string {
  const formatted = formatDeviceOsVersion(osType, osVersion);
  if (osType?.toLowerCase() !== 'macos') return formatted;

  return formatted.replace(/^macOS\s*/i, '').trim();
}

export function formatDeviceSummaryOs(
  osType: string | null | undefined,
  osVersion: string | null | undefined,
): string {
  const type = osType?.toLowerCase() ?? '';
  const label = osTypeLabels[type] ?? osType ?? '';
  const version = formatDeviceOsVersion(osType, osVersion);

  if (!version) return label || 'Unknown OS';
  if (type === 'windows') return versionNamesWindows(version) ? version : `Windows ${version}`;
  if (type === 'macos') return versionNamesMacos(version) ? version : `macOS ${version}`;
  if (type === 'linux') return versionNamesLinux(version) ? version : `Linux ${version}`;
  return label ? `${label} ${version}` : version;
}
