import type { AiPageContext } from '@breeze/shared';

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
