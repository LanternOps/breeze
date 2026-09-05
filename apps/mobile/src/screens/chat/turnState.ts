import type { ChatMessage } from '../../store/aiChatSlice';

/**
 * Whether the server-persisted transcript describes a FINISHED assistant turn.
 *
 * Used when the live SSE stream is gone (the app was suspended, or iOS killed
 * the XHR while an approval was being decided) and the phone has to catch up
 * from `GET /ai/sessions/:id` instead. The server writes assistant text and
 * tool rows as they happen, so a mid-turn fetch legitimately returns a partial
 * transcript: a trailing user row with no reply yet, or a tool_use row whose
 * tool_result has not landed. Both mean "keep polling".
 */
export function isTurnComplete(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return false;
  if (last.toolEvents.some((t) => t.state === 'started')) return false;
  return last.content.length > 0 || last.toolEvents.length > 0;
}

/** The tool still running in a partial transcript, for the RUNNING caption. */
export function inFlightToolOf(
  messages: ChatMessage[],
): { toolUseId: string; toolName: string } | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  const started = last.toolEvents.find((t) => t.state === 'started');
  return started ? { toolUseId: started.toolUseId, toolName: started.toolName } : null;
}

/**
 * The API answers 409 with this text while `settleBlockedTurnForNewMessage`
 * (apps/api/src/services/aiAgentSdk.ts) gives the previous turn up to 3s to
 * conclude. It is a transient race, not a failure — retry once, don't surface.
 */
export function isTurnSettlingError(message: string): boolean {
  return /wrapping up the previous turn/i.test(message);
}

/**
 * Transport failures where the SERVER-SIDE turn is still running and the right
 * move is to catch up from the transcript rather than mark the reply failed.
 * `Network error` is what streamChat's XHR `onerror` reports when iOS drops the
 * socket on suspend; a timeout at open means the same thing for a cold link.
 */
export function isStreamLostError(err: Error): boolean {
  return err.message === 'Network error' || err.name === 'FetchTimeoutError';
}
