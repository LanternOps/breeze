import { getConfig } from '../config/validate';

interface HookPayload {
  event: string;
  partnerId: string;
  data: Record<string, unknown>;
}

interface HookResponse {
  status?: string;
  redirectUrl?: string;
  upgradeUrl?: string;
  message?: string;
  actionUrl?: string;
  actionLabel?: string;
}

/**
 * Dispatches a lifecycle hook to an external service via HTTP POST.
 * Returns the hook response if configured, or null if no hooks URL is set.
 *
 * Hook URL receives: POST {PARTNER_HOOKS_URL}/{event}
 * Body: { partnerId, data }
 *
 * Non-blocking on failure — hook errors never break core functionality.
 */
export async function dispatchHook(
  event: string,
  partnerId: string,
  data: Record<string, unknown> = {}
): Promise<HookResponse | null> {
  const config = getConfig();
  const baseUrl = config.PARTNER_HOOKS_URL;
  if (!baseUrl) return null;

  const url = `${baseUrl}/${event}`;
  const payload: HookPayload = { event, partnerId, data };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      console.error(`[PartnerHooks] ${event} for partner ${partnerId} returned ${res.status}: ${body}`);
      return null;
    }

    const body = await res.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      console.error(`[PartnerHooks] ${event} for partner ${partnerId} returned non-object body`);
      return null;
    }

    return body as HookResponse;
  } catch (err) {
    console.warn(`[PartnerHooks] ${event} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
