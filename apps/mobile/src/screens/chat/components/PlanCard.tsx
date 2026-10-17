import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { useApprovalTheme, palette, radii, spacing, type } from '../../../theme';
import { haptic } from '../../../lib/motion';
import {
  formatPlanToolName,
  planCardAction,
  planStatusCaption,
  type ChatPlan,
  type PlanStepStatus,
} from '../planState';

interface Props {
  plan: ChatPlan;
  /** The message is still streaming, so the server may be holding the plan open. */
  live: boolean;
  /** Resolves to an inline error message, or null on success / when the plan was gone. */
  onDecide: (approved: boolean) => Promise<string | null>;
  onStop: () => Promise<string | null>;
}

const STEP_MARK: Record<PlanStepStatus, string> = {
  pending: '',
  running: '…',
  completed: '✓',
  failed: '✕',
};

// Mirrors the web's AiPlanReviewCard: the whole plan up front, one approval for
// all of its steps. Tool input stays off the card (the web hides it behind an
// expander too); the model's reasoning per step is what a technician reads.
// Plan approval is in-chat only on the server (no approval_requests row, no
// push), so this card is the only place the phone can answer it.
export function PlanCard({ plan, live, onDecide, onStop }: Props) {
  const theme = useApprovalTheme('dark');
  const [busy, setBusy] = useState<'approve' | 'reject' | 'stop' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const action = planCardAction(plan, live);
  const caption = planStatusCaption(plan, live);
  const stepCount = plan.steps.length;

  async function run(kind: 'approve' | 'reject' | 'stop') {
    if (busy) return;
    if (kind === 'approve') haptic.approve();
    else if (kind === 'reject') haptic.deny();
    else haptic.tap();
    setBusy(kind);
    setError(null);
    try {
      const message = kind === 'stop' ? await onStop() : await onDecide(kind === 'approve');
      setError(message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      style={{
        marginHorizontal: spacing[6],
        marginTop: spacing[3],
        backgroundColor: theme.bg2,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: action === 'decide' ? palette.brand.base : theme.border,
        paddingHorizontal: spacing[4],
        paddingVertical: spacing[3],
      }}
      testID="chat-plan-card"
    >
      <Text style={[type.metaCaps, { color: theme.textLo }]}>
        {stepCount > 0 ? `ACTION PLAN · ${stepCount} ${stepCount === 1 ? 'STEP' : 'STEPS'}` : 'ACTION PLAN'}
      </Text>
      {plan.title ? (
        <Text style={[type.bodyMd, { color: theme.textHi, marginTop: spacing[1] }]}>{plan.title}</Text>
      ) : null}

      {plan.steps.map((step, i) => (
        <View key={i} style={{ flexDirection: 'row', marginTop: spacing[2] }}>
          <Text style={[type.monoMd, { color: theme.textLo, width: 28 }]}>{i + 1}.</Text>
          <View style={{ flex: 1 }}>
            <Text style={[type.bodyMd, { color: theme.textHi }]} numberOfLines={1}>
              {formatPlanToolName(step.toolName)}
              {STEP_MARK[step.status] ? (
                <Text style={{ color: step.status === 'failed' ? theme.deny : theme.approve }}>
                  {`  ${STEP_MARK[step.status]}`}
                </Text>
              ) : null}
            </Text>
            {step.reasoning ? (
              <Text style={[type.meta, { color: theme.textMd }]} numberOfLines={3}>
                {step.reasoning}
              </Text>
            ) : null}
          </View>
        </View>
      ))}

      <Text style={[type.meta, { color: theme.textLo, marginTop: spacing[3] }]}>{caption}</Text>

      {action === 'decide' ? (
        <View style={{ flexDirection: 'row', marginTop: spacing[3] }}>
          <PlanButton
            label="Approve plan"
            filled
            busy={busy === 'approve'}
            disabled={busy !== null}
            onPress={() => void run('approve')}
            testID="chat-plan-approve"
          />
          <View style={{ width: spacing[3] }} />
          <PlanButton
            label="Reject"
            busy={busy === 'reject'}
            disabled={busy !== null}
            onPress={() => void run('reject')}
            testID="chat-plan-reject"
          />
        </View>
      ) : null}

      {action === 'reject' ? (
        <View style={{ flexDirection: 'row', marginTop: spacing[3] }}>
          <PlanButton
            label="Reject"
            busy={busy === 'reject'}
            disabled={busy !== null}
            onPress={() => void run('reject')}
            testID="chat-plan-reject"
          />
        </View>
      ) : null}

      {action === 'stop' ? (
        <View style={{ flexDirection: 'row', marginTop: spacing[3] }}>
          <PlanButton
            label="Stop plan"
            busy={busy === 'stop'}
            disabled={busy !== null}
            onPress={() => void run('stop')}
            testID="chat-plan-stop"
          />
        </View>
      ) : null}

      {error ? (
        <Text style={[type.meta, { color: theme.deny, marginTop: spacing[2] }]}>{error}</Text>
      ) : null}
    </Animated.View>
  );
}

function PlanButton({
  label,
  filled,
  busy,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  filled?: boolean;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  const theme = useApprovalTheme('dark');
  const fg = filled ? palette.approve.onBase : theme.textHi;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 44,
        borderRadius: radii.sm,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled && !busy ? 0.5 : 1,
        backgroundColor: filled
          ? (pressed ? palette.approve.pressed : palette.approve.base)
          : (pressed ? theme.bg3 : theme.bg1),
        borderWidth: filled ? 0 : 1,
        borderColor: theme.border,
      })}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[type.bodyMd, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}
