import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Sparkles } from 'lucide-react';
import type { WispEntityKind } from '@breeze/shared';
import { useEntitlement } from '@/hooks/useEntitlement';
import { useJwtClaims } from '@/lib/authScope';
import { useWispEnabled } from '@/lib/wispVisibility';
import { wispStateFromThread } from '@/lib/wispGrant';
import { addWispLink, listWispLinks } from '@/lib/wispLinksApi';
import { ActionError } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import { useAiStore } from '@/stores/aiStore';
import { fetchWithAuth } from '@/stores/auth';
import { linkKey } from './wispEntitySources';

/**
 * The caller's active Wisp thread an item on this page can be linked to:
 * the partner-wide grant first, then a grant scoped to the item's own org.
 * One lookup per org per page load (Astro pages are full loads), shared by
 * every button on the page. null = no active grant (the button stays hidden).
 */
const targetCache = new Map<string, Promise<string | null>>();

/** Test hook; a page load starts with an empty cache. */
export function resetWispLinkTargetCache(): void {
  targetCache.clear();
}

async function readActiveThread(query: string): Promise<string | null> {
  const res = await fetchWithAuth(`/wisp/thread${query}`, { skipOrgIdInjection: true });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`wisp thread read failed: ${res.status}`);
  const state = wispStateFromThread(await res.json().catch(() => null));
  return state?.status === 'active' ? state.threadId : null;
}

function activeThreadFor(orgId: string | null): Promise<string | null> {
  const key = orgId ?? '';
  let pending = targetCache.get(key);
  if (!pending) {
    pending = (async () => (await readActiveThread('')) ?? (orgId ? await readActiveThread(`?orgId=${encodeURIComponent(orgId)}`) : null))();
    // A failed lookup must not stick for the rest of the page: drop it so the next mount retries.
    pending.catch(() => targetCache.delete(key));
    targetCache.set(key, pending);
  }
  return pending;
}

type View = { kind: 'hidden' } | { kind: 'ready'; threadId: string; linked: boolean };

/**
 * "Link to Wisp" on an object's detail header (W08 Task 10, spec §17.2). Shown
 * only where a link can succeed: server flag on, partner-scoped token, the
 * `wisp` entitlement, and an active grant (the docked Wisp session's, else a
 * thread lookup). The server re-checks everything — org from the entity,
 * ceiling, permission — and refuses with a toast; this only hides the button
 * where the answer is already known to be no.
 */
export default function WispLinkButton({ kind, id, orgId }: { kind: WispEntityKind; id: string; orgId: string | null }) {
  const { t } = useTranslation('ai');
  const claims = useJwtClaims();
  const serverOn = useWispEnabled();
  const entitlement = useEntitlement('wisp');
  const storeWisp = useAiStore((s) => s.wisp);
  const [view, setView] = useState<View>({ kind: 'hidden' });
  const [busy, setBusy] = useState(false);

  const eligible = serverOn
    && claims.status === 'resolved' && claims.claims.scope === 'partner'
    && entitlement.state === 'enabled';
  const storeThreadId = storeWisp?.status === 'active' ? storeWisp.threadId : null;

  useEffect(() => {
    if (!eligible) {
      setView({ kind: 'hidden' });
      return;
    }
    let live = true;
    void (async () => {
      try {
        const threadId = storeThreadId ?? (await activeThreadFor(orgId));
        if (!live) return;
        if (!threadId) {
          setView({ kind: 'hidden' });
          return;
        }
        setView({ kind: 'ready', threadId, linked: false });
        const links = await listWispLinks(threadId);
        if (live && links.some((l) => linkKey(l.ref.kind, l.ref.id) === linkKey(kind, id))) {
          setView({ kind: 'ready', threadId, linked: true });
        }
      } catch (err) {
        // The button is an affordance; the object page must not break over it.
        console.error('[WispLinkButton] looking up the Wisp thread failed', err);
      }
    })();
    return () => { live = false; };
  }, [eligible, storeThreadId, orgId, kind, id]);

  if (view.kind === 'hidden') return null;

  const link = async () => {
    if (busy || view.linked) return;
    setBusy(true);
    try {
      await addWispLink(view.threadId, { kind, id, orgId });
      setView({ ...view, linked: true });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('wisp.links.addFailed') }); // ActionError already toasted
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      data-testid="wisp-link-button"
      disabled={busy || view.linked}
      onClick={() => void link()}
      className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition hover:bg-muted disabled:cursor-default disabled:opacity-70"
    >
      {view.linked ? <Check className="h-4 w-4 text-success" aria-hidden="true" /> : <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />}
      {view.linked ? t('wisp.linkButton.linked') : busy ? t('wisp.linkButton.linking') : t('wisp.linkButton.link')}
    </button>
  );
}
