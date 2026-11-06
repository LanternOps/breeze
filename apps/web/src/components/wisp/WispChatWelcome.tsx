import { useEffect, useState } from 'react';
import type { WispFirstLookState } from '@breeze/shared';
import { findActiveWispGrant } from '@/lib/wispSession';
import WispWelcome from './WispWelcome';

const POLL_MS = 30_000;

/**
 * The welcome on a chat surface (side panel, /ai/chat tab; #11145). These have
 * no thread timeline and no home poll, and what they were given when Wisp mode
 * opened goes stale, so while a new conversation is on screen they ask the grant
 * themselves. `done` is final and stops the asking.
 *
 * Until something has answered there is no state (a /ai/chat tab starts with
 * none) and the intro stays off: saying "I'm looking around" without knowing
 * could be false. A failed read keeps what was already known; the lookup logs it.
 */
function useWispFirstLookState(grantId: string, orgId: string | null, initial: WispFirstLookState | undefined) {
  const [state, setState] = useState(initial);
  const done = state === 'done';

  useEffect(() => {
    if (done) return undefined;
    let stopped = false;
    const read = async () => {
      if (document.visibilityState === 'hidden') return;
      const found = await findActiveWispGrant(orgId);
      // The lookup tries the org's own grant first, which need not be this session's.
      if (stopped || found.kind !== 'grant' || found.grant.grantId !== grantId) return;
      if (found.grant.firstLookState) setState(found.grant.firstLookState);
    };
    void read();
    const timer = setInterval(() => { void read(); }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [grantId, orgId, done]);

  return state;
}

export default function WispChatWelcome({
  grantId,
  orgId,
  initialState,
  scopeLabel,
  onSuggest,
}: {
  grantId: string;
  /** The session's org, for the grant lookup; null on a partner-wide one. */
  orgId: string | null;
  initialState?: WispFirstLookState;
  scopeLabel: string;
  onSuggest: (prompt: string) => void;
}) {
  const state = useWispFirstLookState(grantId, orgId, initialState);
  return (
    <WispWelcome
      scopeLabel={scopeLabel}
      onSuggest={onSuggest}
      briefNote={false}
      intro={state !== undefined}
      firstLookState={state ?? 'looking'}
    />
  );
}
