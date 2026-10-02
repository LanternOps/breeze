export interface OaiMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | OaiContentPart[] | null; tool_calls?: OaiToolCall[]; tool_call_id?: string }
export type OaiContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface OaiToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface OaiTool { type: 'function'; function: { name: string; description?: string; parameters: Record<string, unknown> } }
export interface OaiChatRequest {
  model: string; messages: OaiMessage[]; max_tokens?: number; temperature?: number; top_p?: number; stop?: string[];
  tools?: OaiTool[]; tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  stream: boolean; stream_options?: { include_usage: true };
}
/**
 * Maps OpenAI-legal function names back to the Anthropic tool names the caller
 * sent, and keeps each offered tool's input_schema (keyed by the caller's tool
 * name) so model-produced arguments can be checked before any tool block is
 * emitted.
 */
export interface ToolNameMap {
  toOai: ReadonlyMap<string, string>;
  fromOai: ReadonlyMap<string, string>;
  schemas: ReadonlyMap<string, Record<string, unknown>>;
}

export interface OaiChatChoice {
  index: number;
  message?: { role: 'assistant'; content: string | null; tool_calls?: OaiToolCall[]; reasoning_content?: string | null };
  delta?: { role?: 'assistant'; content?: string | null; tool_calls?: Array<{ index: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }>; reasoning_content?: string | null };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null;
}
export interface OaiUsage { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
export interface OaiChatResponse { id?: string; model?: string; choices: OaiChatChoice[]; usage?: OaiUsage | null }
