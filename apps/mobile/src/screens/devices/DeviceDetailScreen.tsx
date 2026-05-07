import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';

import {
  getDeviceMetrics,
  sendDeviceAction,
  type Device,
  type DeviceAction,
} from '../../services/api';
import {
  useApprovalTheme,
  palette,
  radii,
  spacing,
  type,
} from '../../theme';
import { Spinner } from '../../components/Spinner';

interface Props {
  route: { params: { device: Device } };
}

function statusDotColor(status: Device['status']): string {
  switch (status) {
    case 'online':
      return palette.approve.base;
    case 'warning':
      return palette.warning.base;
    case 'offline':
      return palette.deny.base;
    default:
      return palette.dark.textLo;
  }
}

function statusLabel(status: Device['status']): string {
  switch (status) {
    case 'online':
      return 'ONLINE';
    case 'warning':
      return 'WARNING';
    case 'offline':
      return 'OFFLINE';
    default:
      return 'UNKNOWN';
  }
}

function DetailRow({
  label,
  value,
  textHi,
  textLo,
  border,
}: {
  label: string;
  value: string;
  textHi: string;
  textLo: string;
  border: string;
}) {
  return (
    <View
      style={{
        paddingVertical: spacing[3],
        borderBottomWidth: 1,
        borderBottomColor: border,
      }}
    >
      <Text style={[type.metaCaps, { color: textLo }]}>{label}</Text>
      <Text
        style={[type.body, { color: textHi, marginTop: spacing[1] }]}
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

function MetricTile({
  label,
  value,
  textHi,
  textLo,
  bg,
}: {
  label: string;
  value: string;
  textHi: string;
  textLo: string;
  bg: string;
}) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: bg,
        borderRadius: radii.md,
        padding: spacing[4],
      }}
    >
      <Text style={[type.metaCaps, { color: textLo }]}>{label}</Text>
      <Text style={[type.title, { color: textHi, marginTop: spacing[1] }]}>
        {value}
      </Text>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  loading,
  disabled,
  textHi,
  bg,
  border,
  brand,
}: {
  label: string;
  onPress: () => void;
  loading: boolean;
  disabled: boolean;
  textHi: string;
  bg: string;
  border: string;
  brand: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => ({
        flex: 1,
        minWidth: 120,
        paddingVertical: spacing[4],
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: pressed ? textHi : border,
        backgroundColor: pressed ? bg : 'transparent',
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: spacing[2],
        opacity: disabled && !loading ? 0.5 : 1,
      })}
    >
      {loading ? <Spinner color={brand} size={14} /> : null}
      <Text style={[type.bodyMd, { color: textHi }]}>{label}</Text>
    </Pressable>
  );
}

export function DeviceDetailScreen({ route }: Props) {
  const theme = useApprovalTheme('dark');
  const { device } = route.params;
  const [metrics, setMetrics] = useState<Device['metrics']>(device.metrics);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<DeviceAction | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoadingMetrics(true);
    setMetricsError(null);
    getDeviceMetrics(device.id)
      .then((data) => {
        if (mounted) setMetrics(data);
      })
      .catch((err: Error) => {
        if (mounted) setMetricsError(err.message);
      })
      .finally(() => {
        if (mounted) setLoadingMetrics(false);
      });
    return () => {
      mounted = false;
    };
  }, [device.id]);

  async function handleAction(action: DeviceAction) {
    try {
      setActionLoading(action);
      await sendDeviceAction(device.id, action);
      Alert.alert('Sent', `${action} command sent.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not send command.';
      Alert.alert('Failed', msg);
    } finally {
      setActionLoading(null);
    }
  }

  const offline = device.status === 'offline';

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg0 }}
      contentContainerStyle={{
        padding: spacing[6],
        paddingBottom: spacing[10],
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: statusDotColor(device.status),
          }}
        />
        <Text style={[type.metaCaps, { color: theme.textLo }]}>
          {statusLabel(device.status)}
        </Text>
      </View>

      <Text style={[type.title, { color: theme.textHi, marginTop: spacing[3] }]}>
        {device.name}
      </Text>

      <View style={{ marginTop: spacing[5] }}>
        {device.hostname ? (
          <DetailRow
            label="HOSTNAME"
            value={device.hostname}
            textHi={theme.textHi}
            textLo={theme.textLo}
            border={theme.border}
          />
        ) : null}
        {device.ipAddress ? (
          <DetailRow
            label="IP ADDRESS"
            value={device.ipAddress}
            textHi={theme.textHi}
            textLo={theme.textLo}
            border={theme.border}
          />
        ) : null}
        {device.os ? (
          <DetailRow
            label="OPERATING SYSTEM"
            value={device.os}
            textHi={theme.textHi}
            textLo={theme.textLo}
            border={theme.border}
          />
        ) : null}
        {device.agentVersion ? (
          <DetailRow
            label="AGENT VERSION"
            value={device.agentVersion}
            textHi={theme.textHi}
            textLo={theme.textLo}
            border={theme.border}
          />
        ) : null}
        {device.lastSeen ? (
          <DetailRow
            label="LAST SEEN"
            value={new Date(device.lastSeen).toLocaleString()}
            textHi={theme.textHi}
            textLo={theme.textLo}
            border={theme.border}
          />
        ) : null}
        {device.organizationName ? (
          <DetailRow
            label="ORGANIZATION"
            value={device.organizationName}
            textHi={theme.textHi}
            textLo={theme.textLo}
            border={theme.border}
          />
        ) : null}
        {device.siteName ? (
          <DetailRow
            label="SITE"
            value={device.siteName}
            textHi={theme.textHi}
            textLo={theme.textLo}
            border={theme.border}
          />
        ) : null}
      </View>

      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginTop: spacing[8],
        }}
      >
        <Text style={[type.metaCaps, { color: theme.textLo }]}>METRICS</Text>
        {metricsError ? (
          <Text style={[type.meta, { color: palette.deny.base }]}>
            Couldn't refresh
          </Text>
        ) : null}
      </View>

      {loadingMetrics ? (
        <View style={{ paddingVertical: spacing[4] }}>
          <ActivityIndicator color={theme.brand} />
        </View>
      ) : metrics ? (
        <View
          style={{
            flexDirection: 'row',
            gap: spacing[3],
            marginTop: spacing[3],
          }}
        >
          <MetricTile
            label="CPU"
            value={`${metrics.cpuUsage?.toFixed(0) ?? '–'}%`}
            textHi={theme.textHi}
            textLo={theme.textLo}
            bg={theme.bg2}
          />
          <MetricTile
            label="MEMORY"
            value={`${metrics.memoryUsage?.toFixed(0) ?? '–'}%`}
            textHi={theme.textHi}
            textLo={theme.textLo}
            bg={theme.bg2}
          />
          <MetricTile
            label="DISK"
            value={`${metrics.diskUsage?.toFixed(0) ?? '–'}%`}
            textHi={theme.textHi}
            textLo={theme.textLo}
            bg={theme.bg2}
          />
        </View>
      ) : (
        <Text style={[type.body, { color: theme.textMd, marginTop: spacing[3] }]}>
          No metrics available.
        </Text>
      )}

      <Text
        style={[type.metaCaps, { color: theme.textLo, marginTop: spacing[8] }]}
      >
        ACTIONS
      </Text>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: spacing[3],
          marginTop: spacing[3],
        }}
      >
        <ActionButton
          label="Reboot"
          onPress={() => handleAction('reboot')}
          loading={actionLoading === 'reboot'}
          disabled={offline || actionLoading !== null}
          textHi={theme.textHi}
          bg={theme.bg2}
          border={theme.border}
          brand={theme.brand}
        />
        <ActionButton
          label="Shutdown"
          onPress={() => handleAction('shutdown')}
          loading={actionLoading === 'shutdown'}
          disabled={offline || actionLoading !== null}
          textHi={theme.textHi}
          bg={theme.bg2}
          border={theme.border}
          brand={theme.brand}
        />
        <ActionButton
          label="Lock"
          onPress={() => handleAction('lock')}
          loading={actionLoading === 'lock'}
          disabled={offline || actionLoading !== null}
          textHi={theme.textHi}
          bg={theme.bg2}
          border={theme.border}
          brand={theme.brand}
        />
        <ActionButton
          label="Wake"
          onPress={() => handleAction('wake')}
          loading={actionLoading === 'wake'}
          disabled={actionLoading !== null}
          textHi={theme.textHi}
          bg={theme.bg2}
          border={theme.border}
          brand={theme.brand}
        />
      </View>
    </ScrollView>
  );
}
