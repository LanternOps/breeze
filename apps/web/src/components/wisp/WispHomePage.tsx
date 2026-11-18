import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { FeatureLock } from '@/components/shared/FeatureLock';
import { useJwtClaims } from '@/lib/authScope';
import { useWispServerState } from '@/lib/wispVisibility';
import WispHomeContent from './WispHomeContent';

/** The full-page Breeze AI chat (multi-tab; was /workspace, then /wisp/chat — both redirect here, W05 #10136). */
export const WISP_CHAT_PATH = '/ai/chat';

/**
 * `/wisp` (W08 #9921, spec §17.2). The Wisp home only where Wisp can run:
 * the server flag on (`wispEnabled` on /orgs/partners/me) and a
 * partner-scoped token (grants are partner-staff only, W02
 * `requireScope('partner')`). Nothing is decided until both answers are in.
 *
 * W05 of #10131 (#10136, spec §7, Review Focus 1): when the server answers
 * that Wisp is off, the page shows the lock the sidebar entry shows ("Wisp
 * runs on Breeze Cloud…", no upgrade link — no plan unlocks it here) instead
 * of forwarding to the chat, so nobody lands on a page called Wisp that is
 * plain chat. A non-partner token never asks (the hook reads `off` for it
 * without a server answer); it goes to the Breeze AI chat as before, carrying
 * the fragment.
 */
export default function WispHomePage() {
  const { t } = useTranslation(['ai', 'pages']);
  const claims = useJwtClaims();
  const scope = claims.status === 'resolved' ? claims.claims.scope : null;
  const partnerToken = scope === 'partner';
  // Only a partner token can have a Wisp home: nobody else asks the partner route.
  const server = useWispServerState({ enabled: partnerToken });
  const decided = server !== 'loading' && claims.status === 'resolved';
  const forwardToChat = decided && !partnerToken;

  useEffect(() => {
    if (forwardToChat) window.location.replace(`${WISP_CHAT_PATH}${window.location.hash}`);
  }, [forwardToChat]);

  // No usable answer is not "Wisp is off": say so instead of showing a lock that may be wrong.
  if (decided && server === 'error') {
    return (
      <div className="space-y-2 p-6 text-sm" data-testid="wisp-home-gate-error">
        <p className="text-destructive">{t('wisp.home.loadFailed')}</p>
        <button type="button" onClick={() => window.location.reload()} className="rounded border px-3 py-1 hover:bg-muted">
          {t('wisp.thread.retry')}
        </button>
      </div>
    );
  }

  if (decided && partnerToken && server === 'off') {
    return (
      <div className="mx-auto max-w-7xl space-y-4 p-4">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles className="h-5 w-5 text-primary" aria-hidden="true" />
          {t('pages:titles.wisp')}
        </h1>
        <FeatureLock locked why={t('wisp.locked.server')} upgradeHref={null} testId="wisp-home-server-lock">
          <section className="mx-auto max-w-xl space-y-3 rounded-lg border bg-card p-6 text-center">
            <Sparkles className="mx-auto h-8 w-8 text-primary" aria-hidden="true" />
            <h2 className="text-base font-semibold">{t('wisp.home.startTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('wisp.home.startBody')}</p>
          </section>
        </FeatureLock>
      </div>
    );
  }

  if (!decided || server !== 'on' || !partnerToken) {
    return <div className="p-6 text-sm text-muted-foreground" data-testid="wisp-home-loading" aria-busy="true" />;
  }
  return <WispHomeContent />;
}
