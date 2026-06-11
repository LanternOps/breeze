import { View } from 'react-native';

import { useApprovalTheme, palette } from '../theme';

export interface FleetSegments {
  healthy: number;
  warning: number;
  critical: number;
}

interface Props {
  segments: FleetSegments;
  height?: number;
}

// Three-color proportion bar. No gaps, no rounding — flat by default per
// DESIGN.md. Used in:
//   1. Home tab inline blocks (FleetStatusRow, when AI summarizes a fleet)
//   2. Systems tab hero (the canonical surface)
// Both call sites pass aggregate counts. Empty / zero-known states render
// a single Surface 3 fill so the bar always has presence.
export function FleetBar({ segments, height = 6 }: Props) {
  const theme = useApprovalTheme('dark');
  const total = segments.healthy + segments.warning + segments.critical;

  return (
    <View
      style={{
        flexDirection: 'row',
        height,
        borderRadius: 0,
        overflow: 'hidden',
      }}
    >
      {total === 0 ? (
        <View style={{ flex: 1, backgroundColor: theme.bg3 }} />
      ) : (
        <>
          {segments.healthy > 0 ? (
            <View
              style={{
                flex: segments.healthy,
                backgroundColor: palette.approve.base,
              }}
            />
          ) : null}
          {segments.warning > 0 ? (
            <View
              style={{
                flex: segments.warning,
                backgroundColor: palette.warning.base,
              }}
            />
          ) : null}
          {segments.critical > 0 ? (
            <View
              style={{
                flex: segments.critical,
                backgroundColor: palette.deny.base,
              }}
            />
          ) : null}
        </>
      )}
    </View>
  );
}
