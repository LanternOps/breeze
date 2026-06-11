import { useEffect, useState } from 'react';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

// Returns whether the device currently has a usable internet connection.
// Treats "unknown" as connected so the surface stays calm on cold start
// before NetInfo has reported. Re-subscribes once per mount.
//
// `isInternetReachable` is the truth-bearing field: NetInfo's `isConnected`
// can be true on a captive WiFi while the API is unreachable. We only flip
// to "offline" when reachability is explicitly false.
export function useNetworkConnected(): boolean {
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    const apply = (state: NetInfoState) => {
      const reachable = state.isInternetReachable;
      // null/undefined means "still probing"; trust isConnected as a soft fallback.
      if (reachable === null || reachable === undefined) {
        setConnected(state.isConnected !== false);
      } else {
        setConnected(reachable);
      }
    };
    NetInfo.fetch().then(apply).catch(() => undefined);
    const unsub = NetInfo.addEventListener(apply);
    return () => unsub();
  }, []);

  return connected;
}
