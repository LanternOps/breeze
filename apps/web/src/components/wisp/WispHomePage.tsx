import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useJwtClaims } from '@/lib/authScope';
import { useWispServerState } from '@/lib/wispVisibility';
import WispHomeContent from './WispHomeContent';

/** Where /wisp hands over when Wisp cannot run here: the multi-tab chat (was /workspace). */
export const WISP_CHAT_PATH = '/wisp/chat';

/**
 * `/wisp` (W08 #9921, spec §17.2). The Wisp home only where Wisp can run:
 * the server flag on (`wispEnabled` on /orgs/partners/me) and a
 * partner-scoped token (grants are partner-staff only, W02
 * `requireScope('partner')`). Otherwise the page hands over to `/wisp/chat`
 * — the old /workspace page, unchanged — so with the flag off the nav entry
 * still lands on the chat it always did. The fragment is carried so an old
 * `/workspace#session=<id>` link that redirected here still opens its tab.
 * Nothing is decided until both answers are in.
 */
export default function WispHomePage() {
  const { t } = useTranslation('ai');
  const claims = useJwtClaims();
  const scope = claims.status === 'resolved' ? claims.claims.scope : null;
  // Only a partner token can have a Wisp home: nobody else asks the partner route.
  const server = useWispServerState({ enabled: scope === 'partner' });
  const decided = server !== 'loading' && claims.status === 'resolved';
  const homeAvailable = server === 'on' && scope === 'partner';

  useEffect(() => {
    if (decided && server !== 'error' && !homeAvailable) window.location.replace(`${WISP_CHAT_PATH}${window.location.hash}`);
  }, [decided, homeAvailable, server]);

  // No usable answer is not "Wisp is off": say so instead of quietly sending the user to the chat.
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

  if (!decided || !homeAvailable) {
    return <div className="p-6 text-sm text-muted-foreground" data-testid="wisp-home-loading" aria-busy="true" />;
  }
  return <WispHomeContent />;
}
