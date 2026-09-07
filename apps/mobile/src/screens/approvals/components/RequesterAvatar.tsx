import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { palette, radii } from '../../../theme';
import { Avatar } from '../../chat/components/Avatar';
import { isBreezeAiRequester } from './requesterAvatarKind';

interface Props {
  clientLabel: string;
  size?: number;
}

// A four-point sparkle — the same mark used to signal "this is Breeze AI,
// not a person" wherever the app needs one glyph rather than a photo/initial.
function SparkleGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 2 L14.2 9.8 L22 12 L14.2 14.2 L12 22 L9.8 14.2 L2 12 L9.8 9.8 Z"
        fill={color}
      />
    </Svg>
  );
}

/**
 * Requester identity for the approval takeover header (#5115). Previously
 * this slot held only the countdown ring — a bare animated circle that read
 * as a loading spinner rather than "who is asking". Chat's AI flow always
 * sends the literal label 'Breeze AI' (see requesterAvatarKind.ts); every
 * other requester is an app or agent name, shown as initials via the same
 * Avatar used in the chat header.
 */
export function RequesterAvatar({ clientLabel, size = 32 }: Props) {
  if (isBreezeAiRequester(clientLabel)) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: radii.full,
          backgroundColor: palette.brand.deep,
          alignItems: 'center',
          justifyContent: 'center',
        }}
        accessibilityLabel="Breeze AI"
      >
        <SparkleGlyph size={size * 0.5} color={palette.dark.textHi} />
      </View>
    );
  }
  return <Avatar name={clientLabel} size={size} />;
}
