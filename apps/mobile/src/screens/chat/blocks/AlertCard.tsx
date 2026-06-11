import { Pressable, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';

import { useApprovalTheme, palette, radii, spacing, type } from '../../../theme';
import { haptic } from '../../../lib/motion';
import { relativeTime } from '../../../lib/relativeTime';
import type { Alert } from '../../../services/api';
import type { MainTabParamList } from '../../../navigation/MainNavigator';

// Loose shape so we tolerate AI tool outputs that don't quite match the
// canonical Alert type. Anything missing is filled with safe defaults
// before navigating to SystemsAlertDetail.
export interface AlertLike {
  id?: string;
  title?: string | null;
  message?: string | null;
  severity?: string | null;
  type?: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
  deviceHostname?: string | null;
  acknowledged?: boolean | null;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface Props {
  alert: AlertLike;
}

function severityColor(sev: string | null | undefined): string {
  switch ((sev ?? '').toLowerCase()) {
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

// Coerce a loose AlertLike into the strict Alert shape that
// AlertDetailScreen expects. Missing fields get neutral defaults so the
// detail screen renders without runtime errors.
export function toAlert(a: AlertLike): Alert {
  const sev = (a.severity ?? 'info').toLowerCase();
  const normalizedSeverity: Alert['severity'] =
    sev === 'critical' || sev === 'high' || sev === 'medium' || sev === 'low' || sev === 'info'
      ? (sev as Alert['severity'])
      : 'info';
  return {
    id: a.id ?? '',
    title: a.title ?? 'Alert',
    message: a.message ?? '',
    severity: normalizedSeverity,
    type: a.type ?? 'unknown',
    deviceId: a.deviceId ?? undefined,
    deviceName: a.deviceName ?? a.deviceHostname ?? undefined,
    acknowledged: Boolean(a.acknowledged),
    acknowledgedAt: a.acknowledgedAt ?? undefined,
    acknowledgedBy: a.acknowledgedBy ?? undefined,
    createdAt: a.createdAt ?? new Date().toISOString(),
    updatedAt: a.updatedAt ?? a.createdAt ?? new Date().toISOString(),
  };
}

// Card style block: severity dot + title + device subtitle + relative
// time. Slightly more padded than the Systems IssueRow because this lives
// inside a chat message, not a dense list.
export function AlertCard({ alert }: Props) {
  const theme = useApprovalTheme('dark');
  const navigation = useNavigation<BottomTabNavigationProp<MainTabParamList>>();

  const dot = severityColor(alert.severity);
  const title = alert.title ?? 'Alert';
  const subtitle = alert.deviceName ?? alert.deviceHostname ?? '';
  const time = relativeTime(alert.createdAt ?? null);

  const onPress = () => {
    haptic.tap();
    navigation.navigate('SystemsTab', {
      screen: 'SystemsAlertDetail',
      params: { alert: toAlert(alert) },
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
        paddingVertical: spacing[4],
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
          {title}
        </Text>
        {time ? (
          <Text style={[type.meta, { color: theme.textLo, marginLeft: spacing[2] }]}>
            {time}
          </Text>
        ) : null}
      </View>
      {subtitle ? (
        <Text
          style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}
          numberOfLines={1}
        >
          {subtitle}
        </Text>
      ) : null}
    </Pressable>
  );
}
