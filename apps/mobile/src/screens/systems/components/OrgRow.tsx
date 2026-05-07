import { Pressable, Text, View } from 'react-native';

import { useApprovalTheme, spacing, type } from '../../../theme';
import { haptic } from '../../../lib/motion';
import type { OrgRollup } from '../useSystemsData';

interface Props {
  org: OrgRollup;
  onPress: () => void;
}

export function OrgRow({ org, onPress }: Props) {
  const theme = useApprovalTheme('dark');
  const sub =
    org.issueCount === 0
      ? `${org.deviceCount} ${org.deviceCount === 1 ? 'device' : 'devices'}, healthy`
      : `${org.deviceCount} ${org.deviceCount === 1 ? 'device' : 'devices'} · ${org.issueCount} ${org.issueCount === 1 ? 'issue' : 'issues'}`;

  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      style={({ pressed }) => ({
        paddingHorizontal: spacing[6],
        paddingVertical: spacing[3],
        backgroundColor: pressed ? theme.bg2 : 'transparent',
      })}
    >
      <Text style={[type.bodyMd, { color: theme.textHi }]} numberOfLines={1}>
        {org.name}
      </Text>
      <Text
        style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}
        numberOfLines={1}
      >
        {sub}
      </Text>
    </Pressable>
  );
}
