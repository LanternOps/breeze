import { useEffect } from 'react';

// Past this the redirect goes to Jobs, which carries the Flows tab when Flows are on.
const CONFIG_TIMEOUT_MS = 3000;

/** The public config endpoint, built the way the other pre-sign-in reads build it (lib/loginContext.ts). */
function configUrl(): string {
  const apiHost = (import.meta.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  return `${apiHost}/api/v1/config`;
}

/**
 * `/automations` has no page of its own: it lands on Flows when the server has
 * them on, else on Jobs. No Astro page reads FLOWS_ENABLED at render, so the
 * flag comes from `GET /api/v1/config` on the client and this is a client-side
 * replace, never a cacheable server redirect.
 *
 * This page navigates without a click, so it must start no token refresh: a
 * navigation that cuts off a refresh in flight can leave the old refresh cookie
 * behind and sign the person out (#9476). That is why the page has its own
 * layout without the session manager, and why this island reads the public
 * config with a plain fetch instead of the features store. It must not import
 * `stores/auth`, `stores/featuresStore` or anything built on them
 * (AutomationsRedirect.imports.test.ts).
 *
 * `credentials: 'same-origin'`: on a same-origin install the browser still
 * sends cookies an access proxy in front of the app may need; on a split-origin
 * install it sends none, and a plain GET with no custom headers needs no CORS
 * preflight. The endpoint needs no session in either shape.
 *
 * Flows on → /flows. Flows off, a failed or malformed answer, or no answer
 * within the cap → /jobs. Exactly one navigation.
 */
export default function AutomationsRedirect() {
  useEffect(() => {
    let done = false;
    const controller = new AbortController();
    const go = (target: '/flows' | '/jobs') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      controller.abort();
      window.location.replace(target);
    };
    const timer = setTimeout(() => {
      console.warn(`[automations] /config did not answer within ${CONFIG_TIMEOUT_MS} ms; opening Jobs`);
      go('/jobs');
    }, CONFIG_TIMEOUT_MS);

    void (async () => {
      try {
        const res = await fetch(configUrl(), {
          method: 'GET',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!res.ok) {
          console.warn('[automations] /config answered', res.status, '; opening Jobs');
          go('/jobs');
          return;
        }
        const body = (await res.json()) as { features?: { flows?: unknown } } | null;
        // Only an exact boolean true opens Flows, as in the features store.
        go(body?.features?.flows === true ? '/flows' : '/jobs');
      } catch (err) {
        if (done) return; // aborted by the cap or by unmount
        console.warn('[automations] /config read failed; opening Jobs', err);
        go('/jobs');
      }
    })();

    return () => {
      done = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return null;
}
