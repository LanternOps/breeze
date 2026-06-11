import { useCallback, useEffect, useRef } from 'react';
import { ScrollView, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { spacing } from '../../../theme';
import type { ChatMessage } from '../../../store/aiChatSlice';

import { UserMessage } from './UserMessage';
import { AiMessage } from './AiMessage';

interface Props {
  messages: ChatMessage[];
  inFlightTool: { toolUseId: string; toolName: string } | null;
  onRetry?: (messageId: string) => void;
}

const STICK_THRESHOLD_PX = 80;

// Tracks the latest assistant content length so we can re-trigger the
// auto-scroll effect during streaming without depending on the entire
// messages array.
function latestStreamSignature(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) return 'empty';
  if (last.role === 'user') return `u-${last.id}`;
  return `a-${last.id}-${last.content.length}-${last.toolEvents.length}`;
}

// Auto-stick-to-bottom only when the user is already near the bottom.
// If they've scrolled up mid-stream, we leave their position alone.
export function ConversationList({ messages, inFlightTool, onRetry }: Props) {
  const ref = useRef<ScrollView>(null);
  const stickToBottom = useRef(true);
  const signature = latestStreamSignature(messages);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom =
      contentSize.height - (contentOffset.y + layoutMeasurement.height);
    stickToBottom.current = distanceFromBottom <= STICK_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    if (!stickToBottom.current) return;
    requestAnimationFrame(() => {
      ref.current?.scrollToEnd({ animated: true });
    });
  }, [signature]);

  return (
    <ScrollView
      ref={ref}
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingTop: spacing[4], paddingBottom: spacing[6] }}
      onScroll={onScroll}
      scrollEventThrottle={64}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      {messages.map((m) =>
        m.role === 'user' ? (
          <UserMessage key={m.id} content={m.content} />
        ) : (
          <AiMessage
            key={m.id}
            message={m}
            inFlightTool={m.isStreaming ? inFlightTool : null}
            onRetry={m.failed && onRetry ? () => onRetry(m.id) : undefined}
          />
        ),
      )}
    </ScrollView>
  );
}
