import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';
export function useAutopayEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => { let live = true;
    void fetchWithAuth('/partner/billing/payment-settings').then(async response => {
      const data = response.ok ? await response.json() : null;
      if (live) setEnabled(data?.autopayEnabled === true);
    }).catch(() => { if (live) setEnabled(false); });
    return () => { live = false; };
  }, []);
  return enabled;
}
