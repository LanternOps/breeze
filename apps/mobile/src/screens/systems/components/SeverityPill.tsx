import { Text, View } from 'react-native';

import { riskTier, spacing, type, radii } from '../../../theme';
import { findingSeverityTier, severityLabel, type FleetFindingSeverity } from '../findingActions';

interface Props {
  severity: FleetFindingSeverity;
}

/**
 * The severity chip on findings rows and the finding detail header (#5365).
 * Reuses the shared `riskTier` bands so a "Critical" finding reads the same
 * colour as a critical alert — a second colour scale for the same word would
 * be actively misleading on a triage screen.
 */
export function SeverityPill({ severity }: Props) {
  const tier = riskTier[findingSeverityTier(severity)];

  return (
    <View
      accessibilityRole="text"
      style={{
        paddingHorizontal: spacing[2],
        paddingVertical: 2,
        borderRadius: radii.sm,
        backgroundColor: tier.band,
      }}
    >
      <Text style={[type.meta, { color: tier.text, fontSize: 10 }]}>
        {severityLabel(severity).toUpperCase()}
      </Text>
    </View>
  );
}
