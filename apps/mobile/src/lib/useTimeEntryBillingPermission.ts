import { useEffect, useState } from 'react';
import { useAppSelector } from '../store';
import { getTimeEntryBillingPermission } from '../services/timeEntryBillingPermission';

/** UX gate only. The API rechecks the grant on every billing mutation. */
export function useTimeEntryBillingPermission(): boolean {
  const token = useAppSelector(state => state.auth.token);
  const [grant, setGrant] = useState<{ token: string; allowed: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    if (token) {
      void getTimeEntryBillingPermission().then(
        allowed => { if (active) setGrant({ token, allowed }); },
        () => { if (active) setGrant({ token, allowed: false }); },
      );
    }
    return () => { active = false; };
  }, [token]);
  return token !== null && grant?.token === token && grant.allowed;
}
