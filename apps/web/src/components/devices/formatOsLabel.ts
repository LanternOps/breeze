import { formatDeviceOsVersion, formatDeviceSummaryOs } from './osDisplay';

// Windows 11 kept the NT 10.0 version number; the build is what tells it apart.
const WINDOWS_11_FIRST_BUILD = 22000;

/** "22631.4317" / "10.0.22631.4317" / "22631" -> "22631". */
function windowsBuildNumber(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? '';
  if (!value) return null;
  const parts = value.split('.');
  // A dotted NT version (10.0.22631[.4317]) carries the build third.
  if (parts.length >= 3 && /^\d+$/.test(parts[2] ?? '')) return parts[2]!;
  return /^\d+$/.test(parts[0] ?? '') ? parts[0]! : null;
}

function formatWindows(osVersion: string, osBuild: string | null | undefined): string {
  const named = osVersion.match(/^(?:microsoft\s+)?(windows\b.*)$/i);
  if (named) {
    const name = `Windows${named[1]!.slice('windows'.length)}`.trim();
    const build = windowsBuildNumber(osBuild);
    return build ? `${name} (build ${build})` : name;
  }

  // Bare NT version ("11.0.22631", "10.0.19045.6456") from seeds/older rows.
  // Known limit: a bare version cannot tell a server edition apart (Server
  // 2022 is build 20348, Server 2025 is 26100). Real agents always report the
  // edition name (the branch above), so this fallback only meets bare rows.
  const dotted = osVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (dotted) {
    const major = Number(dotted[1]);
    const build = Number(dotted[3]);
    const release = major >= 11 || build >= WINDOWS_11_FIRST_BUILD ? '11' : String(major);
    return `Windows ${release} (build ${dotted[3]})`;
  }

  const build = windowsBuildNumber(osBuild);
  const label = formatDeviceSummaryOs('windows', osVersion);
  return build ? `${label} (build ${build})` : label;
}

/**
 * The device header's OS label (#9026): "Windows 11 Pro (build 22631)",
 * "macOS 15.1", "Debian 12.12". An unknown OS type shows the raw string.
 */
export function formatOsLabel(
  osType: string | null | undefined,
  osVersion: string | null | undefined,
  osBuild?: string | null,
): string {
  const type = osType?.toLowerCase() ?? '';
  const version = osVersion?.trim() ?? '';

  switch (type) {
    case 'windows':
      return version ? formatWindows(version, osBuild) : 'Windows';
    case 'macos':
      return formatDeviceSummaryOs('macos', version);
    case 'linux':
      return formatDeviceOsVersion('linux', version) || 'Linux';
    default:
      return version || osType?.trim() || 'Unknown OS';
  }
}
