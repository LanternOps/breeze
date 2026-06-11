import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { useApprovalTheme, palette, spacing, radii, type } from '../../../theme';
import { haptic } from '../../../lib/motion';
import { useNetworkConnected } from '../../../lib/useNetworkConnected';
import { useVoiceInput } from '../../../lib/useVoiceInput';
import { errorMessage, isListening } from '../../../lib/voiceState';
import { track } from '../../../lib/analytics';

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

// SVG mic glyph: rounded capsule body, stand, base — matches the visual
// weight of the send arrow (1.75-2.25 stroke).
function MicGlyph({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Rect
        x={9}
        y={3}
        width={6}
        height={12}
        rx={3}
        ry={3}
        stroke={color}
        strokeWidth={2}
        fill="none"
      />
      <Path
        d="M5 11 a7 7 0 0 0 14 0 M12 18 L12 21 M9 21 L15 21"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx={12} cy={12} r={0} fill={color} />
    </Svg>
  );
}

export function Composer({ disabled, placeholder, onSend, draft, onDraftConsumed }: Props) {
  const theme = useApprovalTheme('dark');
  const [text, setText] = useState('');
  const lastConsumedDraft = useRef<string | undefined>(undefined);
  const connected = useNetworkConnected();
  const reducedMotion = useReducedMotion();

  // Lift external drafts into the input when they arrive. Track the last
  // consumed value so picking the same chip twice in a row still triggers.
  useEffect(() => {
    if (!draft) return;
    if (lastConsumedDraft.current === draft) return;
    lastConsumedDraft.current = draft;
    setText(draft);
    onDraftConsumed?.();
  }, [draft, onDraftConsumed]);

  // Voice transcripts append to the current draft so the user can layer
  // dictation on top of typed text without losing what they had.
  const handleTranscript = useCallback((spoken: string) => {
    setText((prev) => {
      const trimmedPrev = prev.trim();
      if (trimmedPrev.length === 0) return spoken;
      // Add a space between an existing draft and the new utterance.
      return `${prev}${prev.endsWith(' ') ? '' : ' '}${spoken}`;
    });
    // We log the structural fact a voice utterance landed — not its
    // content. See analytics.ts privacy notes.
    track('chat_voice_used');
  }, []);

  const voice = useVoiceInput({ offline: !connected, onTranscript: handleTranscript });
  const listening = isListening(voice.state);
  const voiceError = errorMessage(voice.state);

  // Mic pulse: opacity 1 ↔ 0.4 every 400ms while listening; respects RM.
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (!listening || reducedMotion) {
      cancelAnimation(pulse);
      pulse.value = 1;
      return;
    }
    pulse.value = withRepeat(
      withSequence(
        withTiming(0.4, { duration: 400 }),
        withTiming(1, { duration: 400 }),
      ),
      -1,
      false,
    );
    return () => {
      cancelAnimation(pulse);
      pulse.value = 1;
    };
  }, [listening, reducedMotion]);

  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  const trimmed = text.trim();
  const hasText = trimmed.length > 0;
  const canSend = !disabled && hasText;
  const sendBg = canSend ? theme.brand : theme.bg3;
  const sendFg = canSend ? palette.approve.onBase : theme.textLo;

  // Mic button is disabled offline OR when the native module isn't present
  // in this build. We still show the button so the layout is stable; tapping
  // surfaces the appropriate guidance via the error tooltip.
  const micEnabled = !disabled && connected && voice.available;
  const micBg = listening ? theme.brand : theme.bg3;
  const micStroke = listening
    ? palette.approve.onBase
    : micEnabled
      ? theme.textHi
      : theme.textLo;

  function handleSend() {
    if (!canSend) return;
    haptic.tap();
    onSend(trimmed);
    setText('');
  }

  function handleMicPress() {
    haptic.tap();
    voice.toggle();
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
      }}
    >
      {voiceError ? (
        <View
          style={{
            paddingHorizontal: spacing[3],
            paddingVertical: spacing[2],
            marginBottom: spacing[2],
            backgroundColor: theme.bg2,
            borderRadius: radii.md,
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing[2],
          }}
        >
          <Text style={[type.meta, { color: theme.textMd, flex: 1 }]}>
            {voiceError}
          </Text>
          {voice.state.kind === 'error' && voice.state.reason === 'permission-denied' ? (
            <Pressable onPress={voice.openSettings} hitSlop={6}>
              <Text style={[type.meta, { color: theme.brand, fontWeight: '600' }]}>
                Settings
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <View
        style={{
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
            placeholder={listening ? 'Listening…' : (placeholder ?? 'Ask Breeze.')}
            placeholderTextColor={theme.textLo}
            editable={!disabled && !listening}
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
        {hasText ? (
          <Pressable
            onPress={handleSend}
            disabled={!canSend}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Send message"
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
        ) : (
          <Pressable
            onPress={handleMicPress}
            disabled={!micEnabled && !listening}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={listening ? 'Stop voice input' : 'Start voice input'}
            accessibilityState={{ busy: listening }}
            style={{
              width: 44,
              height: 44,
              borderRadius: radii.full,
              backgroundColor: micBg,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Animated.View style={pulseStyle}>
              <MicGlyph color={micStroke} />
            </Animated.View>
          </Pressable>
        )}
      </View>
    </View>
  );
}
