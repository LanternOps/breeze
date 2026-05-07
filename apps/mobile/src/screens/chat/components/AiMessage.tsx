import { Fragment } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { useApprovalTheme, spacing, type } from '../../../theme';
import type { ChatMessage } from '../../../store/aiChatSlice';
import { renderBlockForOutput } from '../blocks';

import { MarkdownBody } from './MarkdownBody';
import { StreamingPulse } from './StreamingPulse';
import { ToolIndicator } from './ToolIndicator';

interface Props {
  message: Extract<ChatMessage, { role: 'assistant' }>;
  inFlightTool: { toolUseId: string; toolName: string } | null;
  onRetry?: () => void;
}

// AI messages are unboxed text-on-canvas. No bubble, no avatar bezel. The
// row contains: completed tool events (rendered as ToolIndicator), streamed
// text content, then either a pulse (waiting for first delta) or an
// in-flight tool caption.
export function AiMessage({ message, inFlightTool, onRetry }: Props) {
  const theme = useApprovalTheme('dark');
  const showPulse =
    message.isStreaming && !message.content && !inFlightTool;

  return (
    <Animated.View entering={FadeIn.duration(240)} style={{ marginTop: spacing[5] }}>
      {message.toolEvents
        .filter((t) => t.state === 'completed')
        .map((t) => {
          // Errors always render as the audit indicator (DENIED / FAILED),
          // never as a block — failure shouldn't masquerade as data.
          if (t.isError) {
            return (
              <ToolIndicator
                key={t.toolUseId}
                toolName={t.toolName}
                state="completed"
                isError
                output={t.output}
              />
            );
          }
          const block = renderBlockForOutput(t.output);
          if (block) {
            return <Fragment key={t.toolUseId}>{block}</Fragment>;
          }
          return (
            <ToolIndicator key={t.toolUseId} toolName={t.toolName} state="completed" />
          );
        })}

      {message.content ? (
        <View style={{ paddingHorizontal: spacing[6] }}>
          <MarkdownBody content={message.content} />
        </View>
      ) : null}

      {showPulse ? (
        <View style={{ paddingHorizontal: spacing[6] }}>
          <StreamingPulse />
        </View>
      ) : null}

      {message.isStreaming && inFlightTool ? (
        <ToolIndicator toolName={inFlightTool.toolName} state="started" />
      ) : null}

      {message.failed ? (
        <Pressable
          onPress={onRetry}
          style={{
            paddingHorizontal: spacing[6],
            paddingTop: spacing[2],
            paddingBottom: spacing[2],
            minHeight: 44,
            justifyContent: 'center',
          }}
          hitSlop={8}
        >
          <Text style={[type.bodyMd, { color: theme.deny }]}>Stopped. Tap to retry.</Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}
