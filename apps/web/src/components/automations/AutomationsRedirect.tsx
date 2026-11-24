import { useEffect, useRef } from 'react';
import { useFlowsGate } from '../../stores/featuresStore';
import { waitForPendingRefresh } from '../../stores/auth';

// A refresh stuck behind a throttle can outlast any sensible redirect delay.
// Past this the redirect goes anyway: the next page then makes its own attempt.
const REFRESH_WAIT_CAP_MS = 3000;

/**
 * `/automations` has no page of its own: it lands on Flows when the server has
 * them on, else on Jobs. The gate comes from `/config` on the client (no Astro
 * page reads FLOWS_ENABLED at render), so this is a client-side replace, never
 * a cacheable server redirect. Nothing navigates until the gate has loaded.
 *
 * This navigates without a click, so it first waits out any in-flight token
 * refresh (the session manager starts one on mount). Every refresh rotates the
 * cookie; a document navigation that cuts one off after the server processed it
 * can leave the old cookie behind (#9476). The wait is capped and a failed
 * refresh does not block the redirect.
 */
export default function AutomationsRedirect() {
  const { enabled, loaded } = useFlowsGate();
  const navigated = useRef(false);

  useEffect(() => {
    if (!loaded || navigated.current) return;
    navigated.current = true;
    let cancelled = false;
    const target = enabled ? '/flows' : '/jobs';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REFRESH_WAIT_CAP_MS);
    });
    void Promise.race([waitForPendingRefresh().catch(() => undefined), capped]).then(() => {
      clearTimeout(timer);
      if (!cancelled) window.location.replace(target);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      navigated.current = false;
    };
  }, [enabled, loaded]);

  return null;
}
