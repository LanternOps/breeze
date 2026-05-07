import { Text, View } from 'react-native';
import { useApprovalTheme, type, spacing } from '../../../theme';

interface Props {
  clientLabel: string;
  machineLabel: string | null;
  createdAt: string;
}

export function RequesterRow({ clientLabel, machineLabel, createdAt }: Props) {
  const theme = useApprovalTheme('dark');
  const time = new Date(createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  return (
    <View style={{ paddingHorizontal: spacing[6], paddingTop: spacing[4] }}>
      <Text style={[type.metaCaps, { color: theme.textLo, marginBottom: spacing[2] }]}>
        REQUESTING
      </Text>
      <Text style={[type.bodyMd, { color: theme.textHi }]}>{clientLabel}</Text>
      {machineLabel ? (
        <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>
          {machineLabel} · {time}
        </Text>
      ) : (
        <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>{time}</Text>
      )}
    </View>
  );
}
