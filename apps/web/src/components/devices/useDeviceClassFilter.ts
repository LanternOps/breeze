// Device-class segment state for the Devices page (#1424, #5874).
//
// Deliberately NOT useHashState: that hook re-resolves on every hashchange,
// and this page's own modals overwrite the whole hash (`#add-network-asset`,
// `#import-definitions`) and clear it on close. With a default that is no
// longer 'all', re-resolving on those writes would silently flip the segment
// to the remembered/default choice behind the user's back. So:
//   - on mount: hash deep link → remembered choice → Agent;
//   - on hashchange: adopt only a hash that NAMES a segment (back/forward,
//     an in-app deep link); a hash that doesn't name one leaves it alone.
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  DEFAULT_DEVICE_CLASS,
  readDeviceClassFromHash,
  resolveDeviceClass,
  saveDeviceClassPreference,
  writeDeviceClassToHash,
  type DeviceClassFilter,
} from './deviceClassFilter';

// SSR-safe: the hash never reaches the server, so adopt it post-mount but
// pre-paint (same pattern as lib/useHashState.ts).
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useDeviceClassFilter(): [DeviceClassFilter, (next: DeviceClassFilter) => void] {
  const [value, setValue] = useState<DeviceClassFilter>(DEFAULT_DEVICE_CLASS);

  useIsomorphicLayoutEffect(() => {
    setValue(resolveDeviceClass(window.location.hash));
    const onHashChange = () => {
      const named = readDeviceClassFromHash(window.location.hash);
      if (named) setValue(named);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // A user's click is the only thing that records the preference — a deep
  // link never overwrites it.
  const choose = useCallback((next: DeviceClassFilter) => {
    setValue(next);
    writeDeviceClassToHash(next);
    saveDeviceClassPreference(next);
  }, []);

  return [value, choose];
}
