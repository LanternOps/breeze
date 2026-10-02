#!/usr/bin/env tsx
// apps/api/src/services/aiModels/__scripts__/sdkResumeAcrossModelsSpike.ts (the shebang must stay on line 1)
/**
 * AI model registry W05 spike (#7603): is Agent SDK `resume` across models safe?
 *
 * Runs real `query()` sessions shaped like breeze chat (streaming input, an
 * in-process MCP server, `tools: []`, `persistSession: true`,
 * `settingSources: []`, `resume`) through a local logging proxy that forwards
 * to the real Anthropic API. The CLI child gets a placeholder key; the proxy
 * swaps in the real `x-api-key` on the way out, so the key never reaches the
 * child, its transcript, or this script's output. The proxy records, per
 * request: path, model, thinking, output_config, speed, `anthropic-beta`, a
 * block-type summary of `messages` (never text), and the response status,
 * error text, block types and usage. It never records headers or prompt text.
 *
 *   ANTHROPIC_API_KEY=… npx tsx src/services/aiModels/__scripts__/sdkResumeAcrossModelsSpike.ts \
 *     --sonnet <id> --opus <id> --haiku <id> [--only s1,s2] [--out file.json] [--keep]
 *
 * Model ids are arguments, not literals (index invariant 1). Spend is
 * estimated from the seeded registry rates and the run refuses to start a new
 * scenario past --budget-usd (default 8).
 *
 * Findings: docs/superpowers/specs/ai-mcp/2026-10-01-ai-model-registry-w05-resume-spike-findings.md
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { SDK_CHILD_HOST_CONTEXT_GUARDS } from '../../llm/sdkChildEnvGuards';
import { SEEDED_PLATFORM_MODELS } from '../__fixtures__/seededPlatformModels';

// ---------------------------------------------------------------- proxy

interface ObservedRequest {
  step: string;
  path: string;
  model: unknown;
  thinking: unknown;
  outputConfig: unknown;
  speed: unknown;
  beta: string | null;
  /** One string per message: `role:block,block…` (no text). */
  messages: string[];
  thinkingBlocksSent: number;
  toolUseSent: number;
  toolResultSent: number;
  status: number;
  error: string | null;
  servedModel: string | null;
  responseBlocks: string[];
  usage: Record<string, number>;
  stopReason: string | null;
  estUsd: number;
}

const observed: ObservedRequest[] = [];
let currentStep = 'init';
let spendUsd = 0;
let realKey = '';

function ratesFor(model: string): [number, number, number, number] {
  const row = SEEDED_PLATFORM_MODELS.find((m) => model === m.modelId || model.startsWith(`${m.modelId}-`));
  // Unknown model: price it as the most expensive seeded row, so the guard errs high.
  if (!row?.rates) return [1000, 5000, 100, 1250];
  const r = row.rates;
  return [r.inputCentsPerM, r.outputCentsPerM, r.cacheReadCentsPerM, r.cacheWriteCentsPerM];
}

function estimateUsd(model: string, usage: Record<string, number>, fast: boolean): number {
  const [inC, outC, readC, writeC] = ratesFor(model);
  const cents = ((usage.input_tokens ?? 0) * inC + (usage.output_tokens ?? 0) * outC
    + (usage.cache_read_input_tokens ?? 0) * readC + (usage.cache_creation_input_tokens ?? 0) * writeC) / 1e6;
  return (cents / 100) * (fast ? 6 : 1);
}

function summarizeBlock(block: Record<string, unknown>): string {
  const type = String(block.type);
  if (type === 'thinking') {
    const text = typeof block.thinking === 'string' ? block.thinking.length : 0;
    return `thinking(sig=${typeof block.signature === 'string' && block.signature.length > 0},len=${text})`;
  }
  if (type === 'tool_use') return `tool_use:${String(block.name)}`;
  return type;
}

function summarizeMessages(messages: unknown): { lines: string[]; thinking: number; toolUse: number; toolResult: number } {
  const lines: string[] = [];
  let thinking = 0;
  let toolUse = 0;
  let toolResult = 0;
  if (!Array.isArray(messages)) return { lines, thinking, toolUse, toolResult };
  for (const message of messages as Array<Record<string, unknown>>) {
    const content = message.content;
    const blocks = typeof content === 'string'
      ? ['text']
      : Array.isArray(content) ? (content as Array<Record<string, unknown>>).map(summarizeBlock) : [];
    for (const b of blocks) {
      if (b.startsWith('thinking') || b === 'redacted_thinking') thinking += 1;
      if (b.startsWith('tool_use')) toolUse += 1;
      if (b === 'tool_result') toolResult += 1;
    }
    lines.push(`${String(message.role)}:${blocks.join(',')}`);
  }
  return { lines, thinking, toolUse, toolResult };
}

function parseSse(raw: string): {
  model: string | null; blocks: string[]; usage: Record<string, number>; error: string | null; stopReason: string | null;
} {
  let model: string | null = null;
  let stopReason: string | null = null;
  const blocks: string[] = [];
  const usage: Record<string, number> = {};
  let error: string | null = null;
  const mergeUsage = (u: unknown) => {
    if (!u || typeof u !== 'object') return;
    for (const [k, v] of Object.entries(u as Record<string, unknown>)) if (typeof v === 'number') usage[k] = v;
  };
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line.slice(6)) as Record<string, unknown>; } catch { continue; }
    if (event.type === 'message_start') {
      const message = event.message as Record<string, unknown>;
      model = typeof message.model === 'string' ? message.model : null;
      mergeUsage(message.usage);
    } else if (event.type === 'content_block_start') {
      blocks.push(summarizeBlock(event.content_block as Record<string, unknown>).replace(/\(.*\)/, ''));
    } else if (event.type === 'message_delta') {
      mergeUsage(event.usage);
      const delta = event.delta as Record<string, unknown> | undefined;
      if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason;
    } else if (event.type === 'error') {
      error = JSON.stringify(event.error).slice(0, 500);
    }
  }
  return { model, blocks, usage, error, stopReason };
}

function handleProxy(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);
    const path = req.url ?? '/';
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(bodyBuf.toString('utf8')) as Record<string, unknown>; } catch { /* non-JSON */ }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const key = k.toLowerCase();
      if (['host', 'x-api-key', 'authorization', 'accept-encoding', 'content-length', 'connection'].includes(key)) continue;
      headers[key] = Array.isArray(v) ? v.join(',') : v;
    }
    headers['x-api-key'] = realKey;
    headers['accept-encoding'] = 'identity';
    headers['content-length'] = String(bodyBuf.length);
    const beta = req.headers['anthropic-beta'];
    const summary = summarizeMessages(body.messages);
    const row: ObservedRequest = {
      step: currentStep,
      path,
      model: body.model,
      thinking: body.thinking,
      outputConfig: body.output_config,
      speed: body.speed,
      beta: Array.isArray(beta) ? beta.join(',') : beta ?? null,
      messages: summary.lines,
      thinkingBlocksSent: summary.thinking,
      toolUseSent: summary.toolUse,
      toolResultSent: summary.toolResult,
      status: 0,
      error: null,
      servedModel: null,
      responseBlocks: [],
      usage: {},
      stopReason: null,
      estUsd: 0,
    };
    observed.push(row);
    const upstream = httpsRequest(
      { host: 'api.anthropic.com', port: 443, method: req.method, path, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        const out: Buffer[] = [];
        up.on('data', (c: Buffer) => { out.push(c); res.write(c); });
        up.on('end', () => {
          res.end();
          row.status = up.statusCode ?? 0;
          const text = Buffer.concat(out).toString('utf8');
          const contentType = String(up.headers['content-type'] ?? '');
          if (contentType.includes('text/event-stream')) {
            const sse = parseSse(text);
            row.servedModel = sse.model;
            row.responseBlocks = sse.blocks;
            row.usage = sse.usage;
            row.error = sse.error;
            row.stopReason = sse.stopReason;
          } else {
            try {
              const json = JSON.parse(text) as Record<string, unknown>;
              if (row.status >= 400) row.error = JSON.stringify(json.error ?? json).slice(0, 500);
              if (typeof json.model === 'string') row.servedModel = json.model;
              if (typeof json.stop_reason === 'string') row.stopReason = json.stop_reason;
              if (Array.isArray(json.content)) {
                row.responseBlocks = (json.content as Array<Record<string, unknown>>).map((b) => String(b.type));
              }
              if (json.usage && typeof json.usage === 'object') {
                for (const [k, v] of Object.entries(json.usage as Record<string, unknown>)) if (typeof v === 'number') row.usage[k] = v;
              }
            } catch {
              if (row.status >= 400) row.error = text.slice(0, 500);
            }
          }
          row.estUsd = estimateUsd(String(row.servedModel ?? body.model ?? ''), row.usage, body.speed === 'fast');
          spendUsd += row.estUsd;
        });
      },
    );
    upstream.on('error', (err) => {
      row.error = `proxy upstream error: ${err.message}`;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"api_error","message":"spike proxy upstream error"}}');
    });
    upstream.end(bodyBuf);
  });
}

// ---------------------------------------------------------------- tool + session harness

const LOOKUP: Record<string, string> = {
  alpha: "The value for alpha is a pointer: the next key is 'bravo-7'. Look it up.",
  'bravo-7': 'CODE-4417',
  gamma: 'GAMMA-9031',
};
const toolCalls: Array<{ step: string; key: string }> = [];
/** When set, a lookup of this key blocks until `releaseBlockedTool` is called. */
let blockKey: string | null = null;
let onBlocked: (() => void) | null = null;
let releaseBlockedTool: (() => void) | null = null;

const lookupTool = tool(
  'spike_lookup',
  'Look up a key in the spike key-value store and return its value.',
  { key: z.string() },
  async ({ key }) => {
    toolCalls.push({ step: currentStep, key });
    if (blockKey !== null && key === blockKey) {
      await new Promise<void>((resolve) => {
        releaseBlockedTool = resolve;
        onBlocked?.();
        setTimeout(resolve, 30_000);
      });
    }
    return { content: [{ type: 'text', text: LOOKUP[key] ?? `no such key: ${key}` }] };
  },
);
const MCP_NAME = 'spike';
const TOOL_NAME = `mcp__${MCP_NAME}__spike_lookup`;

const PROMPT_A = "Use the spike_lookup tool to look up the key 'alpha'. Its result names a second key; look that one up too. "
  + 'Also, before your final answer, determine how many integers from 1 to 3000 inclusive are divisible by 4 or by 6 '
  + 'but not by 9, reasoning it through carefully. Reply in the form SUM=<n> CODE=<final code>.';
const PROMPT_B = 'Do not call spike_lookup for alpha or for the second key again. From this conversation\'s history, '
  + "state the second key and the final code you found earlier. Then call spike_lookup with key 'gamma'. "
  + 'Reply exactly in the form SECOND=<key> CODE=<code> GAMMA=<value>.';

type ThinkingOpts = Pick<Options, 'thinking' | 'effort'>;

interface TurnResult {
  step: string;
  model: string;
  sessionId: string | null;
  subtype: string | null;
  isError: boolean | null;
  resultText: string | null;
  errors: unknown;
  modelUsage: unknown;
  /** `result.usage`: the SDK documents it as main-loop, per-turn. */
  resultUsage: unknown;
  totalCostUsd: number | null;
  numTurns: number | null;
  thrown: string | null;
  initModel: string | null;
  /** Per-API-call usage summed from the `assistant` messages the SDK emitted (deduped by message id). */
  assistantUsage: Record<string, { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }>;
  checks?: Record<string, boolean>;
}

class InputQueue {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(v: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;
  push(text: string): void {
    const msg = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage;
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false }); else this.items.push(msg);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  async *stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = this.items.shift();
      if (next) { yield next; continue; }
      if (this.closed) return;
      const r = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => this.waiters.push(resolve));
      if (r.done) return;
      yield r.value;
    }
  }
}

interface Ctx { baseUrl: string; configDir: string; cwd: string }

function sessionOptions(ctx: Ctx, model: string, thinking: ThinkingOpts, extra: Partial<Options> = {}): Options {
  return {
    model,
    cwd: ctx.cwd,
    maxTurns: 8,
    tools: [],
    allowedTools: [TOOL_NAME],
    mcpServers: { [MCP_NAME]: createSdkMcpServer({ name: MCP_NAME, version: '1.0.0', tools: [lookupTool] }) },
    includePartialMessages: true,
    persistSession: true,
    settingSources: [],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      CI: 'true',
      ...SDK_CHILD_HOST_CONTEXT_GUARDS,
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CONFIG_DIR: ctx.configDir,
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_BASE_URL: ctx.baseUrl,
      ANTHROPIC_API_KEY: 'spike-placeholder-proxy-injects-key',
    },
    ...thinking,
    ...extra,
  };
}

function emptyResult(step: string, model: string): TurnResult {
  return {
    step, model, sessionId: null, subtype: null, isError: null, resultText: null, errors: null,
    modelUsage: null, resultUsage: null, totalCostUsd: null, numTurns: null, thrown: null, initModel: null, assistantUsage: {},
  };
}

const seenAssistantIds = new Set<string>();

function absorb(out: TurnResult, message: SDKMessage): void {
  const m = message as Record<string, unknown>;
  if (m.type === 'assistant') {
    const msg = m.message as Record<string, unknown> | undefined;
    const id = typeof msg?.id === 'string' ? msg.id : null;
    const usage = msg?.usage as Record<string, number> | undefined;
    if (id && usage && !seenAssistantIds.has(id)) {
      seenAssistantIds.add(id);
      const key = String(msg?.model ?? 'unknown');
      const acc = out.assistantUsage[key] ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      acc.calls += 1;
      acc.input += usage.input_tokens ?? 0;
      acc.output += usage.output_tokens ?? 0;
      acc.cacheRead += usage.cache_read_input_tokens ?? 0;
      acc.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      out.assistantUsage[key] = acc;
    }
  }
  if (typeof m.session_id === 'string') out.sessionId = m.session_id;
  if (m.type === 'system' && m.subtype === 'init' && typeof m.model === 'string') out.initModel = m.model;
  if (m.type === 'result') {
    out.subtype = String(m.subtype);
    out.isError = Boolean(m.is_error);
    out.resultText = typeof m.result === 'string' ? m.result.slice(0, 400) : null;
    out.errors = m.errors ?? null;
    out.modelUsage = m.modelUsage ?? null;
    const u = m.usage as Record<string, unknown> | undefined;
    out.resultUsage = u
      ? Object.fromEntries(Object.entries(u).filter(([, v]) => typeof v === 'number'))
      : null;
    out.totalCostUsd = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null;
    out.numTurns = typeof m.num_turns === 'number' ? m.num_turns : null;
  }
}

/** One turn in its own `query()` (breeze recreates the query when the model changes). */
async function runTurn(
  ctx: Ctx,
  step: string,
  model: string,
  thinking: ThinkingOpts,
  prompt: string,
  extra: Partial<Options> = {},
  control?: (q: Query, abort: AbortController) => void,
): Promise<TurnResult> {
  currentStep = step;
  const out = emptyResult(step, model);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 240_000);
  const input = new InputQueue();
  input.push(prompt);
  try {
    const q = query({ prompt: input.stream(), options: sessionOptions(ctx, model, thinking, { abortController, ...extra }) });
    control?.(q, abortController);
    for await (const message of q) {
      absorb(out, message);
      if ((message as { type: string }).type === 'result') input.close();
    }
  } catch (error) {
    out.thrown = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  } finally {
    clearTimeout(timer);
    input.close();
  }
  return out;
}

function checkB(r: TurnResult): Record<string, boolean> {
  const text = r.resultText ?? '';
  const calls = toolCalls.filter((c) => c.step === r.step).map((c) => c.key);
  return {
    recalledSecondKey: text.includes('bravo-7'),
    recalledCode: text.includes('CODE-4417'),
    calledGamma: calls.includes('gamma') && text.includes('GAMMA-9031'),
    didNotRecallTools: !calls.includes('alpha') && !calls.includes('bravo-7'),
  };
}

// ---------------------------------------------------------------- scenarios

interface Models { sonnet: string; opus: string; haiku: string }
/** Turn A on an adaptive model: `max` effort so the model actually thinks and thinking blocks persist. */
const ADAPTIVE_HIGH: ThinkingOpts = { thinking: { type: 'adaptive' }, effort: 'max' };
const ADAPTIVE_MEDIUM: ThinkingOpts = { thinking: { type: 'adaptive' }, effort: 'medium' };
const BUDGET: ThinkingOpts = { thinking: { type: 'enabled', budgetTokens: 2048 } };
const DISABLED: ThinkingOpts = { thinking: { type: 'disabled' } };

type Scenario = { id: string; run: (ctx: Ctx, m: Models) => Promise<unknown> };

async function pair(ctx: Ctx, id: string, a: [string, ThinkingOpts], b: [string, ThinkingOpts]) {
  const turnA = await runTurn(ctx, `${id}:A`, a[0], a[1], PROMPT_A);
  if (!turnA.sessionId) return { turnA };
  const turnB = await runTurn(ctx, `${id}:B`, b[0], b[1], PROMPT_B, { resume: turnA.sessionId });
  turnB.checks = checkB(turnB);
  return { turnA, turnB };
}

const SCENARIOS: Scenario[] = [
  // Q2 controls: same-model resume (is prior-turn thinking kept?) and a round trip back to model A.
  { id: 'q2-same-model', run: (c, m) => pair(c, 'q2-same-model', [m.sonnet, ADAPTIVE_HIGH], [m.sonnet, ADAPTIVE_MEDIUM]) },
  {
    id: 'q2-roundtrip',
    run: async (c, m) => {
      const first = await pair(c, 'q2-roundtrip', [m.sonnet, ADAPTIVE_HIGH], [m.opus, ADAPTIVE_MEDIUM]);
      const sessionId = (first as { turnA: TurnResult }).turnA.sessionId;
      if (!sessionId) return first;
      const turnC = await runTurn(c, 'q2-roundtrip:C', m.sonnet, ADAPTIVE_MEDIUM, 'Reply with the word DONE and the GAMMA value again.',
        { resume: sessionId });
      return { ...first, turnC };
    },
  },
  // Q1/Q2/Q5: cross-model resume with tool + thinking history.
  { id: 'q1-sonnet-opus', run: (c, m) => pair(c, 'q1-sonnet-opus', [m.sonnet, ADAPTIVE_HIGH], [m.opus, ADAPTIVE_MEDIUM]) },
  { id: 'q1-opus-sonnet', run: (c, m) => pair(c, 'q1-opus-sonnet', [m.opus, ADAPTIVE_HIGH], [m.sonnet, ADAPTIVE_MEDIUM]) },
  { id: 'q1-sonnet-haiku-budget', run: (c, m) => pair(c, 'q1-sonnet-haiku-budget', [m.sonnet, ADAPTIVE_HIGH], [m.haiku, BUDGET]) },
  { id: 'q1-sonnet-haiku-disabled', run: (c, m) => pair(c, 'q1-sonnet-haiku-disabled', [m.sonnet, ADAPTIVE_HIGH], [m.haiku, DISABLED]) },
  { id: 'q1-haiku-budget-sonnet', run: (c, m) => pair(c, 'q1-haiku-budget-sonnet', [m.haiku, BUDGET], [m.sonnet, ADAPTIVE_MEDIUM]) },
  // Q4: same model, option-only change on resume (effort; fast mode on, then off).
  {
    id: 'q4-options',
    run: async (c, m) => {
      const turnA = await runTurn(c, 'q4:A', m.opus, ADAPTIVE_MEDIUM, PROMPT_A);
      if (!turnA.sessionId) return { turnA };
      const fastOn = await runTurn(c, 'q4:B-fast-low', m.opus, { thinking: { type: 'adaptive' }, effort: 'low' }, PROMPT_B,
        { resume: turnA.sessionId, settings: { fastMode: true } as unknown as Options['settings'] });
      fastOn.checks = checkB(fastOn);
      const fastOff = await runTurn(c, 'q4:C-std-high', m.opus, ADAPTIVE_HIGH, 'Reply with the word DONE and the GAMMA value again.',
        { resume: turnA.sessionId });
      return { turnA, fastOn, fastOff };
    },
  },
  // Q6: a turn interrupted mid-tool-call, then resumed on another model (and same-model control).
  {
    id: 'q6-interrupt',
    run: async (c, m) => {
      const results: Record<string, unknown> = {};
      for (const [label, kind, target] of [
        ['interrupt-opus', 'interrupt', m.opus],
        ['interrupt-same', 'interrupt', m.sonnet],
        ['abort-opus', 'abort', m.opus],
      ] as const) {
        blockKey = 'bravo-7';
        const turnA = await runTurn(c, `q6-${label}:A`, m.sonnet, ADAPTIVE_HIGH, PROMPT_A, {}, (q, abort) => {
          onBlocked = () => {
            if (kind === 'interrupt') void q.interrupt().catch(() => undefined).finally(() => releaseBlockedTool?.());
            else abort.abort();
          };
        });
        blockKey = null;
        onBlocked = null;
        releaseBlockedTool?.();
        if (!turnA.sessionId) { results[label] = { turnA }; continue; }
        const turnB = await runTurn(c, `q6-${label}:B`, target, ADAPTIVE_MEDIUM,
          'Continue where you left off and finish the original task. Reply in the form SUM=<n> CODE=<final code>.',
          { resume: turnA.sessionId });
        results[label] = { turnA, turnB };
      }
      return results;
    },
  },
  // Live switch on one streaming query via setModel (no resume), for comparison.
  {
    id: 'setmodel-live',
    run: async (c, m) => {
      const out: TurnResult[] = [];
      currentStep = 'setmodel:A';
      const input = new InputQueue();
      input.push(PROMPT_A);
      let current = emptyResult('setmodel:A', m.sonnet);
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), 240_000);
      try {
        const q = query({ prompt: input.stream(), options: sessionOptions(c, m.sonnet, ADAPTIVE_HIGH, { abortController }) });
        let phase = 0;
        for await (const message of q) {
          absorb(current, message);
          if ((message as { type: string }).type !== 'result') continue;
          out.push(current);
          phase += 1;
          if (phase === 1) {
            await q.setModel(m.haiku);
            currentStep = 'setmodel:B-haiku';
            current = emptyResult('setmodel:B-haiku', m.haiku);
            input.push(PROMPT_B);
          } else {
            input.close();
          }
        }
      } catch (error) {
        current.thrown = error instanceof Error ? error.message.slice(0, 500) : String(error);
        out.push(current);
      } finally {
        clearTimeout(timer);
        input.close();
      }
      const b = out.find((r) => r.step === 'setmodel:B-haiku');
      if (b) b.checks = checkB(b);
      return out;
    },
  },
  // Q3: transcript over the target's window (Haiku 200k) but inside Sonnet's.
  {
    id: 'q3-window',
    run: async (c, m) => {
      const client = new Anthropic({ apiKey: realKey });
      const unit = 'ledger row amber cobalt delta ember fjord granite harbor ivory juniper kelp lumen marble nectar onyx '
        + 'pewter quartz russet sable topaz umber violet walnut xenon yarrow zinc. ';
      const sample = unit.repeat(200);
      const sampleTokens = (await client.messages.countTokens({ model: m.haiku, messages: [{ role: 'user', content: sample }] })).input_tokens;
      const repeats = Math.ceil((212_000 / sampleTokens) * 200);
      const filler = `${unit.repeat(repeats)}\nReply with the single word OK.`;
      const haikuTokens = (await client.messages.countTokens({ model: m.haiku, messages: [{ role: 'user', content: filler }] })).input_tokens;
      const sonnetTokens = (await client.messages.countTokens({ model: m.sonnet, messages: [{ role: 'user', content: filler }] })).input_tokens;
      const turnA = await runTurn(c, 'q3:A', m.sonnet, ADAPTIVE_MEDIUM, filler);
      if (!turnA.sessionId) return { haikuTokens, sonnetTokens, turnA };
      const turnB = await runTurn(c, 'q3:B-haiku', m.haiku, DISABLED, 'Reply with the word STILL-HERE.', { resume: turnA.sessionId });
      return { haikuTokens, sonnetTokens, turnA, turnB };
    },
  },
];

// ---------------------------------------------------------------- transcripts

async function transcriptSummary(configDir: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const projects = join(configDir, 'projects');
  const dirs = await readdir(projects).catch(() => [] as string[]);
  for (const dir of dirs) {
    for (const file of await readdir(join(projects, dir)).catch(() => [] as string[])) {
      if (!file.endsWith('.jsonl')) continue;
      const lines = (await readFile(join(projects, dir, file), 'utf8')).split('\n').filter(Boolean);
      out[file.replace('.jsonl', '')] = lines.flatMap((line) => {
        try {
          const e = JSON.parse(line) as Record<string, unknown>;
          const msg = e.message as Record<string, unknown> | undefined;
          if (!msg || (e.type !== 'assistant' && e.type !== 'user')) {
            return e.type === 'system' || e.type === 'summary' ? [`${String(e.type)}:${String(e.subtype ?? '')}`] : [];
          }
          const content = Array.isArray(msg.content)
            ? (msg.content as Array<Record<string, unknown>>).map(summarizeBlock).join(',')
            : 'text';
          return [`${String(e.type)}${msg.model ? `[${String(msg.model)}]` : ''}:${content}`];
        } catch { return []; }
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- main

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  realKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!realKey) throw new Error('ANTHROPIC_API_KEY is required');
  const models: Models = { sonnet: argValue('--sonnet') ?? '', opus: argValue('--opus') ?? '', haiku: argValue('--haiku') ?? '' };
  if (!models.sonnet || !models.opus || !models.haiku) throw new Error('usage: --sonnet <id> --opus <id> --haiku <id>');
  const only = argValue('--only')?.split(',');
  const budget = Number(argValue('--budget-usd') ?? '8');
  const server = createServer(handleProxy);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const configDir = await mkdtemp(join(tmpdir(), 'w05-resume-spike-cfg-'));
  const cwd = await mkdtemp(join(tmpdir(), 'w05-resume-spike-cwd-'));
  const ctx: Ctx = { baseUrl: `http://127.0.0.1:${port}`, configDir, cwd };
  const results: Record<string, unknown> = {};
  try {
    for (const scenario of SCENARIOS) {
      if (only && !only.includes(scenario.id)) continue;
      if (spendUsd >= budget) { results[scenario.id] = { skipped: `budget ${spendUsd.toFixed(2)} >= ${budget}` }; continue; }
      console.error(`[spike] ${scenario.id} (spend so far ~$${spendUsd.toFixed(3)})`);
      try {
        results[scenario.id] = await scenario.run(ctx, models);
      } catch (error) {
        results[scenario.id] = { scenarioError: error instanceof Error ? error.message.slice(0, 500) : String(error) };
      }
    }
  } finally {
    server.close();
  }
  const transcripts = await transcriptSummary(configDir);
  if (!process.argv.includes('--keep')) {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
  const report = { at: new Date().toISOString(), estSpendUsd: Number(spendUsd.toFixed(4)), results, toolCalls, requests: observed, transcripts };
  const out = argValue('--out');
  if (out) await writeFile(out, JSON.stringify(report, null, 2));
  console.error(`[spike] done; estimated spend $${spendUsd.toFixed(4)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
