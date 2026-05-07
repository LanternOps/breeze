import type { ChatMessage, ToolEvent } from '../../store/aiChatSlice';
import type { ServerAiMessage } from '../../services/aiChat';

// Convert server-side aiMessages rows back into the slice's ChatMessage
// shape. The server flattens role into 5 enum values (user / assistant /
// system / tool_use / tool_result); the slice models user + assistant
// (with toolEvents folded into the assistant turn). System messages skip
// the UI; tool rows attach to the most recent assistant message.
export function historyToMessages(rows: ServerAiMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];

  for (const row of rows) {
    if (row.role === 'system') continue;

    if (row.role === 'user') {
      out.push({
        id: row.id,
        role: 'user',
        content: row.content ?? '',
        sentAt: row.createdAt,
      });
      continue;
    }

    if (row.role === 'assistant') {
      out.push({
        id: row.id,
        role: 'assistant',
        content: row.content ?? '',
        toolEvents: [],
        sentAt: row.createdAt,
        isStreaming: false,
      });
      continue;
    }

    // Tool rows fold into the latest assistant message; if there isn't
    // one (rare), synthesize a placeholder so the audit trail isn't lost.
    let target = out[out.length - 1];
    if (!target || target.role !== 'assistant') {
      const placeholder: ChatMessage = {
        id: `synth-${row.id}`,
        role: 'assistant',
        content: '',
        toolEvents: [],
        sentAt: row.createdAt,
        isStreaming: false,
      };
      out.push(placeholder);
      target = placeholder;
    }

    if (row.role === 'tool_use') {
      const evt: ToolEvent = {
        toolUseId: row.toolUseId ?? row.id,
        toolName: row.toolName ?? 'tool',
        state: 'started',
      };
      target.toolEvents.push(evt);
    } else if (row.role === 'tool_result') {
      const matchId = row.toolUseId ?? '';
      const existing = target.toolEvents.find((t) => t.toolUseId === matchId);
      if (existing) {
        existing.state = 'completed';
        existing.output = row.toolOutput ?? undefined;
        // The server doesn't persist isError on the row; tool_result
        // rows in history are rendered as completed without a deny-red
        // tint. Live denials still color correctly via the SSE path.
      } else {
        target.toolEvents.push({
          toolUseId: matchId || row.id,
          toolName: row.toolName ?? 'tool',
          state: 'completed',
          output: row.toolOutput ?? undefined,
        });
      }
    }
  }

  return out;
}
