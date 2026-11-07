import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import type { IsolationListResponse } from './types';

/** Poll observed state; a refresh failure must not erase a known release control. */
export function useDeviceIsolation(deviceId: string, enabled = true) {
  const [result, setResult] = useState<{ deviceId: string; data: IsolationListResponse } | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    setError(false);
    async function load() {
      try {
        const response = await fetchWithAuth(`/devices/${deviceId}/network-isolation`);
        if (!response.ok) throw new Error('isolation_list_failed');
        const data: IsolationListResponse = await response.json();
        if (!Array.isArray(data.episodes) || typeof data.startEligibility?.allowed !== 'boolean') throw new Error('invalid_isolation_list');
        if (!cancelled) { setResult({ deviceId, data }); setError(false); }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) { setLoading(false); timer = setTimeout(() => void load(), 15_000); }
      }
    }
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [deviceId, revision, enabled]);
  return { data: result?.deviceId === deviceId ? result.data : null, error, loading, refresh };
}
