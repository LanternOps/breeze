import { Text, View } from 'react-native';
import { useApprovalTheme, type, spacing } from '../../../theme';

interface Props {
  action: string;
}

export function ActionHeadline({ action }: Props) {
  const theme = useApprovalTheme('dark');
  return (
    <View style={{ paddingHorizontal: spacing[6], paddingTop: spacing[8] }}>
      <Text style={[type.display, { color: theme.textHi }]}>{action}</Text>
    </View>
  );
}
