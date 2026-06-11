import { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';

import { useAppDispatch } from '../../store';
import { acknowledgeAlertAsync } from '../../store/alertsSlice';
import type { Alert as AlertModel } from '../../services/api';
import {
  useApprovalTheme,
  palette,
  radii,
  spacing,
  type,
} from '../../theme';

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

      <DetailRow
        label="TYPE"
        value={alert.type}
        textHi={theme.textHi}
        textLo={theme.textLo}
      />
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
        value={new Date(alert.createdAt).toLocaleString()}
        textHi={theme.textHi}
        textLo={theme.textLo}
      />
      {alert.acknowledgedAt ? (
        <DetailRow
          label="ACKNOWLEDGED AT"
          value={new Date(alert.acknowledgedAt).toLocaleString()}
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
    </ScrollView>
  );
}
