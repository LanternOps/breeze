import { Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useApprovalTheme, radii, spacing } from '../../../theme';
import { haptic } from '../../../lib/motion';
import { Avatar } from './Avatar';
import { StatusPill } from './StatusPill';

interface Props {
  userName: string | null | undefined;
  onOpenSettings: () => void;
  onOpenHistory: () => void;
  onNewChat: () => void;
}

function HistoryGlyph({ color }: { color: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path
        d="M3 12 A9 9 0 1 1 6 18.7"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M3 6 L3 12 L8 12"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M12 7 L12 12 L15 14"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

function PlusGlyph({ color }: { color: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path
        d="M12 5 L12 19 M5 12 L19 12"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

function IconButton({
  children,
  onPress,
}: {
  children: React.ReactNode;
  onPress: () => void;
}) {
  const theme = useApprovalTheme('dark');
  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        borderRadius: radii.full,
        backgroundColor: pressed ? theme.bg2 : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
      })}
    >
      {children}
    </Pressable>
  );
}

// Layout (a) per the brief:
//   Avatar · History · [flex] · StatusPill · NewChat
// Avatar opens settings sheet. History opens session list. StatusPill is
// ambient (no tap action). NewChat resets the conversation.
export function ChatHeader({ userName, onOpenSettings, onOpenHistory, onNewChat }: Props) {
  const theme = useApprovalTheme('dark');
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing[2],
        paddingVertical: spacing[2],
        gap: spacing[1],
      }}
    >
      <Avatar name={userName} onPress={onOpenSettings} />
      <IconButton onPress={onOpenHistory}>
        <HistoryGlyph color={theme.textMd} />
      </IconButton>
      <View style={{ flex: 1 }} />
      <StatusPill />
      <IconButton onPress={onNewChat}>
        <PlusGlyph color={theme.textMd} />
      </IconButton>
    </View>
  );
}
