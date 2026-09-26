import type { AiPageContext } from '@breeze/shared/types/ai';

/**
 * Server-side record of HOW an AI chat session's org was chosen (#6675).
 *
 * A chat opened from a device page anchors `ai_sessions.org_id` to that
 * device's org (#5593). Org-scoped AI writes default to that org when the
 * tool input names none — but only when the org really came from the page,
 * not from an explicit `orgId`, an explicitly bound device, or the
 * `accessibleOrgIds[0]` session fallback. `org_id` alone cannot tell those
 * apart, so `createSession` records the source in `context_snapshot`.
 *
 * The key is written by the server only: the page context is Zod-validated
 * (unknown keys are stripped) and `buildSessionContextSnapshot` drops any
 * copy of the key before deciding whether to set it.
 *
 * Only the SOURCE is stored, never an org id: the org is always read from the
 * `org_id` column, so an org move or merge that rewrites it cannot leave a
 * stale default behind in the JSON.
 *
 * Leaf module (no service imports) so `routes/ai.ts` can use it without every
 * route test that mocks `services/aiAgent` having to mock it too.
 */
export const SESSION_ORG_ANCHOR_KEY = 'orgAnchor';
export const PAGE_CONTEXT_ORG_ANCHOR = 'page_context';

export function buildSessionContextSnapshot(
  pageContext: AiPageContext | undefined,
  orgAnchoredToPage: boolean,
): Record<string, unknown> | null {
  if (!pageContext) return null;
  const { [SESSION_ORG_ANCHOR_KEY]: _clientSupplied, ...rest } = pageContext as unknown as Record<string, unknown>;
  return orgAnchoredToPage ? { ...rest, [SESSION_ORG_ANCHOR_KEY]: PAGE_CONTEXT_ORG_ANCHOR } : rest;
}

/**
 * The org a device-page chat's writes default to, or `undefined` when the
 * session has no page anchor. A device-bound session (`device_id` set) gets
 * none: its tool auth is already pinned to its org (#3087).
 */
export function pageContextWriteDefaultOrgId(session: {
  orgId: string;
  deviceId?: string | null;
  contextSnapshot?: unknown;
}): string | undefined {
  if (session.deviceId) return undefined;
  const snapshot = session.contextSnapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined;
  const record = snapshot as Record<string, unknown>;
  if (record.type !== 'device' || record[SESSION_ORG_ANCHOR_KEY] !== PAGE_CONTEXT_ORG_ANCHOR) return undefined;
  return session.orgId;
}
