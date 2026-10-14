import { useEffect } from 'react';
import { useFeaturesStore } from '@/stores/featuresStore';

/**
 * Runtime readiness for caller verification (#6354). False on SSR, before
 * /config loads, on a failed or older /config, and whenever the server flag
 * is off. Mount data-fetching children only when this is true.
 */
export function useCallerVerificationEnabled(): boolean {
  const enabled = useFeaturesStore((s) => s.features.callerVerification);
  const loaded = useFeaturesStore((s) => s.loaded);
  const load = useFeaturesStore((s) => s.load);
  useEffect(() => { void load(); }, [load]);
  return loaded && enabled === true;
}
