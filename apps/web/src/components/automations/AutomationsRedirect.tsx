import { useEffect, useRef } from 'react';
import { useFlowsGate } from '../../stores/featuresStore';

/**
 * `/automations` has no page of its own: it lands on Flows when the server has
 * them on, else on Jobs. The gate comes from `/config` on the client (no Astro
 * page reads FLOWS_ENABLED at render), so this is a client-side replace, never
 * a cacheable server redirect. Nothing navigates until the gate has loaded.
 */
export default function AutomationsRedirect() {
  const { enabled, loaded } = useFlowsGate();
  const navigated = useRef(false);

  useEffect(() => {
    if (!loaded || navigated.current) return;
    navigated.current = true;
    window.location.replace(enabled ? '/flows' : '/jobs');
  }, [enabled, loaded]);

  return null;
}
