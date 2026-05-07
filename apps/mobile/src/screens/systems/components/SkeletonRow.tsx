import { View } from 'react-native';

import { useApprovalTheme, spacing } from '../../../theme';

// Single skeleton row for the active-issues list. Surface 2 horizontal
// bars, no animation — the brief specifies skeletons over spinners and
// keeps motion calm.
export function SkeletonRow() {
  const theme = useApprovalTheme('dark');
  return (
    <View
      style={{
        paddingHorizontal: spacing[6],
        paddingVertical: spacing[3],
        flexDirection: 'row',
        alignItems: 'center',
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: theme.bg2,
          marginRight: spacing[3],
        }}
      />
      <View style={{ flex: 1 }}>
        <View
          style={{
            height: 14,
            borderRadius: 4,
            backgroundColor: theme.bg2,
            width: '76%',
          }}
        />
        <View
          style={{
            height: 10,
            borderRadius: 4,
            backgroundColor: theme.bg2,
            width: '42%',
            marginTop: spacing[2],
          }}
        />
      </View>
    </View>
  );
}
