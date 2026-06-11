import { Text, View } from 'react-native';
import { riskTier, type RiskTier, useApprovalTheme, type, spacing, radii } from '../../../theme';

interface Props {
  tier: RiskTier;
  summary: string;
}

const TIER_COPY: Record<RiskTier, string> = {
  low: 'Low impact',
  medium: 'Medium impact',
  high: 'High impact',
  critical: 'Critical',
};

export function RiskBand({ tier, summary }: Props) {
  const _theme = useApprovalTheme('dark');
  const colors = riskTier[tier];
  return (
    <View
      style={{
        marginHorizontal: spacing[6],
        marginTop: spacing[6],
        padding: spacing[4],
        borderRadius: radii.md,
        backgroundColor: colors.band,
      }}
    >
      <Text style={[type.metaCaps, { color: colors.text }]}>{TIER_COPY[tier]}</Text>
      <Text style={[type.body, { color: colors.text, marginTop: spacing[1] }]}>{summary}</Text>
    </View>
  );
}
