/**
 * #11817: what the pinned `permissionMode` (`dontAsk`) lets through, measured
 * on the bundled Agent SDK CLI, not read off the docs.
 *
 * The CLI talks to a local stub that speaks just enough of the Messages API to
 * script the model's side of the turn: it asks for a tool, then ends the turn
 * once the tool result comes back. No request leaves the host, no real key is
 * used. This suite spawns the CLI binary; it FAILS (does not skip) if the
 * binary cannot start. Re-run it on every Agent SDK bump.
 *
 * - Tool search on (web chat): `ToolSearch` is enabled through `tools` and is
 *   NOT in `allowedTools`. It must still run — a denied ToolSearch would leave
 *   every deferred Breeze tool unloadable.
 * - Tool search off (every other surface, agent runs): an allow-listed MCP
 *   tool runs.
 * - Control: an MCP tool that is registered but not allow-listed is denied, so
 *   a denial is visible to this suite and the two cases above are not vacuous.
 */
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeResolvedModel } from '../aiModels/__fixtures__/resolvedModel';
import { SDK_TOOL_SEARCH_BUILTIN } from '../aiToolSearchPolicy';
import { SDK_CHILD_HOST_CONTEXT_GUARDS, SDK_PERMISSION_MODE } from './sdkChildEnvGuards';

const MCP_SERVER = 'breeze';
const MCP_TOOL = `mcp__${MCP_SERVER}__get_weather`;
const MODEL = makeResolvedModel('platform').wireModel;

interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; is_error?: boolean; content?: unknown }
interface StubRequest {
  tools: Array<{ name: string; defer_loading?: boolean }>;
  toolResults: ToolResultBlock[];
}

/** Main-loop requests only (they carry our MCP tool); side requests are answered and dropped. */
const requests: StubRequest[] = [];
let firstToolCall: { name: string; input: Record<string, unknown> } = { name: MCP_TOOL, input: { city: 'Oslo' } };

function sse(res: ServerResponse, content: Array<Record<string, unknown>>, stopReason: 'tool_use' | 'end_turn'): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const events: Array<[string, unknown]> = [['message_start', {
    type: 'message_start',
    message: {
      id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: MODEL, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
    },
  }]];
  content.forEach((block, index) => {
    if (block.type === 'tool_use') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { ...block, input: {} } }]);
      events.push(['content_block_delta', {
        type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      }]);
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function toolResultsOf(body: { messages?: Array<{ role?: string; content?: unknown }> }): ToolResultBlock[] {
  return (body.messages ?? [])
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => (m.content as Array<{ type?: string }>).filter((b): b is ToolResultBlock => b.type === 'tool_result'));
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const url = req.url ?? '';
    if (req.method !== 'POST' || !url.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"not_found_error","message":"permission-mode stub"}}');
      return;
    }
    if (url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":1}');
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      tools?: Array<{ name: string; defer_loading?: boolean }>;
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    const tools = body.tools ?? [];
    if (!tools.some((t) => t.name === MCP_TOOL || t.name === SDK_TOOL_SEARCH_BUILTIN)) {
      sse(res, [{ type: 'text', text: 'OK' }], 'end_turn');
      return;
    }
    const toolResults = toolResultsOf(body);
    requests.push({ tools: tools.map((t) => ({ name: t.name, defer_loading: t.defer_loading })), toolResults });
    // Script: first tool call → (after ToolSearch) the MCP tool → end the turn.
    const answered = new Set(toolResults.map((r) => r.tool_use_id));
    if (!answered.has('toolu_first')) {
      sse(res, [{ type: 'tool_use', id: 'toolu_first', ...firstToolCall }], 'tool_use');
    } else if (firstToolCall.name === SDK_TOOL_SEARCH_BUILTIN && !answered.has('toolu_mcp')) {
      sse(res, [{ type: 'tool_use', id: 'toolu_mcp', name: MCP_TOOL, input: { city: 'Oslo' } }], 'tool_use');
    } else {
      sse(res, [{ type: 'text', text: 'done' }], 'end_turn');
    }
  });
}

let server: Server;
let baseUrl = '';
let tmp = '';
let handlerRuns = 0;

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sdk-permission-mode-'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
  handlerRuns = 0;
});

type RunResult = { subtype?: string; permission_denials?: Array<{ tool_name: string }> };

async function run(opts: { toolSearch: boolean; allowedTools: string[] }) {
  const weather = tool('get_weather', 'Current weather for a city', { city: z.string() }, async ({ city }) => {
    handlerRuns += 1;
    return { content: [{ type: 'text', text: `sunny 21C in ${city}` }] };
  });
  const stderr: string[] = [];
  let result: RunResult | null = null;
  let initMode: unknown;
  for await (const m of query({
    prompt: 'What is the weather in Oslo? Use the tool.',
    options: {
      model: MODEL,
      maxTurns: 6,
      tools: opts.toolSearch ? [SDK_TOOL_SEARCH_BUILTIN] : [],
      allowedTools: opts.allowedTools,
      mcpServers: { [MCP_SERVER]: createSdkMcpServer({ name: MCP_SERVER, version: '1.0.0', tools: [weather] }) },
      cwd: tmp,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: tmp,
        CI: 'true',
        ...SDK_CHILD_HOST_CONTEXT_GUARDS,
        ENABLE_TOOL_SEARCH: opts.toolSearch ? 'true' : 'false',
        CLAUDE_CONFIG_DIR: path.join(tmp, 'config'),
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: 'e2e-not-a-real-key',
      },
      persistSession: false,
      settingSources: [],
      permissionMode: SDK_PERMISSION_MODE,
      stderr: (d: string) => { stderr.push(d); },
    },
  })) {
    const msg = m as { type?: string; subtype?: string; permissionMode?: unknown };
    if (msg.type === 'system' && msg.subtype === 'init') initMode = msg.permissionMode;
    if (msg.type === 'result') result = m as RunResult;
  }
  expect(result, `no result; CLI stderr:\n${stderr.join('').slice(-4000)}`).not.toBeNull();
  // The CLI reports the mode it actually started in.
  expect(initMode).toBe(SDK_PERMISSION_MODE);
  return { result: result!, denied: (result!.permission_denials ?? []).map((d) => d.tool_name) };
}

const resultFor = (id: string) => requests.flatMap((r) => r.toolResults).find((r) => r.tool_use_id === id);

describe(`Agent SDK permissionMode '${SDK_PERMISSION_MODE}' on the real CLI (#11817)`, () => {
  it('runs ToolSearch (enabled via tools, not allow-listed) and the tool it loads', async () => {
    firstToolCall = { name: SDK_TOOL_SEARCH_BUILTIN, input: { query: `select:${MCP_TOOL}`, max_results: 5 } };
    const { denied } = await run({ toolSearch: true, allowedTools: [MCP_TOOL] });

    // Tool search was really active: ToolSearch advertised, and the MCP tool
    // never sent loaded — absent until ToolSearch references it, deferred after.
    expect(requests[0]!.tools.map((t) => t.name)).toContain(SDK_TOOL_SEARCH_BUILTIN);
    const mcpAdvertised = requests.flatMap((r) => r.tools).filter((t) => t.name === MCP_TOOL);
    expect(mcpAdvertised.length).toBeGreaterThan(0);
    expect(mcpAdvertised.every((t) => t.defer_loading === true), JSON.stringify(requests)).toBe(true);

    const search = resultFor('toolu_first');
    expect(search, JSON.stringify(requests)).toBeDefined();
    expect(search!.is_error, JSON.stringify(search)).not.toBe(true);
    expect(JSON.stringify(search!.content)).toContain('tool_reference');
    expect(denied).toEqual([]);
    expect(resultFor('toolu_mcp')?.is_error).not.toBe(true);
    expect(handlerRuns).toBe(1);
  }, 120_000);

  it('runs an allow-listed MCP tool with tool search off', async () => {
    firstToolCall = { name: MCP_TOOL, input: { city: 'Oslo' } };
    const { denied } = await run({ toolSearch: false, allowedTools: [MCP_TOOL] });

    expect(requests[0]!.tools.map((t) => t.name)).not.toContain(SDK_TOOL_SEARCH_BUILTIN);
    expect(denied).toEqual([]);
    expect(resultFor('toolu_first')?.is_error).not.toBe(true);
    expect(handlerRuns).toBe(1);
  }, 120_000);

  it('control: denies an MCP tool that is not allow-listed, without running it', async () => {
    firstToolCall = { name: MCP_TOOL, input: { city: 'Oslo' } };
    const { denied } = await run({ toolSearch: false, allowedTools: [] });

    expect(denied).toEqual([MCP_TOOL]);
    expect(resultFor('toolu_first')?.is_error).toBe(true);
    expect(handlerRuns).toBe(0);
  }, 120_000);
});
