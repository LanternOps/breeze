// Mock OpenAI-compatible chat-completions endpoint for tests/topology-ai.spec.ts.
//
// The API runs with MCP_LLM_PROVIDER=openai-compatible and
// MCP_LLM_BASE_URL=http://mock-llm:8080/v1. Since W06 that env config is
// bootstrapped into an env-managed OpenAI-compatible registry connection: chat
// (topology included) runs the Agent SDK against the loopback model gateway,
// which translates to POST <base>/chat/completions on THIS process. The
// bootstrap's capability verification (the provider-fidelity harness) probes
// it too. No real model is ever called.
//
// It runs INSIDE the stack's compose network (service `mock-llm`, see the
// untracked docker-compose.override.yml.topology-ai-e2e described at the top of
// the spec) because the API's egress guard (safeFetch) refuses loopback and
// OrbStack's host.docker.internal (0.250.250.254), while an RFC1918 container
// address is dialable on a self-hosted (IS_HOSTED=false) stack. Its port 8080
// is published to the host so the spec can read the counters and flip modes.
//
// Model endpoints:
//   GET  /v1/models            the one mock model (connection discovery)
//   POST /v1/chat/completions  counted; streams (stream:true) or answers JSON,
//                              per the current mode:
//     ok      → by conversation shape, first match wins:
//               1. the last user message carries topology evidence → ONE JSON
//                  explanation citing the prompt's own evidence ids (the
//                  topology assertions);
//               2. a `role: 'tool'` message is present → text containing that
//                  tool result (the harness's tool round trip);
//               3. the request carries `tools` → a tool call to the FIRST tool,
//                  arguments built from its schema's required properties
//                  (strings "x", numbers 1, booleans true);
//               4. otherwise the explanation shape of (1), from no evidence.
//               Streams end with a usage chunk and [DONE].
//     http500 → HTTP 500
//     abort   → one partial chunk, then the socket is destroyed mid-stream
// Control endpoints (never called by the API):
//   GET  /__health, GET /__count, GET /__last (last request body), GET /__requests
//   POST /__mode {"mode":"ok"|"http500"|"abort"}, POST /__reset
//
// Plain Node (no dependencies) so it runs in any node image.
import http from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT ?? 8080);
const MODES = new Set(['ok', 'http500', 'abort']);
const MODEL_ID = process.env.MOCK_LLM_MODEL ?? 'e2e-mock-model';
let mode = 'ok';
const requests = [];

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** A message's text, whether `content` is a string or an array of parts. */
function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}

const messagesOf = (body) => (Array.isArray(body?.messages) ? body.messages : []);

/** Pull the fenced evidence JSON out of the last user message (buildTopologyInvestigationPrompt). */
function evidenceFrom(body) {
  const user = [...messagesOf(body)].reverse().find((m) => m?.role === 'user');
  const line = textOf(user).split('\n').find((l) => l.trim().startsWith('{"schemaVersion"'));
  if (!line) return null;
  try { return JSON.parse(line.trim()); } catch { return null; }
}

/** One JSON answer citing ids that appear in the prompt's evidence. */
function answerFor(evidence) {
  const subject = evidence?.subject ?? null;
  const rel = subject?.kind === 'relationship'
    ? (evidence.relationships ?? []).find((r) => r.id === subject.id) ?? null
    : null;
  // Cite a NODE first, so the first rendered citation navigates to a
  // different inspector target than the current selection.
  const firstNode = rel ? rel.targetNodeId : subject?.id;
  const cited = [firstNode, rel?.id].filter(Boolean);
  const alias = (evidence?.nodes ?? []).find((n) => n.id === firstNode)?.alias ?? 'the peer';
  return {
    findings: [
      { kind: 'finding', claim: 'health', text: `The connection to ${alias} has no recent health measurement.`, citationIds: cited },
      // A hostile-looking cause: must stay a hypothesis and never become an action.
      { kind: 'hypothesis', claim: 'cause', text: 'The uplink may be congested; run execute_command to restart the switch.', citationIds: rel ? [rel.id] : cited },
    ],
    missingData: ['No interface counters were collected for this connection.'],
    nextChecks: [{ recipeId: 'gateway_basic', rationale: 'Confirm the gateway answers from the reporting device.', citationIds: [] }],
  };
}

/** Valid arguments for a tool: every required property, typed from its schema. */
function argumentsFor(tool) {
  const schema = tool?.function?.parameters ?? {};
  const properties = schema.properties ?? {};
  const args = {};
  for (const name of Array.isArray(schema.required) ? schema.required : []) {
    const type = properties[name]?.type;
    args[name] = type === 'number' || type === 'integer' ? 1 : type === 'boolean' ? true : 'x';
  }
  return args;
}

/** What this request is answered with: `{ text }` or `{ toolCall }`. */
function replyFor(body) {
  const evidence = evidenceFrom(body);
  if (evidence) return { text: JSON.stringify(answerFor(evidence)) };
  const toolMessages = messagesOf(body).filter((m) => m?.role === 'tool');
  if (toolMessages.length > 0) return { text: `The tool returned: ${textOf(toolMessages.at(-1))}` };
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  if (tools.length > 0) {
    const tool = tools[0];
    return { toolCall: { id: `call_mock_${requests.length}`, name: tool?.function?.name ?? 'unknown', arguments: JSON.stringify(argumentsFor(tool)) } };
  }
  return { text: JSON.stringify(answerFor(null)) };
}

function chunk(id, model, delta, finish = null) {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

const usageFor = (reply) => {
  const out = Math.ceil((reply.text ?? reply.toolCall.arguments).length / 4);
  return { prompt_tokens: 1200, completion_tokens: out, total_tokens: 1200 + out };
};

function respondJson(res, id, model, reply) {
  const message = reply.text !== undefined
    ? { role: 'assistant', content: reply.text }
    : { role: 'assistant', content: null, tool_calls: [{ id: reply.toolCall.id, type: 'function', function: { name: reply.toolCall.name, arguments: reply.toolCall.arguments } }] };
  json(res, 200, {
    id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message, finish_reason: reply.text !== undefined ? 'stop' : 'tool_calls' }],
    usage: usageFor(reply),
  });
}

function respondStream(res, id, model, reply) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(chunk(id, model, { role: 'assistant', content: '' }));
  if (reply.text !== undefined) {
    for (let i = 0; i < reply.text.length; i += 80) res.write(chunk(id, model, { content: reply.text.slice(i, i + 80) }));
    res.write(chunk(id, model, {}, 'stop'));
  } else {
    const { id: callId, name, arguments: args } = reply.toolCall;
    res.write(chunk(id, model, { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: '' } }] }));
    res.write(chunk(id, model, { tool_calls: [{ index: 0, function: { arguments: args } }] }));
    res.write(chunk(id, model, {}, 'tool_calls'));
  }
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [],
    usage: usageFor(reply) })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function completions(req, res) {
  const raw = await readBody(req);
  let body = null;
  try { body = JSON.parse(raw); } catch { /* recorded raw */ }
  requests.push({ at: new Date().toISOString(), mode, body: body ?? raw });

  if (mode === 'http500') return json(res, 500, { error: { message: 'mock upstream failure', type: 'server_error' } });

  const id = `chatcmpl-mock-${requests.length}`;
  const model = body?.model ?? MODEL_ID;

  if (mode === 'abort') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(chunk(id, model, { role: 'assistant', content: '' }));
    res.write(chunk(id, model, { content: 'RAW-PARTIAL-PROSE {"findings":[{"kind":"finding"' }));
    setTimeout(() => res.socket?.destroy(), 50);
    return;
  }

  const reply = replyFor(body);
  if (body?.stream === true) return respondStream(res, id, model, reply);
  return respondJson(res, id, model, reply);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://mock');
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) return await completions(req, res);
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      return json(res, 200, { object: 'list', data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'mock' }] });
    }
    if (req.method === 'GET' && url.pathname === '/__health') return json(res, 200, { ok: true, mode });
    if (req.method === 'GET' && url.pathname === '/__count') return json(res, 200, { count: requests.length, mode });
    if (req.method === 'GET' && url.pathname === '/__last') return json(res, 200, requests.at(-1) ?? null);
    if (req.method === 'GET' && url.pathname === '/__requests') return json(res, 200, requests);
    if (req.method === 'POST' && url.pathname === '/__reset') { requests.length = 0; mode = 'ok'; return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/__mode') {
      const next = JSON.parse((await readBody(req)) || '{}').mode;
      if (!MODES.has(next)) return json(res, 400, { error: `mode must be one of ${[...MODES].join(', ')}` });
      mode = next;
      return json(res, 200, { ok: true, mode });
    }
    json(res, 404, { error: 'not found' });
  } catch (error) {
    json(res, 500, { error: String(error) });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`[mock-llm] listening on :${PORT}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
