#!/usr/bin/env tsx
// apps/api/src/services/aiModels/__scripts__/sdkOptionPassthroughSpike.ts (the shebang must stay on line 1)
/**
 * AI model registry W01 spike (#7599): which per-call options does the pinned
 * Agent SDK `query()` actually put on the wire?
 *
 * Runs `query()` once per variant against a local capture server that speaks
 * just enough of the Messages API to end the turn. No request reaches
 * Anthropic, no real key is used, nothing is billed. For every request the CLI
 * sends, it records the body's `thinking`, `output_config`, `speed` and
 * `inference_geo`, plus the `anthropic-beta` header. It never records
 * auth headers or prompt text.
 *
 * Re-run after every Agent SDK bump. The findings doc
 * (docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-w01-spike-findings.md)
 * cites its output.
 *
 *   cd apps/api && npx tsx src/services/aiModels/__scripts__/sdkOptionPassthroughSpike.ts \
 *     --model <adaptive model id> --fast-model <fast-capable model id> [--out file.json]
 *
 * Model ids are arguments, not literals: index invariant 1 keeps model ids
 * out of source outside the registry seed, fixtures and aiModel.ts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { SDK_CHILD_HOST_CONTEXT_GUARDS } from '../../llm/sdkChildEnvGuards';
import { THINKING_DISPLAY_UPDATES_BETA } from '../wireParams';

const BREEZE_GUARDED_VARIANT = 'breeze-guarded-unset-display';

interface ObservedRequest {
  variant: string;
  path: string;
  model: unknown;
  thinking: unknown;
  outputConfig: unknown;
  speed: unknown;
  inferenceGeo: unknown;
  betaHeader: string | null;
}

interface Variant {
  name: string;
  model: string;
  options: Partial<Options>;
  env?: Record<string, string>;
}

const observed: ObservedRequest[] = [];
let currentVariant = '';

function writeSse(res: ServerResponse, model: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const events: Array<[string, unknown]> = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_spike', type: 'message', role: 'assistant', model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const path = req.url ?? '';
    if (req.method !== 'POST' || !path.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"not_found_error","message":"spike capture server"}}');
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      // A non-JSON body is recorded with every field undefined.
    }
    const beta = req.headers['anthropic-beta'];
    observed.push({
      variant: currentVariant,
      path,
      model: body.model,
      thinking: body.thinking,
      outputConfig: body.output_config,
      speed: body.speed,
      inferenceGeo: body.inference_geo,
      betaHeader: Array.isArray(beta) ? beta.join(',') : beta ?? null,
    });
    const model = typeof body.model === 'string' ? body.model : 'spike';
    if (path.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":1}');
      return;
    }
    if (body.stream === true) {
      writeSse(res, model);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_spike', type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
}

function buildVariants(model: string, fastModel: string): Variant[] {
  return [
    { name: 'control-adaptive-medium', model, options: { thinking: { type: 'adaptive' }, effort: 'medium' } },
    { name: 'display-summarized', model, options: { thinking: { type: 'adaptive', display: 'summarized' } } },
    // 0.3.288 made `updates` the CLI default; breeze pins `omitted` (wireParams.ts).
    { name: 'display-omitted', model, options: { thinking: { type: 'adaptive', display: 'omitted' } } },
    // What breeze sends: unset display, the production child-env guard set.
    // main() exits non-zero unless this is `{"type":"adaptive"}` with no updates beta.
    {
      name: BREEZE_GUARDED_VARIANT,
      model,
      options: { thinking: { type: 'adaptive' } },
      env: { ...SDK_CHILD_HOST_CONTEXT_GUARDS },
    },
    {
      name: 'display-unset-updates-env-0',
      model,
      options: { thinking: { type: 'adaptive' } },
      env: { CLAUDE_CODE_THINKING_DISPLAY_UPDATES: '0' },
    },
    {
      name: 'display-unset-updates-env-false',
      model,
      options: { thinking: { type: 'adaptive' } },
      env: { CLAUDE_CODE_THINKING_DISPLAY_UPDATES: 'false' },
    },
    {
      name: 'display-omitted-updates-env-0',
      model,
      options: { thinking: { type: 'adaptive', display: 'omitted' } },
      env: { CLAUDE_CODE_THINKING_DISPLAY_UPDATES: '0' },
    },
    {
      name: 'display-updates-cast',
      model,
      options: { thinking: { type: 'adaptive', display: 'updates' } as unknown as Options['thinking'] },
    },
    {
      name: 'display-updates-extra-arg',
      model,
      options: { thinking: { type: 'adaptive' }, extraArgs: { 'thinking-display': 'updates' } },
    },
    {
      name: 'fast-mode-settings',
      model: fastModel,
      options: { thinking: { type: 'adaptive' }, settings: { fastMode: true } as unknown as Options['settings'] },
    },
    {
      name: 'betas-env',
      model,
      options: { thinking: { type: 'adaptive' } },
      env: { ANTHROPIC_BETAS: 'thinking-display-updates-2026-08-18' },
    },
    {
      name: 'custom-headers-env',
      model: fastModel,
      options: { thinking: { type: 'adaptive' } },
      env: { ANTHROPIC_CUSTOM_HEADERS: 'anthropic-beta: fast-mode-2026-02-01' },
    },
    {
      name: 'extra-body-env-geo',
      model,
      options: { thinking: { type: 'adaptive' } },
      env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify({ inference_geo: 'us' }) },
    },
  ];
}

async function runVariant(baseUrl: string, configDir: string, variant: Variant): Promise<string | null> {
  currentVariant = variant.name;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 60_000);
  try {
    const session = query({
      prompt: 'Reply with OK.',
      options: {
        model: variant.model,
        maxTurns: 1,
        tools: [],
        settingSources: [],
        persistSession: false,
        abortController,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          CLAUDE_CONFIG_DIR: configDir,
          DISABLE_TELEMETRY: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: 'spike-not-a-real-key',
          ...variant.env,
        },
        ...variant.options,
      },
    });
    for await (const _message of session) {
      // drain
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  } finally {
    clearTimeout(timer);
  }
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const model = argValue('--model');
  const fastModel = argValue('--fast-model');
  if (!model || !fastModel) throw new Error('usage: --model <id> --fast-model <id> [--out file.json]');
  const server = createServer(handleRequest);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const configDir = await mkdtemp(join(tmpdir(), 'w01-sdk-spike-'));
  const errors: Record<string, string | null> = {};
  try {
    for (const variant of buildVariants(model, fastModel)) {
      errors[variant.name] = await runVariant(`http://127.0.0.1:${port}`, configDir, variant);
    }
  } finally {
    server.close();
    await rm(configDir, { recursive: true, force: true });
  }
  // The package `exports` map refuses a package.json import, so read it from
  // the resolved package directory instead. The report only labels the run.
  const sdkVersion = await readFile(
    join(dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'),
    'utf8',
  )
    .then((raw) => (JSON.parse(raw) as { version: string }).version)
    .catch(() => 'unknown');
  const report = { at: new Date().toISOString(), sdkVersion, errors, requests: observed };
  console.table(observed.map((row) => ({
    variant: row.variant,
    path: row.path,
    thinking: JSON.stringify(row.thinking),
    output_config: JSON.stringify(row.outputConfig),
    speed: JSON.stringify(row.speed),
    inference_geo: JSON.stringify(row.inferenceGeo),
    beta: row.betaHeader,
  })));
  const out = argValue('--out');
  if (out) await writeFile(out, JSON.stringify(report, null, 2));
  // Agent SDK 0.3.288 made display 'updates' the CLI default; breeze opts out
  // via SDK_CHILD_HOST_CONTEXT_GUARDS. Fail loudly if the opt-out stops working.
  const guarded = observed.filter((row) => row.variant === BREEZE_GUARDED_VARIANT);
  const leaked = guarded.length === 0 || guarded.some((row) => (
    JSON.stringify(row.thinking) !== '{"type":"adaptive"}'
    || (row.betaHeader ?? '').includes(THINKING_DISPLAY_UPDATES_BETA)
  ));
  if (leaked) {
    console.error(`[spike] FAIL: ${BREEZE_GUARDED_VARIANT} did not send {"type":"adaptive"} without ${THINKING_DISPLAY_UPDATES_BETA}`);
    process.exitCode = 1;
  } else {
    console.error(`[spike] OK: ${BREEZE_GUARDED_VARIANT} sent {"type":"adaptive"} without ${THINKING_DISPLAY_UPDATES_BETA}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
