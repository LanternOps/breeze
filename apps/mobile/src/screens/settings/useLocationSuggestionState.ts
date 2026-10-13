import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { track } from '../../lib/analytics';
import {
  toLocationPermissionState,
  type LocationPermissionInput,
  type LocationPermissionState,
} from '../../services/locationPermission';
import { EXPLAINER_DISMISSED_KEY } from '../../services/arrivalMemory';
import { getLocationSites } from '../../services/locationSites';
import { getPrecisionTracker } from '../time/useArrivalPrompt';

import { EXPLAINER_COPY, explainerVisible, locationRowCopy } from './locationSettingsLogic';

async function readDismissedAt(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(EXPLAINER_DISMISSED_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Partner flag + OS permission state for the Settings row and the Time-tab
 * explainer card. Re-reads when the app returns to the foreground, because the
 * technician may have just changed the permission in system Settings.
 */
export function useLocationSuggestionState() {
  const [partnerEnabled, setPartnerEnabled] = useState(false);
  const [state, setState] = useState<LocationPermissionState>('undetermined');
  const [dismissedAtMs, setDismissedAtMs] = useState<number | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await getLocationSites({ nowMs: Date.now() });
      const [perm, servicesEnabled, dismissed] = await Promise.all([
        Location.getForegroundPermissionsAsync(),
        Location.hasServicesEnabledAsync(),
        readDismissedAt(),
      ]);
      if (!mounted.current) return;
      setPartnerEnabled(snapshot?.enabled === true);
      setState(
        toLocationPermissionState(
          perm as LocationPermissionInput,
          servicesEnabled,
          getPrecisionTracker().observedReducedPrecision()
        )
      );
      setDismissedAtMs(dismissed);
    } catch {
      // Leave the last known state; the row stays hidden if it never loaded.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => {
      mounted.current = false;
      sub.remove();
    };
  }, [refresh]);

  /** The explicit "Turn on" tap — the only place the OS dialog is requested. */
  const turnOn = useCallback(async () => {
    const result = await Location.requestForegroundPermissionsAsync();
    track('location_permission_requested', { granted: result.status === 'granted' });
    await refresh();
  }, [refresh]);

  const openSettings = useCallback(() => {
    void Linking.openSettings();
  }, []);

  const dismissExplainer = useCallback(async () => {
    const now = Date.now();
    try {
      await AsyncStorage.setItem(EXPLAINER_DISMISSED_KEY, String(now));
    } catch {
      // Not remembering only means asking again sooner.
    }
    if (mounted.current) setDismissedAtMs(now);
  }, []);

  return {
    partnerEnabled,
    state,
    row: locationRowCopy(state, partnerEnabled),
    explainerShown: explainerVisible({ partnerEnabled, state, dismissedAtMs, nowMs: Date.now() }),
    explainer: EXPLAINER_COPY,
    turnOn,
    openSettings,
    dismissExplainer,
  };
}
