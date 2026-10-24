import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';

/**
 * Whether the server has Wisp on (`wispEnabled` on GET /orgs/partners/me).
 * For nav surfaces other than the Sidebar (which reads the same response
 * itself). Missing field, failed request, or a non-OK status all read as off.
 */
export function useWispEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    try {
      void Promise.resolve(fetchWithAuth('/orgs/partners/me'))
        .then(async (response) => {
          const data = response?.ok ? await response.json() : null;
          if (live) setEnabled(data?.wispEnabled === true);
        })
        .catch(() => {
          if (live) setEnabled(false);
        });
    } catch {
      /* stays off */
    }
    return () => {
      live = false;
    };
  }, []);
  return enabled;
}
