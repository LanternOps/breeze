import { Text, View } from 'react-native';
import { useApprovalTheme, type, spacing, radii } from '../../../theme';

interface Props {
  tenant: string;
}

/**
 * Prominent "Customer tenant" line for M365 mutation approvals. Rendered above
 * the risk band so the technician sees WHICH customer org the action targets —
 * the blast radius — before approving from a push notification.
 *
 * Only mounted when the server supplies a non-null customerTenant; non-M365
 * approvals never render this.
 */
export function CustomerTenantBadge({ tenant }: Props) {
  const theme = useApprovalTheme('dark');
  return (
    <View
      style={{
        marginHorizontal: spacing[6],
        marginTop: spacing[6],
        padding: spacing[4],
        borderRadius: radii.md,
        backgroundColor: theme.bg2,
        borderLeftWidth: 3,
        borderLeftColor: theme.brand,
      }}
    >
      <Text style={[type.metaCaps, { color: theme.textMd }]}>Customer tenant</Text>
      <Text style={[type.title, { color: theme.textHi, marginTop: spacing[1] }]}>{tenant}</Text>
    </View>
  );
}
