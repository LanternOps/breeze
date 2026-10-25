import { useEffect } from 'react';
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
  const server = useWispServerState();
  const claims = useJwtClaims();
  const scope = claims.status === 'resolved' ? claims.claims.scope : null;
  const decided = server !== 'loading' && claims.status === 'resolved';
  const homeAvailable = server === 'on' && scope === 'partner';

  useEffect(() => {
    if (decided && !homeAvailable) window.location.replace(`${WISP_CHAT_PATH}${window.location.hash}`);
  }, [decided, homeAvailable]);

  if (!decided || !homeAvailable) {
    return <div className="p-6 text-sm text-muted-foreground" data-testid="wisp-home-loading" aria-busy="true" />;
  }
  return <WispHomeContent />;
}
