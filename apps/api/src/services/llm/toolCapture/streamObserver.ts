export interface ApiCallUsage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

export interface StreamObservation {
  ttftMs: number | null;
  apiCalls: ApiCallUsage[];
  toolUses: Array<{ name: string; input: Record<string, unknown> }>;
  toolSearchUses: number;
  toolSearchResultBlocks: number;
  toolReferenceNames: string[];
  stderrToolSearchLines: string[];
  sessionId: string | null;
  result: {
    subtype: string;
    numTurns: number | null;
    durationMs: number | null;
    totalCostUsd: number | null;
  } | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Fold complete SDK messages; partial events contribute timing only. */
export function createStreamObserver(startedAtMs = Date.now()): {
  onMessage(message: unknown): void;
  onStderr(chunk: string): void;
  finish(): StreamObservation;
} {
  const observation: StreamObservation = {
    ttftMs: null,
    apiCalls: [],
    toolUses: [],
    toolSearchUses: 0,
    toolSearchResultBlocks: 0,
    toolReferenceNames: [],
    stderrToolSearchLines: [],
    sessionId: null,
    result: null,
  };
  let stderrRemainder = '';

  function walkContent(content: unknown, assistant: boolean): void {
    if (Array.isArray(content)) {
      for (const block of content) walkContent(block, assistant);
      return;
    }
    const block = asRecord(content);
    if (!block) return;
    if (assistant && block.type === 'tool_use' && typeof block.name === 'string') {
      if (block.name === 'ToolSearch') observation.toolSearchUses++;
      else observation.toolUses.push({ name: block.name, input: asRecord(block.input) ?? {} });
    }
    if (block.type === 'tool_search_tool_result' || block.type === 'server_tool_use') {
      observation.toolSearchResultBlocks++;
    }
    if (block.type === 'tool_reference' && typeof block.tool_name === 'string') {
      observation.toolReferenceNames.push(block.tool_name);
    }
    walkContent(block.content, assistant);
  }

  function recordStderrLine(line: string): void {
    if (/ToolSearch/.test(line)) observation.stderrToolSearchLines.push(line);
  }

  return {
    onMessage(message) {
      const envelope = asRecord(message);
      if (!envelope) return;
      switch (envelope.type) {
        case 'stream_event': {
          if (observation.ttftMs !== null) break;
          const sdkTtft = asNumber(envelope.ttft_ms);
          if (sdkTtft !== null) observation.ttftMs = sdkTtft;
          else if (asRecord(envelope.event)?.type === 'content_block_delta') {
            observation.ttftMs = Date.now() - startedAtMs;
          }
          break;
        }
        case 'assistant': {
          const body = asRecord(envelope.message);
          const usage = asRecord(body?.usage);
          observation.apiCalls.push({
            inputTokens: asNumber(usage?.input_tokens) ?? 0,
            cacheCreationInputTokens: asNumber(usage?.cache_creation_input_tokens) ?? 0,
            cacheReadInputTokens: asNumber(usage?.cache_read_input_tokens) ?? 0,
            outputTokens: asNumber(usage?.output_tokens) ?? 0,
          });
          walkContent(body?.content, true);
          break;
        }
        case 'user':
          walkContent(asRecord(envelope.message)?.content, false);
          break;
        case 'result':
          observation.sessionId = typeof envelope.session_id === 'string' ? envelope.session_id : null;
          observation.result = {
            subtype: typeof envelope.subtype === 'string' ? envelope.subtype : '',
            numTurns: asNumber(envelope.num_turns),
            durationMs: asNumber(envelope.duration_ms),
            totalCostUsd: asNumber(envelope.total_cost_usd),
          };
          break;
      }
    },
    onStderr(chunk) {
      const lines = (stderrRemainder + chunk).split('\n');
      stderrRemainder = lines.pop() ?? '';
      for (const line of lines) recordStderrLine(line.replace(/\r$/, ''));
    },
    finish() {
      if (stderrRemainder) {
        recordStderrLine(stderrRemainder.replace(/\r$/, ''));
        stderrRemainder = '';
      }
      return observation;
    },
  };
}
