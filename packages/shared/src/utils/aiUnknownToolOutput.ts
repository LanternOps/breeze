/**
 * #9855: a chat tool call to a name that is not a tool at all.
 *
 * The Agent SDK CLI answers such a call itself, before any MCP handler runs,
 * with `<tool_use_error>Error: No such tool available: <name></tool_use_error>`,
 * and the model retries with a real tool. The API's dropped-call fallback
 * (`recordDroppedToolResult` in streamingSessionManager.ts) records that
 * result with `unknownTool: true` so tool cards render a neutral note
 * instead of a red Failed card. Only that server path writes the shape, and
 * only for a call no tool handler ran, so no tool output can produce it.
 */
const UNKNOWN_TOOL_ERROR_TEXT = 'No such tool available:';

/** True for the Agent SDK CLI's own error for a nonexistent tool name. */
export function isUnknownToolErrorText(text: string): boolean {
  return text.includes(UNKNOWN_TOOL_ERROR_TEXT);
}

export interface AiUnknownToolOutput {
  error: string;
  droppedBeforeExecution: true;
  unknownTool: true;
}

export function isAiUnknownToolOutput(value: unknown): value is AiUnknownToolOutput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.unknownTool === true
    && record.droppedBeforeExecution === true
    && typeof record.error === 'string';
}
