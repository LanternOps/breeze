// `/workspace#session=<uuid>` (#9427 W3, spec §3.6 / D6).
//
// The parser is the only gate between a URL anyone can craft and a request:
// it accepts exactly one canonical UUID and nothing else, so a malformed or
// hostile fragment never reaches openSession (Review Focus 5).
import type { showToast } from '../shared/Toast';
import type { OpenSessionResult } from '@/stores/workspaceStore';

const SESSION_HASH = /^session=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** `raw` is the hash without its leading `#` (what useHashState passes). */
export function parseSessionHash(raw: string): string | undefined {
  const match = SESSION_HASH.exec(raw);
  return match ? match[1]!.toLowerCase() : undefined;
}

/**
 * Point the fragment at `sessionId` (or clear it) without a history entry and
 * without a `hashchange`. Astro's ClientRouter keeps its own data in
 * `history.state`, so the existing state is passed through untouched (see
 * components/shared/HashLink.tsx).
 */
export function writeSessionHash(sessionId: string | null): void {
  const { pathname, search, hash } = window.location;
  const next = sessionId ? `#session=${sessionId}` : '';
  if (hash === next || (!next && hash === '#')) return;
  window.history.replaceState(window.history.state, '', `${pathname}${search}${next}`);
}

type ToastInput = Parameters<typeof showToast>[0];

/**
 * The toast for an open result (the deep link, and any picker that opens a session), or
 * null when the open needs none. "Not found" and a failed read read the same,
 * so a session the user cannot reach is indistinguishable from a missing one.
 */
export function toastForOpenResult(
  result: OpenSessionResult | 'aborted',
  opts: { t: (key: string) => string; onOpenInPanel?: () => void },
): ToastInput | null {
  const { t, onOpenInPanel } = opts;
  switch (result) {
    case 'opened':
    case 'focused':
    case 'aborted':
      return null;
    case 'tab_cap':
      return { type: 'warning', message: t('ai:aiConversationMove.closeTabToOpen') };
    case 'not_found':
    case 'error':
      return { type: 'error', message: t('ai:aiConversationMove.notAvailable') };
    case 'closed':
      return { type: 'warning', message: t('ai:aiConversationMove.wasClosed') };
    case 'topology':
      return {
        type: 'warning',
        message: t('ai:aiConversationMove.topologyFromMap'),
        ...(onOpenInPanel ? { action: { label: t('ai:aiConversationMove.openInPanel'), onClick: onOpenInPanel } } : {}),
      };
  }
}
