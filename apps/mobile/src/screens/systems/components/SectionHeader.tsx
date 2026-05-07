import { Text, View } from 'react-native';

import { useApprovalTheme, spacing, type } from '../../../theme';

interface Props {
  label: string;
}

export function SectionHeader({ label }: Props) {
  const theme = useApprovalTheme('dark');
  return (
    <View
      style={{
        paddingHorizontal: spacing[6],
        paddingTop: spacing[6],
        paddingBottom: spacing[2],
      }}
    >
      <Text style={[type.metaCaps, { color: theme.textLo }]}>{label}</Text>
    </View>
  );
}
