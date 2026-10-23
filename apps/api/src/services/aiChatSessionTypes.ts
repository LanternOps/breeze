/**
 * #9427: the `ai_sessions.type` values that are technician CHAT conversations —
 * the only sessions the conversation list/search returns and the only ones a
 * client may attach to (`GET /ai/sessions/:id/stream`), where every other type
 * (`script_builder`, `mcp`, helper and client-AI sessions, …) is a 404.
 * `GET /ai/sessions/:id` itself does not filter by type; the web
 * `openAiSession` applies the same rule client-side.
 *
 * A leaf module (no imports) so the attach route and aiAgent.ts share one
 * list without the route depending on the rest of aiAgent.ts.
 */
export const CHAT_SESSION_TYPES = ['general', 'topology'] as const;

export type ChatSessionType = (typeof CHAT_SESSION_TYPES)[number];

const CHAT_SESSION_TYPE_SET: ReadonlySet<unknown> = new Set(CHAT_SESSION_TYPES);

export function isChatSessionType(type: unknown): type is ChatSessionType {
  return CHAT_SESSION_TYPE_SET.has(type);
}
