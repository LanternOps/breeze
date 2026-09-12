import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';

import { useApprovalTheme, radii, spacing, type } from '../../../theme';
import { haptic } from '../../../lib/motion';
import { reportInternalError } from '../../../lib/errorReporting';
import { FleetBar } from '../../../components/FleetBar';
import { getMobileSummary, type MobileSummary } from '../../../services/systems';
import { getFleetFindingCounts } from '../../../services/api';
import type { MainTabParamList } from '../../../navigation/MainNavigator';
import { deriveStripFleetSegments, formatFleetStripCopy } from './homeFleetStripCopy';

/**
 * Compact online/offline/issues strip shown above the cold-open chips on a
 * new conversation (#5141, decision 3 of #5117). Reuses the same two fetches
 * the Systems tab hero is built from — `/mobile/summary` and
 * `/fleet/findings/counts` — so both surfaces count issues the same way
 * (#5364); no new endpoint. The parent (HomeScreen) only mounts this while
 * the conversation is empty, so it disappears the instant the first message
 * lands; no visibility prop needed here.
 *
 * Fails soft: a skeleton covers the fetch, and a summary rejection hides the
 * strip entirely rather than showing a red banner above the composer — Home
 * is not the place to surface a Systems-tab data error. A findings rejection
 * does NOT hide it: findings are additive, so the strip degrades to the
 * alerts-only count it showed before #5364 rather than vanishing. Silent to
 * the user is not silent to us: either rejection is reported to Sentry even
 * when the strip has already unmounted.
 */
export function HomeFleetStrip() {
  const theme = useApprovalTheme('dark');
  const navigation = useNavigation<BottomTabNavigationProp<MainTabParamList>>();
  const [summary, setSummary] = useState<MobileSummary | null>(null);
  const [findingsCount, setFindingsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // allSettled, not Promise.all: the two fetches fail independently and
    // only the summary is load-bearing. Mirrors useSystemsData.ts, which
    // sums the same two terms for the Systems hero (#5364).
    Promise.allSettled([getMobileSummary(), getFleetFindingCounts()]).then(
      ([summaryResult, findingsResult]) => {
        // Only the state writes are gated on `cancelled` — the reporting
        // below is not. The strip unmounts the instant the first message
        // lands, which is an ordinary and fast user action, so gating Sentry
        // on it would mean a real outage on either endpoint produces zero
        // signal for every user who types before the fetches settle.
        if (!cancelled) {
          if (findingsResult.status === 'fulfilled') {
            setFindingsCount(findingsResult.value.total);
          }
          if (summaryResult.status === 'fulfilled') {
            setSummary(summaryResult.value);
          } else {
            setFailed(true);
          }
          // Settled before any reporting below, which can itself throw: a
          // Sentry hiccup must not strand the strip on its skeleton forever.
          setLoading(false);
        }

        if (findingsResult.status === 'rejected') {
          // Findings are additive, so losing them costs accuracy, not the
          // strip: it falls back to alerts-only and keeps rendering.
          // `/fleet/findings/counts` 404s against an older API, which must
          // stay a silent degrade (#5177) — the breadcrumb is for us, not
          // for the user.
          try {
            reportInternalError(findingsResult.reason, 'home-fleet-strip-findings');
          } catch {
            // Best-effort telemetry for the non-fatal path. Swallowed so it
            // cannot cancel the summary report below, which is the more
            // important of the two when both endpoints fail together — that
            // one explains why the strip vanished. Same reason
            // useSystemsData.ts guards its reporting loop.
          }
        }
        if (summaryResult.status === 'rejected') {
          // Hidden from the user by design (never a red banner on Home), but
          // still worth a Sentry breadcrumb — otherwise the strip going quiet
          // for every user (expired token, endpoint regression) has zero
          // signal anywhere. Mirrors useSystemsData.ts's handling of the same
          // getMobileSummary() call.
          reportInternalError(summaryResult.reason, 'home-fleet-strip');
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return null;

  if (loading || !summary) {
    return (
      <View style={{ paddingHorizontal: spacing[6], marginBottom: spacing[4] }}>
        <View
          style={{
            height: 54,
            borderRadius: radii.lg,
            backgroundColor: theme.bg2,
          }}
        />
      </View>
    );
  }

  return (
    <View style={{ paddingHorizontal: spacing[6], marginBottom: spacing[4] }}>
      <Pressable
        onPress={() => {
          haptic.tap();
          navigation.navigate('SystemsTab');
        }}
        style={({ pressed }) => ({
          backgroundColor: theme.bg2,
          borderRadius: radii.lg,
          padding: spacing[4],
          borderWidth: 1,
          borderColor: pressed ? theme.brand : 'transparent',
        })}
      >
        <FleetBar segments={deriveStripFleetSegments(summary)} />
        <Text style={[type.bodyMd, { color: theme.textHi, marginTop: spacing[3] }]}>
          {formatFleetStripCopy(summary, findingsCount)}
        </Text>
      </Pressable>
    </View>
  );
}
