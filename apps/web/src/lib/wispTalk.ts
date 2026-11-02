import type { WispState } from '@/stores/aiStore';
import type { WispEntityKind } from '@breeze/shared';
import { registerLogoutHook } from '@/stores/logoutHooks';

export type WispTalkTarget = { kind: WispEntityKind; id: string; orgId: string | null; label: string };

// Astro page loads reset this cache. All header buttons for an org share the
// full grant, so opening chat uses the same thread the affordance looked up.
const targetCache = new Map<string, Promise<NonNullable<WispState> | null>>();

export function resetWispTalkTargetCache(): void {
  targetCache.clear();
}

export function activeThreadFor(orgId: string | null): Promise<NonNullable<WispState> | null> {
  const key = orgId ?? '';
  let pending = targetCache.get(key);
  if (!pending) {
    pending = (async () => {
      const { fetchWispThread, isNoActiveGrant } = await import('./wispGrant');
      for (const scope of orgId ? [null, orgId] : [null]) {
        try {
          const state = await fetchWispThread(scope);
          if (state.status === 'active') return state;
        } catch (err) {
          if (!isNoActiveGrant(err)) throw err;
        }
      }
      return null;
    })();
    // A network or malformed response is no answer, never a permanent miss.
    pending.catch(() => {
      if (targetCache.get(key) === pending) targetCache.delete(key);
    });
    targetCache.set(key, pending);
  }
  return pending;
}

// Sign-out can happen without a page reload; never retain another user's grant.
registerLogoutHook(resetWispTalkTargetCache);
