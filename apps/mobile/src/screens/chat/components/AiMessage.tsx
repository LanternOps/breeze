import { Fragment } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { useApprovalTheme, spacing, type } from '../../../theme';
import type { ChatMessage } from '../../../store/aiChatSlice';
import { renderBlockForOutput } from '../blocks';

import { describeTurnModel } from '../modelPicker';
import { isPlanTool } from '../planState';
import { MarkdownBody } from './MarkdownBody';
import { PlanCard } from './PlanCard';
import { StreamingPulse } from './StreamingPulse';
import { ToolIndicator } from './ToolIndicator';
import { toolRowStatus } from './toolIndicatorLogic';

interface Props {
  message: Extract<ChatMessage, { role: 'assistant' }>;
  inFlightTool: { toolUseId: string; toolName: string; input?: Record<string, unknown> } | null;
  onRetry?: () => void;
  onPlanDecide?: (approved: boolean) => Promise<string | null>;
  onPlanStop?: () => Promise<string | null>;
}

const noPlanAction = async () => null;

// AI messages are unboxed text-on-canvas. No bubble, no avatar bezel. The
// row contains: completed tool events (rendered as ToolIndicator), streamed
// text content, then either a pulse (waiting for first delta) or an
// in-flight tool caption.
export function AiMessage({ message, inFlightTool, onRetry, onPlanDecide, onPlanStop }: Props) {
  const theme = useApprovalTheme('dark');
  // The plan card stands in for the propose_action_plan tool row and its
  // RUNNING caption: while the server waits on the plan, the card says so.
  const toolCaption = inFlightTool && !isPlanTool(inFlightTool.toolName) ? inFlightTool : null;
  const showPulse =
    message.isStreaming && !message.content && !inFlightTool;

  return (
    <Animated.View entering={FadeIn.duration(240)} style={{ marginTop: spacing[5] }}>
      {message.toolEvents
        .filter((t) => t.state === 'completed' && !(message.plan && isPlanTool(t.toolName)))
        .map((t) => {
          const status = toolRowStatus({ isError: t.isError, output: t.output, handoff: t.handoff });
          // Anything that is not a plain completion renders as the audit
          // indicator, never as a block: a failure shouldn't masquerade as
          // data, and an approval handoff has no data yet — the worker is
          // still executing it (#5107). `output` is always forwarded so the
          // indicator can classify the row itself.
          if (status !== 'completed') {
            return (
              <ToolIndicator
                key={t.toolUseId}
                toolName={t.toolName}
                state="completed"
                isError={t.isError}
                output={t.output}
                handoff={t.handoff}
                input={t.input}
              />
            );
          }
          const block = renderBlockForOutput(t.output);
          if (block) {
            return <Fragment key={t.toolUseId}>{block}</Fragment>;
          }
          return (
            <ToolIndicator key={t.toolUseId} toolName={t.toolName} state="completed" input={t.input} />
          );
        })}

      {message.plan ? (
        <PlanCard
          plan={message.plan}
          live={message.isStreaming}
          onDecide={onPlanDecide ?? noPlanAction}
          onStop={onPlanStop ?? noPlanAction}
        />
      ) : null}

      {message.content ? (
        <View style={{ paddingHorizontal: spacing[6] }}>
          <MarkdownBody content={message.content} streaming={message.isStreaming} />
        </View>
      ) : null}

      {showPulse ? (
        <View style={{ paddingHorizontal: spacing[6] }}>
          <StreamingPulse />
        </View>
      ) : null}

      {message.isStreaming && toolCaption ? (
        <ToolIndicator toolName={toolCaption.toolName} state="started" input={toolCaption.input} />
      ) : null}

      {message.turnModel && !message.isStreaming ? (
        // W05: the model and options that ACTUALLY answered (AiTurnModelBadge on web).
        <Text
          testID="ai-turn-model"
          style={[type.meta, { color: theme.textLo, paddingHorizontal: spacing[6], paddingTop: spacing[2] }]}
        >
          {describeTurnModel(message.turnModel)}
        </Text>
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
