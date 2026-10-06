import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GATEWAY_MAX_TOOLS } from '../limits';
import { GatewayError } from '../types';
import { assignWireNames } from './toolNames';
import type { OaiChatRequest, OaiContentPart, OaiMessage, OaiTool, OaiToolCall, ToolNameMap } from './types';

const bad = (message: string): GatewayError => new GatewayError(400, 'invalid_request_error', 'translate_invalid', message);

const textBlock = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const imageBlock = z.object({
  type: z.literal('image'),
  source: z.union([
    z.object({ type: z.literal('base64'), media_type: z.string().regex(/^image\/(png|jpeg|gif|webp)$/), data: z.string() }),
    z.object({ type: z.literal('url'), url: z.string().url() }),
  ]),
}).passthrough();
const toolUseBlock = z.object({ type: z.literal('tool_use'), id: z.string().min(1), name: z.string().min(1), input: z.unknown() }).passthrough();
const toolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  is_error: z.boolean().optional(),
  content: z.union([z.string(), z.array(z.union([textBlock, imageBlock]))]).optional(),
}).passthrough();
const droppedBlock = z.object({ type: z.enum(['thinking', 'redacted_thinking']) }).passthrough();
const anyBlock = z.object({ type: z.string() }).passthrough();

const messageSchema = z.object({
  // 'system': the Agent SDK CLI (2.1.x) sends its environment context as a
  // system-role entry inside `messages`; it is folded into the leading system
  // message below (text only).
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([z.string(), z.array(anyBlock)]),
});
const toolSchema = z.object({
  type: z.literal('custom').optional(),
  name: z.string().min(1).max(256),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()),
}).passthrough();
const requestSchema = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive(),
  messages: z.array(messageSchema),
  system: z.union([z.string(), z.array(textBlock)]).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop_sequences: z.array(z.string()).max(16).optional(),
  tools: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  tool_choice: z.object({ type: z.enum(['auto', 'any', 'none', 'tool']), name: z.string().optional() }).passthrough().optional(),
}).passthrough();

// Wire naming (#7795, #8081) lives in ./toolNames; re-exported for existing importers.
export { OAI_TOOL_NAME, toolAlias } from './toolNames';

/**
 * Wire name for a history tool_use whose tool is not offered in THIS request.
 * Deterministic and outside the alias namespace (`h_…`, never `t_<n>`), so it
 * is in no fromOai map: a model that calls it back is refused.
 */
function historyToolName(name: string): string {
  return `h_${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;
}

function toolResultText(block: z.infer<typeof toolResultBlock>): string {
  const body = typeof block.content === 'string'
    ? block.content
    : (block.content ?? []).map((b) => (b.type === 'text' ? b.text : '[image omitted]')).join('\n');
  return block.is_error ? `Error: ${body}` : body;
}

function userParts(blocks: Array<z.infer<typeof anyBlock>>): { tools: OaiMessage[]; parts: OaiContentPart[] } {
  const tools: OaiMessage[] = [];
  const parts: OaiContentPart[] = [];
  for (const raw of blocks) {
    if (droppedBlock.safeParse(raw).success) continue;
    const tr = toolResultBlock.safeParse(raw);
    if (tr.success) { tools.push({ role: 'tool', tool_call_id: tr.data.tool_use_id, content: toolResultText(tr.data) }); continue; }
    const t = textBlock.safeParse(raw);
    if (t.success) { parts.push({ type: 'text', text: t.data.text }); continue; }
    const img = imageBlock.safeParse(raw);
    if (img.success) {
      const src = img.data.source;
      parts.push({ type: 'image_url', image_url: { url: src.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : src.url } });
      continue;
    }
    throw bad(`Content block type "${String(raw.type)}" is not supported on an OpenAI-compatible connection.`);
  }
  return { tools, parts };
}

function collapse(parts: OaiContentPart[]): string | OaiContentPart[] {
  return parts.every((p) => p.type === 'text') ? parts.map((p) => (p as { text: string }).text).join('\n') : parts;
}

export interface TranslatedRequest { body: OaiChatRequest; tools: ToolNameMap; requestedModel: string; stream: boolean }

export function translateMessagesRequest(input: unknown, wireModel: string): TranslatedRequest {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw bad('Malformed Messages API request.');
  const req = parsed.data;

  const toOai = new Map<string, string>();
  const fromOai = new Map<string, string>();
  const schemas = new Map<string, Record<string, unknown>>();
  let tools: OaiTool[] | undefined;
  if (req.tools && req.tools.length > 0) {
    if (req.tools.length > GATEWAY_MAX_TOOLS) throw bad('Too many tools for one request.');
    const offered = req.tools.map((raw) => {
      const t = toolSchema.safeParse(raw);
      if (!t.success) throw bad(`Tool "${String(raw.name)}" is not supported on an OpenAI-compatible connection (server tools are not supported).`);
      return t.data;
    });
    // Bare name when unique and wire-safe, else the indexed alias; never `mcp…` (#7795, #8081).
    const wireNames = assignWireNames(offered.map((t) => t.name));
    tools = offered.map((t, index) => {
      if (toOai.has(t.name)) throw bad(`Duplicate tool name "${t.name}".`);
      const name = wireNames[index]!;
      toOai.set(t.name, name);
      fromOai.set(name, t.name);
      schemas.set(t.name, t.input_schema);
      return { type: 'function', function: { name, ...(t.description ? { description: t.description } : {}), parameters: t.input_schema } };
    });
  }

  const messages: OaiMessage[] = [];
  // One leading system message: the top-level system plus any system-role
  // entries, in order. Many OpenAI-compatible chat templates accept a system
  // message only in first position.
  const systemText: string[] = [];
  if (req.system !== undefined) {
    const sys = typeof req.system === 'string' ? req.system : req.system.map((b) => b.text).join('\n\n');
    if (sys.length > 0) systemText.push(sys);
  }
  for (const m of req.messages) {
    if (m.role !== 'system') continue;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    for (const raw of blocks) {
      const t = textBlock.safeParse(raw);
      if (!t.success) throw bad(`Content block type "${String(raw.type)}" is not supported in a system message.`);
      if (t.data.text.length > 0) systemText.push(t.data.text);
    }
  }
  if (systemText.length > 0) messages.push({ role: 'system', content: systemText.join('\n\n') });
  for (const m of req.messages) {
    if (m.role === 'system') continue;
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'user') {
      const { tools: toolMsgs, parts } = userParts(m.content);
      messages.push(...toolMsgs);
      if (parts.length > 0) messages.push({ role: 'user', content: collapse(parts) });
      continue;
    }
    const text: string[] = [];
    const calls: OaiToolCall[] = [];
    for (const raw of m.content) {
      if (droppedBlock.safeParse(raw).success) continue;
      const t = textBlock.safeParse(raw);
      if (t.success) { text.push(t.data.text); continue; }
      const tu = toolUseBlock.safeParse(raw);
      if (tu.success) {
        calls.push({ id: tu.data.id, type: 'function', function: { name: toOai.get(tu.data.name) ?? historyToolName(tu.data.name), arguments: JSON.stringify(tu.data.input ?? {}) } });
        continue;
      }
      throw bad(`Content block type "${String(raw.type)}" is not supported on an OpenAI-compatible connection.`);
    }
    messages.push({ role: 'assistant', content: text.length > 0 ? text.join('\n') : null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
  }

  let tool_choice: OaiChatRequest['tool_choice'];
  if (req.tool_choice && tools) {
    const c = req.tool_choice;
    if (c.type === 'tool') {
      const forced = toOai.get(c.name ?? '');
      if (!forced) throw bad('tool_choice names a tool that is not offered in this request.');
      tool_choice = { type: 'function', function: { name: forced } };
    } else {
      tool_choice = c.type === 'auto' ? 'auto' : c.type === 'any' ? 'required' : 'none';
    }
  }

  const stream = req.stream === true;
  const body: OaiChatRequest = {
    model: wireModel,
    messages,
    max_tokens: req.max_tokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.stop_sequences ? { stop: req.stop_sequences } : {}),
    ...(tools ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    stream,
    ...(stream ? { stream_options: { include_usage: true as const } } : {}),
  };
  return { body, tools: { toOai, fromOai, schemas }, requestedModel: req.model, stream };
}
