import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';

import { useAppDispatch } from '../../store';
import { acknowledgeAlertAsync } from '../../store/alertsSlice';
import { getAlert, sendDeviceAction, type Alert as AlertModel } from '../../services/api';
import { canRebootFromAlert, needsSourceLookup, rebootConfirmMessage } from './alertActions';
import { relativeTime } from '../../lib/relativeTime';
import {
  useApprovalTheme,
  palette,
  radii,
  spacing,
  type,
} from '../../theme';

/**
 * Relative time reads at a glance, but an absolute timestamp is genuinely
 * useful on a detail screen, so this keeps both rather than picking one (same
 * approach as DeviceDetailScreen's LAST SEEN row).
 */
function formatTimestamp(iso: string): string {
  const rel = relativeTime(iso);
  const abs = new Date(iso).toLocaleString();
  return rel ? `${rel} · ${abs}` : abs;
}

interface Props {
  route: { params: { alert: AlertModel } };
}

function severityColor(sev: AlertModel['severity']): string {
  switch (sev) {
    case 'critical':
    case 'high':
      return palette.deny.base;
    case 'medium':
    case 'low':
      return palette.warning.base;
    default:
      return palette.dark.textLo;
  }
}

function severityOnColor(sev: AlertModel['severity']): string {
  switch (sev) {
    case 'critical':
    case 'high':
      return palette.deny.onBase;
    case 'medium':
    case 'low':
      return palette.warning.onBase;
    default:
      return palette.dark.textHi;
  }
}

function DetailRow({
  label,
  value,
  textHi,
  textLo,
}: {
  label: string;
  value: string;
  textHi: string;
  textLo: string;
}) {
  return (
    <View style={{ marginTop: spacing[4] }}>
      <Text style={[type.metaCaps, { color: textLo }]}>{label}</Text>
      <Text style={[type.body, { color: textHi, marginTop: spacing[1] }]}>
        {value}
      </Text>
    </View>
  );
}

export function AlertDetailScreen({ route }: Props) {
  const theme = useApprovalTheme('dark');
  const dispatch = useAppDispatch();
  const { alert } = route.params;
  const [acking, setAcking] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const [rebootSent, setRebootSent] = useState(false);
  const [fresh, setFresh] = useState<AlertModel | null>(null);
  // A fetched copy supplies both the source and the current status, since a
  // chat-built alert carries neither.
  const showReboot = canRebootFromAlert(
    fresh ? { ...alert, source: fresh.source, metadata: fresh.metadata } : alert,
  );

  useEffect(() => {
    if (!needsSourceLookup(alert)) return;
    let mounted = true;
    getAlert(alert.id)
      .then((fetched) => {
        if (mounted) setFresh(fetched);
      })
      // Only the Reboot now button depends on this; without it the screen
      // shows Acknowledge alone, as before.
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [alert]);

  async function handleAcknowledge() {
    try {
      setAcking(true);
      await dispatch(acknowledgeAlertAsync(alert.id)).unwrap();
      Alert.alert('Acknowledged', 'Alert marked as acknowledged.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not acknowledge.';
      Alert.alert('Failed', msg);
    } finally {
      setAcking(false);
    }
  }

  async function sendReboot(deviceId: string) {
    try {
      setRebooting(true);
      await sendDeviceAction(deviceId, 'reboot');
      setRebootSent(true);
      Alert.alert(
        'Restart sent',
        'The device restarts when its agent picks up the command. This alert stays open; acknowledge it once the device is back.',
      );
    } catch (err) {
      const msg = (err as { message?: string })?.message || 'Could not send the restart.';
      Alert.alert('Failed', msg);
    } finally {
      setRebooting(false);
    }
  }

  function handleReboot() {
    const deviceId = alert.deviceId;
    if (!deviceId) return;
    Alert.alert('Restart device', rebootConfirmMessage(alert), [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Restart now', style: 'destructive', onPress: () => void sendReboot(deviceId) },
    ]);
  }

  const sevBg = severityColor(alert.severity);
  const sevFg = severityOnColor(alert.severity);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg0 }}
      contentContainerStyle={{
        padding: spacing[6],
        paddingBottom: spacing[10],
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          gap: spacing[2],
          flexWrap: 'wrap',
        }}
      >
        <View
          style={{
            backgroundColor: sevBg,
            paddingHorizontal: spacing[3],
            paddingVertical: spacing[1],
            borderRadius: radii.full,
          }}
        >
          <Text style={[type.metaCaps, { color: sevFg }]}>
            {alert.severity.toUpperCase()}
          </Text>
        </View>
        {alert.acknowledged ? (
          <View
            style={{
              backgroundColor: palette.approve.base,
              paddingHorizontal: spacing[3],
              paddingVertical: spacing[1],
              borderRadius: radii.full,
            }}
          >
            <Text style={[type.metaCaps, { color: palette.approve.onBase }]}>
              ACKNOWLEDGED
            </Text>
          </View>
        ) : null}
      </View>

      <Text
        style={[type.title, { color: theme.textHi, marginTop: spacing[5] }]}
      >
        {alert.title}
      </Text>
      <Text
        style={[type.body, { color: theme.textMd, marginTop: spacing[3] }]}
      >
        {alert.message}
      </Text>

      {alert.category ? (
        <DetailRow
          label="CATEGORY"
          value={alert.category}
          textHi={theme.textHi}
          textLo={theme.textLo}
        />
      ) : null}
      {alert.deviceName ? (
        <DetailRow
          label="DEVICE"
          value={alert.deviceName}
          textHi={theme.textHi}
          textLo={theme.textLo}
        />
      ) : null}
      <DetailRow
        label="CREATED"
        value={formatTimestamp(alert.createdAt)}
        textHi={theme.textHi}
        textLo={theme.textLo}
      />
      {alert.acknowledgedAt ? (
        <DetailRow
          label="ACKNOWLEDGED AT"
          value={formatTimestamp(alert.acknowledgedAt)}
          textHi={theme.textHi}
          textLo={theme.textLo}
        />
      ) : null}

      {!alert.acknowledged ? (
        <Pressable
          onPress={handleAcknowledge}
          disabled={acking}
          style={({ pressed }) => ({
            marginTop: spacing[8],
            paddingVertical: spacing[5],
            borderRadius: radii.lg,
            backgroundColor: pressed ? palette.approve.pressed : palette.approve.base,
            alignItems: 'center',
            opacity: acking ? 0.6 : 1,
          })}
        >
          <Text style={[type.bodyMd, { color: palette.approve.onBase }]}>
            {acking ? 'Acknowledging' : 'Acknowledge'}
          </Text>
        </Pressable>
      ) : null}

      {showReboot ? (
        <Pressable
          onPress={handleReboot}
          disabled={rebooting || rebootSent}
          style={({ pressed }) => ({
            marginTop: alert.acknowledged ? spacing[8] : spacing[3],
            paddingVertical: spacing[5],
            borderRadius: radii.lg,
            backgroundColor: palette.warning.base,
            alignItems: 'center',
            opacity: rebooting || rebootSent ? 0.6 : pressed ? 0.8 : 1,
          })}
        >
          <Text style={[type.bodyMd, { color: palette.warning.onBase }]}>
            {rebootSent ? 'Restart sent' : rebooting ? 'Sending restart' : 'Reboot now'}
          </Text>
        </Pressable>
      ) : null}

      {!alert.acknowledged || showReboot ? (
        <Text
          style={[type.body, { color: theme.textLo, marginTop: spacing[3] }]}
        >
          {showReboot
            ? 'Acknowledge only marks this alert as seen. It does not restart the device. Reboot now asks for confirmation, then restarts it.'
            : 'Acknowledge marks this alert as seen. It does not change anything on the device.'}
        </Text>
      ) : null}
    </ScrollView>
  );
}
