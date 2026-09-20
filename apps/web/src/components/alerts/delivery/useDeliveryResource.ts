// useDeliveryResource.ts
import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
export type ChannelChoice = { id: string; name: string; type: string; enabled: boolean; inherited?: true };
export type InheritedChannelChoice = ChannelChoice & { inherited: true };
type ReadState<T> = { key: string; status: 'loading'|'error'|'success'; data: T[]; inherited: InheritedChannelChoice[] };
export function useDeliveryResource<T>(url: string) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ReadState<T>>({ key: '', status: 'loading', data: [], inherited: [] });
  const reload = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    let active = true;
    setState({ key: url, status: 'loading', data: [], inherited: [] });
    void fetchWithAuth(url).then(async response => {
      if (response.status === 401) { void navigateTo('/login', { replace: true }); throw new Error('unauthorized'); }
      if (!response.ok) throw new Error('read failed');
      const body = await response.json();
      if (!Array.isArray(body.data)) throw new Error('invalid rail response');
      if (active) setState({ key: url, status: 'success', data: body.data, inherited: body.inherited ?? [] });
    }).catch(() => { if (active) setState({ key: url, status: 'error', data: [], inherited: [] }); });
    return () => { active = false; };
  }, [url, attempt]);
  const current: ReadState<T> = state.key === url ? state : { key: url, status: 'loading', data: [], inherited: [] };
  return { ...current, reload };
}
