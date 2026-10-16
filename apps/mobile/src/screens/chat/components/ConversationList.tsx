import { useCallback, useEffect, useRef, type ComponentRef } from 'react';
import { ScrollView, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { spacing } from '../../../theme';
import type { ChatMessage } from '../../../store/aiChatSlice';

import { UserMessage } from './UserMessage';
import { AiMessage } from './AiMessage';

interface Props {
  messages: ChatMessage[];
  inFlightTool: { toolUseId: string; toolName: string; input?: Record<string, unknown> } | null;
  onRetry?: (messageId: string) => void;
  onPlanDecide?: (messageId: string, approved: boolean) => Promise<string | null>;
  onPlanStop?: (messageId: string) => Promise<string | null>;
}

import { distanceFromBottom, shouldAutoFollow, STICK_THRESHOLD_PX } from './autoFollow';

// Tracks the latest assistant content length so we can re-trigger the
// auto-scroll effect during streaming without depending on the entire
// messages array.
function latestStreamSignature(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) return 'empty';
  if (last.role === 'user') return `u-${last.id}`;
  return `a-${last.id}-${last.content.length}-${last.toolEvents.length}-${last.plan?.steps.length ?? 0}`;
}

// Auto-stick-to-bottom only when the user is already near the bottom.
// If they've scrolled up mid-stream, we leave their position alone.
export function ConversationList({ messages, inFlightTool, onRetry, onPlanDecide, onPlanStop }: Props) {
  const ref = useRef<ComponentRef<typeof ScrollView>>(null);
  const stickToBottom = useRef(true);
  const signature = latestStreamSignature(messages);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    stickToBottom.current =
      distanceFromBottom({
        contentOffsetY: contentOffset.y,
        contentHeight: contentSize.height,
        layoutHeight: layoutMeasurement.height,
      }) <= STICK_THRESHOLD_PX;
  }, []);

  const lastUserId = useRef<string | null>(null);
  useEffect(() => {
    const last = messages[messages.length - 1];
    const sentNewUserMessage = last?.role === 'user' && last.id !== lastUserId.current;
    if (last?.role === 'user') lastUserId.current = last.id;
    if (!shouldAutoFollow({ sentNewUserMessage, nearBottom: stickToBottom.current })) return;
    // Following the reply from here on, until the user scrolls away again.
    stickToBottom.current = true;
    requestAnimationFrame(() => {
      ref.current?.scrollToEnd({ animated: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stream signature on purpose
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
            onPlanDecide={m.plan && onPlanDecide ? (approved) => onPlanDecide(m.id, approved) : undefined}
            onPlanStop={m.plan && onPlanStop ? () => onPlanStop(m.id) : undefined}
          />
        ),
      )}
    </ScrollView>
  );
}
