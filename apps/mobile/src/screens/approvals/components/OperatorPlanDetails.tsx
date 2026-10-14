import { Text, View } from 'react-native';
import { useApprovalTheme, type, spacing, radii } from '../../../theme';
import {
  groupOperatorPlanEffects,
  OPERATOR_PLAN_PROVIDER_LABEL,
} from '../operatorPlanCopy';

interface Props {
  args: Record<string, unknown>;
}

/**
 * Full grouped, ordered effect list for an `operator_plan` approval. Never
 * truncated and never collapsed: it renders inside the approval screen's
 * ScrollView, so a phone approving nine identity effects scrolls rather than
 * summarises. Server-supplied text is rendered as plain <Text>.
 */
export function OperatorPlanDetails({ args }: Props) {
  const theme = useApprovalTheme('dark');
  const groups = groupOperatorPlanEffects(args);
  const revision = typeof args.planRevision === 'number' ? args.planRevision : null;
  const count = groups ? groups.reduce((n, g) => n + g.effects.length, 0) : 0;

  return (
    <View
      style={{
        marginHorizontal: spacing[6],
        marginTop: spacing[5],
        padding: spacing[4],
        borderRadius: radii.md,
        backgroundColor: theme.bg2,
        borderColor: theme.border,
        borderWidth: 1,
      }}
    >
      <Text style={[type.metaCaps, { color: theme.textLo }]}>PLAN</Text>
      {groups === null ? (
        <Text style={[type.meta, { color: theme.textHi, marginTop: spacing[2] }]}>
          This plan could not be displayed in full. Do not approve it.
        </Text>
      ) : groups.length === 0 ? (
        <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[2] }]}>
          This plan contains no effects.
        </Text>
      ) : (
        <>
          <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[2] }]}>
            {count} {count === 1 ? 'effect' : 'effects'}
            {revision !== null ? `, plan revision ${revision}` : ''}
          </Text>
          <Text style={[type.meta, { color: theme.textLo, marginTop: spacing[1] }]}>
            Effects run in this order. Sign-in is disabled last, so stopping early never leaves
            mail unrouted.
          </Text>
          {groups.map((group) => (
            <View key={group.provider} style={{ marginTop: spacing[4] }}>
              <Text style={[type.metaCaps, { color: theme.textLo }]}>
                {OPERATOR_PLAN_PROVIDER_LABEL[group.provider].toUpperCase()}
              </Text>
              {group.effects.map((effect) => (
                <View key={effect.ordinal} style={{ marginTop: spacing[3] }}>
                  <Text style={[type.meta, { color: theme.textMd }]}>Step {effect.ordinal + 1}</Text>
                  <Text style={[type.meta, { color: theme.textHi, marginTop: spacing[1] }]} selectable>
                    {effect.rendering}
                  </Text>
                  <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]} selectable>
                    {effect.principalLabel
                      ? `${effect.targetLabel} (${effect.principalLabel})`
                      : effect.targetLabel}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </>
      )}
    </View>
  );
}
