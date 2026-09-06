// Data layer for the network device detail page: loads the discovery asset
// (with the malformed-response guard and the return-to-tab background
// refresh), and separately loads the site-scoped device list used by the
// proxy/manual-link pickers. Returns plain data and callbacks so the page
// component stays presentation-only.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { asList } from '@/lib/asList';
import {
  mapAsset,
  type ApiDiscoveryAsset,
  type DiscoveredAsset,
} from '../../discovery/DiscoveredAssetList';
import type { DeviceOption, NetworkAssetExtras } from './types';

export function useNetworkAsset(assetId: string) {
  const { t } = useTranslation('devices');
  const [asset, setAsset] = useState<DiscoveredAsset | null>(null);
  const [extras, setExtras] = useState<NetworkAssetExtras>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Text for the page's single polite live region — the only way screen
  // reader users hear about outcomes that don't otherwise move focus or
  // change what's on screen: a type save/reset, an unlink, opening the web UI
  // in a new tab, and a background refresh landing quietly behind the
  // scenes. The toasts these outcomes already trigger are sighted-only
  // (CSS-positioned, not announced here) — this is in addition to them, not
  // a replacement.
  const [liveMessage, setLiveMessage] = useState('');
  // Clear first and set the real message on the next tick: setting the same
  // string twice in a row is a no-op state update, so React bails out of the
  // second render and the live region's DOM text never actually changes —
  // screen reader users never hear the repeat. Clearing first guarantees two
  // distinct DOM mutations even when the message is identical to the last one.
  const announce = useCallback((message: string) => {
    setLiveMessage('');
    setTimeout(() => setLiveMessage(message), 0);
  }, []);

  // `background: true` is used for the return-to-tab refresh below: it must
  // not flash the loading skeleton over content the operator is already
  // looking at, and a transient failure shouldn't blow away a working page —
  // so it skips both the loading flag and the error state entirely.
  const fetchAsset = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background ?? false;
    try {
      if (!background) {
        setLoading(true);
        setError(undefined);
      }

      const response = await fetchWithAuth(`/discovery/assets/${assetId}`);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(t('networkDeviceDetailPage.errors.notFound'));
        }
        throw new Error(t('networkDeviceDetailPage.errors.load'));
      }

      const body = await response.json();
      const raw: (ApiDiscoveryAsset & NetworkAssetExtras) | undefined =
        body?.data ?? body?.asset ?? body;
      // A 200 with an empty/wrong-shaped body would otherwise sail through
      // `mapAsset` (which never returns null) and render a blank "—" shell with
      // an `asset=undefined` deep-link. Treat a missing id as a load failure.
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
        throw new Error(t('networkDeviceDetailPage.errors.malformed'));
      }
      setAsset(mapAsset(raw));
      setExtras({
        model: raw.model ?? null,
        netbiosName: raw.netbiosName ?? null,
        siteId: raw.siteId ?? null,
        siteName: raw.siteName ?? null,
        firstSeenAt: raw.firstSeenAt ?? null,
        snmpMonitoringEnabled: raw.snmpMonitoringEnabled ?? false,
        networkMonitoringEnabled: raw.networkMonitoringEnabled ?? false,
        suggestedBridgeDeviceId: (raw as NetworkAssetExtras).suggestedBridgeDeviceId ?? null,
        autoLinkSuppressedAt: (raw as NetworkAssetExtras).autoLinkSuppressedAt ?? null,
      });
      // Only the silent return-to-tab refresh needs an announcement — the
      // initial load already has a visible loading state, and any manual
      // "Try again" click follows an error the operator was already looking at.
      if (background) {
        announce(t('networkDeviceDetailPage.live.refreshed'));
      }
    } catch (err) {
      if (!background) {
        setError(err instanceof Error ? err.message : t('networkDeviceDetailPage.errors.load'));
      } else {
        // Keep the working page as-is, but leave a trail: a 404 here means the
        // asset was removed while the tab was hidden and every later refresh
        // will fail the same way.
        console.warn('[network-device] background refresh failed', assetId, err);
      }
    } finally {
      if (!background) setLoading(false);
    }
  }, [assetId, t, announce]);

  useEffect(() => {
    void fetchAsset();
  }, [fetchAsset]);

  // Return-to-tab refresh: a technician who tabs away for a while and comes
  // back is looking at status that may be well out of date. Only refetch
  // after a real away-period (60s+), not a quick alt-tab, and never while
  // still on the initial load (no `asset` yet to refresh in place).
  useEffect(() => {
    let hiddenAt: number | null = null;
    const MIN_HIDDEN_MS = 60_000;
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      if (document.visibilityState === 'visible' && hiddenAt !== null) {
        const hiddenDuration = Date.now() - hiddenAt;
        hiddenAt = null;
        if (hiddenDuration >= MIN_HIDDEN_MS) {
          void fetchAsset({ background: true });
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [fetchAsset]);

  // Device list for the proxy "through agent" picker. Site-scoped to the
  // asset's site when known — same call shape LinkManuallyControl already
  // uses — so an operator only sees agents that can plausibly bridge to this
  // network, instead of an unscoped list across every site. Falls back to
  // the unscoped list when the asset has no site on record.
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [devicesError, setDevicesError] = useState(false);
  const assetLoaded = asset != null;
  // Guards against a slower, earlier fetchDevices call resolving AFTER a
  // later one (e.g. a manual "Retry" firing while the initial load is still
  // in flight) and clobbering the fresher result with stale data. Each call
  // captures its own sequence number and only commits state if it's still
  // the most recent call by the time its response lands.
  const fetchSeqRef = useRef(0);
  const fetchDevices = useCallback(async () => {
    // The site scope isn't known until the asset has loaded; firing early
    // would always (and silently) fall through to the unscoped branch.
    if (!assetLoaded) return;
    const seq = ++fetchSeqRef.current;
    setDevicesError(false);
    try {
      const url = extras.siteId
        ? `/devices?siteId=${encodeURIComponent(extras.siteId)}`
        : '/devices';
      const response = await fetchWithAuth(url);
      if (seq !== fetchSeqRef.current) return; // superseded by a newer call
      if (!response.ok) {
        setDevicesError(true);
        return;
      }
      const data = await response.json();
      if (seq !== fetchSeqRef.current) return;
      const raw: any[] = asList(data, 'devices');
      let list: DeviceOption[] = raw.map((d: any) => ({
        id: d.id,
        name: d.displayName || d.hostname || d.id,
        online: d.status === 'online',
      }));

      // The suggested bridge (the agent that ran the discovery scan) can
      // live outside the asset's site-scoped page of results — never
      // silently drop it, or the default bridge target from #proxy-entry
      // quietly regresses to an arbitrary agent.
      const suggestedId = extras.suggestedBridgeDeviceId;
      if (suggestedId && !list.some((d) => d.id === suggestedId)) {
        try {
          const suggestedResponse = await fetchWithAuth(`/devices/${suggestedId}`);
          if (seq !== fetchSeqRef.current) return;
          if (suggestedResponse.ok) {
            const suggestedRaw = await suggestedResponse.json();
            if (seq !== fetchSeqRef.current) return;
            if (suggestedRaw && typeof suggestedRaw.id === 'string') {
              list = [
                {
                  id: suggestedRaw.id,
                  name: suggestedRaw.displayName || suggestedRaw.hostname || suggestedRaw.id,
                  online: suggestedRaw.status === 'online',
                },
                ...list,
              ];
            }
          }
        } catch {
          // Best-effort — the suggested device just won't appear as an option.
        }
      }

      list.sort((a, b) => {
        if (a.id === suggestedId) return -1;
        if (b.id === suggestedId) return 1;
        return a.name.localeCompare(b.name);
      });

      setDevices(list);
    } catch {
      if (seq === fetchSeqRef.current) setDevicesError(true);
    }
  }, [assetLoaded, extras.siteId, extras.suggestedBridgeDeviceId]);

  useEffect(() => {
    void fetchDevices();
  }, [fetchDevices]);

  return {
    asset,
    extras,
    loading,
    error,
    liveMessage,
    announce,
    fetchAsset,
    devices,
    devicesError,
    fetchDevices,
  };
}
