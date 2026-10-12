import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';

import { palette, radii, spacing, type } from '../../theme';
import { track } from '../../lib/analytics';
import { reportInternalError } from '../../lib/errorReporting';
import { useToast } from '../../components/toast/ToastHost';
import type { CachedSite, Fix } from '../../services/arrivalMatch';
import { getLocationSites, invalidateLocationSites } from '../../services/locationSites';
import { pinSiteLocation } from '../../services/siteLocationApi';

import {
  PIN_SUCCESS_TOAST,
  pinButtonLabel,
  pinFailureMessage,
  pinPreflight,
  pinTargets,
} from './sitePinLogic';

const MAX_BUTTONS = 5;

/**
 * "Save my current location as <site>". Shown only to a user who may set site
 * locations, for an org that still has unpinned sites. The tap is an explicit
 * user action, so — unlike the arrival prompt — it may ask for the OS
 * permission if it has never been asked.
 */
export function SitePinButton({ orgId }: { orgId: string | null }): React.JSX.Element | null {
  const { show: showToast } = useToast();
  const [targets, setTargets] = useState<CachedSite[]>([]);
  const [busySiteId, setBusySiteId] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const snapshot = await getLocationSites({ nowMs: Date.now() });
    if (mounted.current) setTargets(pinTargets(snapshot, orgId));
  }, [orgId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const onPin = useCallback(
    async (site: CachedSite) => {
      if (busySiteId !== null) return;
      setBusySiteId(site.id);
      try {
        let perm = await Location.getForegroundPermissionsAsync();
        if (perm.status === 'undetermined') perm = await Location.requestForegroundPermissionsAsync();
        if (perm.status !== 'granted') {
          showToast({
            kind: 'error',
            text: perm.canAskAgain
              ? 'Location is off for Breeze.'
              : 'Location is off for Breeze. Turn it on in Settings.',
          });
          if (!perm.canAskAgain) void Linking.openSettings();
          return;
        }

        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        const fix: Fix = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyM: pos.coords.accuracy ?? null,
          atMs: Date.now(),
        };
        const preflight = pinPreflight(fix);
        if (!preflight.ok) {
          showToast({ kind: 'error', text: preflight.message });
          return;
        }

        try {
          await pinSiteLocation(site.id, fix);
        } catch (error) {
          const failure = pinFailureMessage(error);
          if (failure.invalidate) {
            await invalidateLocationSites();
            if (mounted.current) setTargets([]);
          }
          showToast({ kind: 'error', text: failure.message });
          return;
        }

        await invalidateLocationSites();
        track('site_pinned');
        showToast({ kind: 'success', text: PIN_SUCCESS_TOAST });
        if (mounted.current) await load();
      } catch (error) {
        reportInternalError(error, 'sitePin');
        showToast({ kind: 'error', text: "Couldn't read your location. Try again." });
      } finally {
        if (mounted.current) setBusySiteId(null);
      }
    },
    [busySiteId, load, showToast]
  );

  if (targets.length === 0) return null;

  return (
    <View style={styles.wrap}>
      {targets.slice(0, MAX_BUTTONS).map((site) => (
        <Pressable
          key={site.id}
          style={[styles.button, busySiteId !== null && styles.disabled]}
          disabled={busySiteId !== null}
          onPress={() => void onPin(site)}
          accessibilityRole="button"
        >
          <Text style={styles.text}>
            {busySiteId === site.id ? 'Saving…' : pinButtonLabel(site)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing['2'], marginVertical: spacing['2'] },
  button: {
    borderWidth: 1,
    borderColor: palette.dark.border,
    borderRadius: radii.full,
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['2'],
    alignSelf: 'flex-start',
  },
  text: { ...type.meta, color: palette.dark.textMd },
  disabled: { opacity: 0.5 },
});
