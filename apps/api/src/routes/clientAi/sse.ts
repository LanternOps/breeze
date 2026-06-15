/**
 * AI for Office — SSE protocol for GET /client-ai/sessions/:id/events.
 *
 * Translates internal AiStreamEvents (SessionEventBus) into the PINNED
 * client-facing event names the add-in consumes (Plan 5 mirrors this table):
 *
 *   message_delta   ← content_delta          { text }
 *   tool_request    ← tool_request (bridge)  { toolUseId, toolName, input, mutating }
 *   tool_completed  ← tool_completed         { toolUseId, toolName, status, redactions, blockReason }
 *   turn_complete   ← done                   { usage: { inputTokens, outputTokens, costCents } | null }
 *   session_error   ← error                  { message }
 *   ping            ← server keepalive timer { } every CLIENT_AI_SSE_PING_INTERVAL_MS
 *
 * Everything else (message_start/message_end/tool_use_start/title_updated/
 * plan + approval events) is INTERNAL and dropped — the add-in must never see
 * technician/RMM concepts (spec §1).
 */

import type { AiStreamEvent } from '@breeze/shared/types/ai';

export const CLIENT_AI_SSE_PING_INTERVAL_MS = 25_000;

export const CLIENT_AI_SSE_EVENTS = [
  'message_delta',
  'tool_request',
  'tool_completed',
  'turn_complete',
  'session_error',
  'ping',
] as const;

export type ClientAiSseEventName = (typeof CLIENT_AI_SSE_EVENTS)[number];

export function toClientSseEvent(
  event: AiStreamEvent,
): { event: ClientAiSseEventName; data: string } | null {
  switch (event.type) {
    case 'content_delta':
      return { event: 'message_delta', data: JSON.stringify({ text: event.delta }) };
    case 'tool_request':
      return {
        event: 'tool_request',
        data: JSON.stringify({
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input,
          mutating: event.mutating,
        }),
      };
    case 'tool_completed':
      return {
        event: 'tool_completed',
        data: JSON.stringify({
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          status: event.status,
          redactions: event.redactions ?? [],
          blockReason: event.blockReason ?? null,
        }),
      };
    case 'done':
      return { event: 'turn_complete', data: JSON.stringify({ usage: event.usage ?? null }) };
    case 'error':
      return { event: 'session_error', data: JSON.stringify({ message: event.message }) };
    default:
      return null;
  }
}
