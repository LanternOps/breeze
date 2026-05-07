import { Text, View } from 'react-native';

import { useApprovalTheme, palette, radii, spacing, type } from '../../../theme';

export interface DeviceLike {
  id?: string;
  hostname?: string | null;
  displayName?: string | null;
  osType?: string | null;
  osVersion?: string | null;
  status?: string | null;
  lastSeenAt?: string | null;
  siteName?: string | null;
}

interface Props {
  device: DeviceLike;
}

function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const diffMs = Date.now() - t;
  if (diffMs < 0) return 'just now';
  const m = Math.round(diffMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return `${Math.round(d / 7)}w ago`;
}

function statusDotColor(status: string | null | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'online':
    case 'healthy':
    case 'active':
      return palette.approve.base;
    case 'warning':
    case 'degraded':
      return palette.warning.base;
    case 'offline':
    case 'decommissioned':
    case 'failed':
      return palette.deny.base;
    default:
      return palette.dark.textLo;
  }
}

// Flat card: Surface 2 fill, hairline border, no shadow. Hostname leads
// with a 6px status dot. Meta line is os · last-seen · site, separator
// middot — never a comma.
export function DeviceCard({ device }: Props) {
  const theme = useApprovalTheme('dark');
  const name = device.hostname || device.displayName || device.id || 'Unknown device';
  const dot = statusDotColor(device.status);
  const last = relativeTime(device.lastSeenAt ?? null);

  const metaParts: string[] = [];
  if (device.osType) {
    metaParts.push(device.osVersion ? `${device.osType} ${device.osVersion}` : device.osType);
  }
  if (last) metaParts.push(last);
  if (device.siteName) metaParts.push(device.siteName);

  return (
    <View
      style={{
        marginHorizontal: spacing[6],
        marginTop: spacing[3],
        backgroundColor: theme.bg2,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: theme.border,
        paddingHorizontal: spacing[4],
        paddingVertical: spacing[3],
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: dot,
            marginRight: spacing[2],
          }}
        />
        <Text
          style={[type.bodyMd, { color: theme.textHi, flex: 1 }]}
          numberOfLines={1}
        >
          {name}
        </Text>
      </View>
      {metaParts.length > 0 ? (
        <Text
          style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}
          numberOfLines={1}
        >
          {metaParts.join(' · ')}
        </Text>
      ) : null}
    </View>
  );
}
