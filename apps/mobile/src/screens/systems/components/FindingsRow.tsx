import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { useApprovalTheme, spacing, type } from '../../../theme';

interface Props {
  orgName: string;
  count: number;
  onPress: () => void;
  showDivider?: boolean;
  dividerColor?: string;
}

/**
 * One ACTIVE ISSUES row summarizing an org's open fleet-hygiene findings
 * (#5139 / #5117 decision 1) — VSS/Universal Print/Intel ME/SCEP failures,
 * the same findings `get_fleet_findings` reports to the AI. Visually
 * distinct from `IssueRow` (alerts): a "Finding" label instead of a severity
 * dot, and no swipe-to-acknowledge or selection — a finding is acted on one at
 * a time on its own detail screen, not in bulk from this list.
 *
 * #5365 made the row tappable: it opens the org's findings list, and from
 * there a finding's detail with acknowledge / dismiss / reopen. Before that it
 * was display-only and a tech could see something was wrong without being able
 * to find out what.
 */
export function FindingsRow({ orgName, count, onPress, showDivider, dividerColor }: Props) {
  const theme = useApprovalTheme('dark');

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(180)}
      layout={LinearTransition.duration(220)}
    >
      <Pressable
        testID={`findings-row-${orgName}`}
        accessibilityRole="button"
        accessibilityLabel={`${count} open ${count === 1 ? 'finding' : 'findings'} for ${orgName}`}
        onPress={onPress}
        style={({ pressed }) => ({
          paddingHorizontal: spacing[6],
          paddingVertical: spacing[3],
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: pressed ? theme.bg1 : 'transparent',
        })}
      >
        <View
          accessibilityRole="text"
          style={{
            paddingHorizontal: spacing[2],
            paddingVertical: 2,
            borderRadius: 4,
            backgroundColor: theme.bg2,
            marginRight: spacing[3],
          }}
        >
          <Text style={[type.meta, { color: theme.textMd, fontSize: 10 }]}>Finding</Text>
        </View>
        <View style={{ flex: 1, marginRight: spacing[3] }}>
          <Text style={[type.bodyMd, { color: theme.textHi }]} numberOfLines={1}>
            {count} open {count === 1 ? 'finding' : 'findings'}
          </Text>
          <Text
            style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}
            numberOfLines={1}
          >
            {orgName}
          </Text>
        </View>
      </Pressable>
      {showDivider ? (
        <View
          style={{
            height: 1,
            backgroundColor: dividerColor ?? theme.border,
            marginLeft: spacing[6],
          }}
        />
      ) : null}
    </Animated.View>
  );
}
