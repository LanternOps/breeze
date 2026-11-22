import { useCallback, useEffect, useRef, useState } from 'react';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { usePermissions } from '@/lib/permissions';
import { getDeviceBilling, type DeviceBillingCoverage } from '../../lib/api/devices';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

export type DeviceBillingError = { code?: string; groupName?: string };

/**
 * "Who pays for this box?" for one device (DeviceBillingCard, in the Details
 * tab's Asset record). `allowed` false or `hidden` true means the
 * caller renders nothing. Callers must test `error` before `data.uncovered`
 * so a coverage failure never reads as "not billed".
 */
export function useDeviceBilling(deviceId: string) {
  const { can } = usePermissions();
  // The gate is checked BEFORE the component fetches, so a tech
  // without billing access sees no card and issues no request — rather than a
  // request that 403s and an error state for a permission they never had.
  const allowed = can('contracts', 'read');

  const [data, setData] = useState<DeviceBillingCoverage | null>(null);
  const [error, setError] = useState<DeviceBillingError | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const requestGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    setHidden(false);
    try {
      const res = await getDeviceBilling(deviceId);
      if (generation !== requestGeneration.current) return;
      if (res.status === 401 || res.status === 403) {
        setHidden(true);
        setData(null);
        if (res.status === 401) UNAUTHORIZED();
        return;
      }
      const body = await res.json().catch(() => null) as { data?: DeviceBillingCoverage; code?: string; details?: { groupName?: string } } | null;
      if (generation !== requestGeneration.current) return;
      if (!res.ok || !body?.data) {
        setError({ code: body?.code, groupName: body?.details?.groupName });
        setData(null);
        return;
      }
      setData(body.data);
    } catch {
      if (generation !== requestGeneration.current) return;
      setError({});
      setData(null);
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    if (allowed) void load();
    return () => { requestGeneration.current += 1; };
  }, [allowed, load]);

  return { allowed, data, error, loading, hidden, reload: load };
}
