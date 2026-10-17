import { Pressable, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';

import { useApprovalTheme, palette, radii, spacing, type } from '../../../theme';
import { haptic } from '../../../lib/motion';
import { relativeTime } from '../../../lib/relativeTime';
import { toAlert, type AlertLike } from './alertLike';
import type { MainTabParamList } from '../../../navigation/MainNavigator';

export type { AlertLike };

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
      // Keep the Systems root beneath the detail even when the Systems stack
      // has never been mounted; otherwise there is no back button and the
      // Systems tab is stuck on this alert (see navigateToTicket).
      initial: false,
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
