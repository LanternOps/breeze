import { Pressable, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';

import { useApprovalTheme, palette, radii, spacing, type } from '../../../theme';
import { relativeTime } from '../../../lib/relativeTime';
import { haptic } from '../../../lib/motion';
import type { Device } from '../../../services/api';
import type { MainTabParamList } from '../../../navigation/MainNavigator';

export interface DeviceLike {
  id?: string;
  hostname?: string | null;
  displayName?: string | null;
  name?: string | null;
  osType?: string | null;
  osVersion?: string | null;
  os?: string | null;
  ipAddress?: string | null;
  agentVersion?: string | null;
  status?: string | null;
  lastSeenAt?: string | null;
  lastSeen?: string | null;
  organizationId?: string | null;
  organizationName?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface Props {
  device: DeviceLike;
}

// Map a loose DeviceLike from a chat tool result onto the strict Device
// shape the SystemsDeviceDetail screen expects. Missing fields get
// neutral defaults so the detail view renders without runtime errors.
export function toDevice(d: DeviceLike): Device {
  const status: Device['status'] =
    d.status === 'online' || d.status === 'offline' || d.status === 'warning'
      ? d.status
      : 'offline';
  const os =
    d.os ?? (d.osType ? (d.osVersion ? `${d.osType} ${d.osVersion}` : d.osType) : undefined);
  const name = d.displayName ?? d.name ?? d.hostname ?? d.id ?? 'Unknown device';
  return {
    id: d.id ?? '',
    name,
    hostname: d.hostname ?? undefined,
    ipAddress: d.ipAddress ?? undefined,
    os,
    agentVersion: d.agentVersion ?? undefined,
    status,
    lastSeen: d.lastSeen ?? d.lastSeenAt ?? undefined,
    organizationId: d.organizationId ?? undefined,
    organizationName: d.organizationName ?? undefined,
    siteId: d.siteId ?? undefined,
    siteName: d.siteName ?? undefined,
    createdAt: d.createdAt ?? new Date().toISOString(),
    updatedAt: d.updatedAt ?? d.createdAt ?? new Date().toISOString(),
  };
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
  const navigation = useNavigation<BottomTabNavigationProp<MainTabParamList>>();
  const name = device.hostname || device.displayName || device.name || device.id || 'Unknown device';
  const dot = statusDotColor(device.status);
  const last = relativeTime(device.lastSeenAt ?? device.lastSeen ?? null);

  const metaParts: string[] = [];
  if (device.osType) {
    metaParts.push(device.osVersion ? `${device.osType} ${device.osVersion}` : device.osType);
  } else if (device.os) {
    metaParts.push(device.os);
  }
  if (last) metaParts.push(last);
  if (device.siteName) metaParts.push(device.siteName);

  const onPress = () => {
    haptic.tap();
    navigation.navigate('SystemsTab', {
      screen: 'SystemsDeviceDetail',
      params: { device: toDevice(device) },
    } as never);
  };

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        marginHorizontal: spacing[6],
        marginTop: spacing[3],
        backgroundColor: pressed ? theme.bg3 : theme.bg2,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: theme.border,
        paddingHorizontal: spacing[4],
        paddingVertical: spacing[3],
      })}
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
    </Pressable>
  );
}
