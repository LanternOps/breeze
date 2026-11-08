import type { AiPageContext } from '@breeze/shared';
import type { WispState } from './aiStore';

/** Pages whose entity is resolved by the server to anchor a new session's org. */
export function pageContextAnchorsOrg(
  context: AiPageContext | null | undefined,
): context is Extract<AiPageContext, { type: 'device' | 'record' }> {
  if (!context) return false;
  switch (context.type) {
    case 'device':
    case 'record':
      return true;
    case 'alert':
    case 'dashboard':
    case 'custom':
    case 'topology':
      return false;
    default:
      context satisfies never;
      return false;
  }
}

/**
 * The page's own composer shows the chat's current Wisp thread (the Wisp home,
 * a thread page; `wispPageThreadId` is set while that composer is on screen),
 * so the page, not the docked pane, is that conversation.
 */
export function wispPageHoldsChat(s: { wisp: WispState; wispPageThreadId: string | null }): boolean {
  return !!s.wispPageThreadId && s.wisp?.threadId === s.wispPageThreadId;
}
