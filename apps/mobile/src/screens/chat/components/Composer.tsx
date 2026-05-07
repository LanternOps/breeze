import { useEffect, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useApprovalTheme, palette, spacing, radii, type } from '../../../theme';
import { haptic } from '../../../lib/motion';

interface Props {
  disabled?: boolean;
  placeholder?: string;
  onSend: (text: string) => void;
  // External draft injection — used when a cold-open chip is tapped, the
  // chip's text is lifted into the composer and immediately sent.
  draft?: string;
  onDraftConsumed?: () => void;
}

// SVG arrow-up glyph. Using react-native-svg (already in deps) avoids
// pulling an icon font for a single button.
function SendGlyph({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        d="M12 4 L12 20 M5 11 L12 4 L19 11"
        stroke={color}
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

export function Composer({ disabled, placeholder, onSend, draft, onDraftConsumed }: Props) {
  const theme = useApprovalTheme('dark');
  const [text, setText] = useState('');
  const lastConsumedDraft = useRef<string | undefined>(undefined);

  // Lift external drafts into the input when they arrive. Track the last
  // consumed value so picking the same chip twice in a row still triggers.
  useEffect(() => {
    if (!draft) return;
    if (lastConsumedDraft.current === draft) return;
    lastConsumedDraft.current = draft;
    setText(draft);
    onDraftConsumed?.();
  }, [draft, onDraftConsumed]);

  const trimmed = text.trim();
  const canSend = !disabled && trimmed.length > 0;
  const sendBg = canSend ? theme.brand : theme.bg3;
  const sendFg = canSend ? palette.approve.onBase : theme.textLo;

  function handleSend() {
    if (!canSend) return;
    haptic.tap();
    onSend(trimmed);
    setText('');
  }

  return (
    <View
      style={{
        paddingHorizontal: spacing[4],
        paddingTop: spacing[3],
        paddingBottom: spacing[3],
        backgroundColor: theme.bg0,
        borderTopWidth: 1,
        borderTopColor: theme.border,
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: spacing[2],
      }}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: theme.bg2,
          borderRadius: radii.lg,
          paddingHorizontal: spacing[4],
          paddingVertical: spacing[3],
          minHeight: 44,
          maxHeight: 140,
          justifyContent: 'center',
        }}
      >
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder ?? 'Ask Breeze.'}
          placeholderTextColor={theme.textLo}
          editable={!disabled}
          multiline
          textAlignVertical="center"
          submitBehavior="newline"
          onSubmitEditing={handleSend}
          style={[
            type.body,
            { color: theme.textHi, padding: 0 },
          ]}
        />
      </View>
      <Pressable
        onPress={handleSend}
        disabled={!canSend}
        hitSlop={8}
        style={{
          width: 44,
          height: 44,
          borderRadius: radii.full,
          backgroundColor: sendBg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <SendGlyph color={sendFg} />
      </Pressable>
    </View>
  );
}
