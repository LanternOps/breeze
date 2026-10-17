import { useCallback, useEffect, useRef, type ComponentRef } from 'react';
import { ScrollView, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { spacing } from '../../../theme';
import type { ChatMessage } from '../../../store/aiChatSlice';
import { turnIsLive } from '../turnState';

import { UserMessage } from './UserMessage';
import { AiMessage } from './AiMessage';
import { detectSentUserMessage, distanceFromBottom, isNearBottom, shouldAutoFollow } from './autoFollow';

interface Props {
  messages: ChatMessage[];
  inFlightTool: { toolUseId: string; toolName: string; input?: Record<string, unknown> } | null;
  onRetry?: (messageId: string) => void;
  onPlanDecide?: (messageId: string, approved: boolean) => Promise<string | null>;
  onPlanStop?: (messageId: string) => Promise<string | null>;
}

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

  // Only user-driven scrolls may change `stickToBottom`: the animated
  // scrollToEnd below emits onScroll events too, and mid-animation they sit far
  // from the bottom, which would switch following off during the very scroll
  // that is meant to start it (#8889).
  const userScrolling = useRef(false);

  const syncStick = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    stickToBottom.current = isNearBottom(
      distanceFromBottom({
        contentOffsetY: contentOffset.y,
        contentHeight: contentSize.height,
        layoutHeight: layoutMeasurement.height,
      }),
    );
  }, []);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (userScrolling.current) syncStick(e);
    },
    [syncStick],
  );

  const lastUserId = useRef<string | null>(null);
  useEffect(() => {
    const { sent: sentNewUserMessage, userId } = detectSentUserMessage(messages, lastUserId.current);
    lastUserId.current = userId;
    if (!userId) stickToBottom.current = true;
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
      onScrollBeginDrag={() => {
        userScrolling.current = true;
      }}
      onScrollEndDrag={(e) => {
        syncStick(e);
        if (e.nativeEvent.velocity?.y === 0) userScrolling.current = false;
      }}
      onMomentumScrollEnd={(e) => {
        syncStick(e);
        userScrolling.current = false;
      }}
      scrollEventThrottle={64}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      {messages.map((m, i) =>
        m.role === 'user' ? (
          <UserMessage key={m.id} content={m.content} />
        ) : (
          <AiMessage
            key={m.id}
            message={m}
            turnLive={turnIsLive(messages, i)}
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
