// Mock OpenAI-compatible chat-completions endpoint for tests/topology-ai.spec.ts.
//
// The API runs with MCP_LLM_PROVIDER=openai-compatible and
// MCP_LLM_BASE_URL=http://mock-llm:8080/v1, so the ONLY model it can reach is
// this process (apps/api/src/services/llm/openaiCompatibleProvider.ts →
// POST <base>/chat/completions, stream:true). No real model is ever called.
//
// It runs INSIDE the stack's compose network (service `mock-llm`, see the
// untracked docker-compose.override.yml.topology-ai-e2e described at the top of
// the spec) because the API's egress guard (safeFetch) refuses loopback and
// OrbStack's host.docker.internal (0.250.250.254), while an RFC1918 container
// address is dialable on a self-hosted (IS_HOSTED=false) stack. Its port 8080
// is published to the host so the spec can read the counters and flip modes.
//
// Model endpoint:
//   POST /v1/chat/completions  counted; answers per the current mode:
//     ok    → SSE chat.completion.chunk stream of ONE JSON explanation that cites
//             the prompt's own evidence ids, then a usage chunk and [DONE]
//     http500 → HTTP 500
//     abort → one partial chunk, then the socket is destroyed mid-stream
// Control endpoints (never called by the API):
//   GET  /__health, GET /__count, GET /__last (last request body), GET /__requests
//   POST /__mode {"mode":"ok"|"http500"|"abort"}, POST /__reset
//
// Plain Node (no dependencies) so it runs in any node image.
import http from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT ?? 8080);
const MODES = new Set(['ok', 'http500', 'abort']);
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

/** Pull the fenced evidence JSON out of the last user message (buildTopologyInvestigationPrompt). */
function evidenceFrom(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const user = [...messages].reverse().find((m) => m?.role === 'user');
  const content = typeof user?.content === 'string' ? user.content : '';
  const line = content.split('\n').find((l) => l.trim().startsWith('{"schemaVersion"'));
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

/** One JSON answer citing ids that appear in the prompt's evidence. */
function answerFor(body) {
  const evidence = evidenceFrom(body);
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

function chunk(id, model, delta, finish = null) {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

async function completions(req, res) {
  const raw = await readBody(req);
  let body = null;
  try { body = JSON.parse(raw); } catch { /* recorded raw */ }
  requests.push({ at: new Date().toISOString(), mode, body: body ?? raw });

  if (mode === 'http500') return json(res, 500, { error: { message: 'mock upstream failure', type: 'server_error' } });

  const id = `chatcmpl-mock-${requests.length}`;
  const model = body?.model ?? 'e2e-mock-model';
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(chunk(id, model, { role: 'assistant', content: '' }));

  if (mode === 'abort') {
    res.write(chunk(id, model, { content: 'RAW-PARTIAL-PROSE {"findings":[{"kind":"finding"' }));
    setTimeout(() => res.socket?.destroy(), 50);
    return;
  }

  const text = JSON.stringify(answerFor(body));
  for (let i = 0; i < text.length; i += 80) res.write(chunk(id, model, { content: text.slice(i, i + 80) }));
  res.write(chunk(id, model, {}, 'stop'));
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [],
    usage: { prompt_tokens: 1200, completion_tokens: Math.ceil(text.length / 4), total_tokens: 1200 + Math.ceil(text.length / 4) } })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://mock');
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) return await completions(req, res);
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
