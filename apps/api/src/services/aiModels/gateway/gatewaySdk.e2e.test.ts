/**
 * End-to-end proof for W06 (Review Focus 3): the bundled Claude Agent SDK CLI,
 * in first-party mode, pointed at the loopback gateway through the real
 * `prepareSdkChild` env, runs an in-process MCP tool off an OpenAI tool call
 * and reports the upstream's usage. No network: the gateway's upstream dial is
 * replaced in-process, and the child's only proxy is the deny-all grant. This
 * suite spawns the CLI binary; it FAILS (does not skip) if the binary cannot
 * start.
 */
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const egress = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: (e: Record<string, unknown>) => { egress.events.push(e); } }));

import { __setUpstreamFetchForTests } from './forward';
import { closeModelGateway, getModelGateway } from '.';
import { prepareSdkChild } from '../connectionFactory';
import { makeResolvedModel } from '../__fixtures__/resolvedModel';
import { getLlmEgressProxy } from '../../llm/llmEgressProxy';

const upstreamCalls: Array<{ model: string; messages: Array<{ role: string; content?: unknown }> }> = [];
const upstreamAuth: Array<string | undefined> = [];
const enc = new TextEncoder();
function sseResponse(chunks: unknown[]): Response {
  return new Response(new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

beforeAll(async () => {
  await getModelGateway();
  __setUpstreamFetchForTests((async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body) as { model: string; messages: Array<{ role: string; content?: unknown }>; tools?: unknown[]; stream: boolean };
    upstreamCalls.push(body);
    upstreamAuth.push(init.headers.authorization);
    const sawToolResult = body.messages.some((m) => m.role === 'tool');
    // OpenAI reports usage only in the final chunk (stream_options.include_usage).
    const usage = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } };
    if (body.tools && !sawToolResult) {
      return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_w', type: 'function', function: { name: 'mcp__fidelity__get_weather', arguments: '{"city":"Oslo"}' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage },
      ]);
    }
    return sseResponse([
      { choices: [{ index: 0, delta: { content: 'It is sunny and 21C in Oslo.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage },
    ]);
  }) as never);
});
afterAll(async () => {
  __setUpstreamFetchForTests(null);
  await closeModelGateway();
  await (await getLlmEgressProxy()).close();
});

describe('Agent SDK through the gateway (openai_compatible)', () => {
  it('SDK modelUsage equals upstream usage: runs an MCP tool from an OpenAI tool call and bills the upstream usage', async () => {
    const r = makeResolvedModel('openai_compatible');
    const child = await prepareSdkChild(r, { key: 'e2e', orgId: 'org-1', aiSessionId: null });
    let toolRuns = 0;
    const weather = tool('get_weather', 'Weather for a city', { city: z.string() }, async ({ city }) => {
      toolRuns += 1;
      return { content: [{ type: 'text', text: `sunny 21C in ${city}` }] };
    });
    const stderr: string[] = [];
    let result: Record<string, unknown> | null = null;
    try {
      for await (const m of query({
        prompt: 'What is the weather in Oslo? Use the tool.',
        options: {
          model: r.wireModel, maxTurns: 4, tools: [], allowedTools: ['mcp__fidelity__get_weather'],
          mcpServers: { fidelity: createSdkMcpServer({ name: 'fidelity', version: '1.0.0', tools: [weather] }) },
          settingSources: [], persistSession: false, env: child.env,
          // Exactly what both spawn sites pass for a gateway connection.
          ...(child.cwd !== undefined ? { cwd: child.cwd } : {}),
          stderr: (d: string) => { stderr.push(d); },
        },
      })) {
        if ((m as { type?: string }).type === 'result') result = m as Record<string, unknown>;
      }
    } finally {
      child.revoke();
    }
    // The child ran in its own empty working directory, gone once revoked.
    expect(child.cwd).toBeDefined();
    expect(existsSync(child.cwd!)).toBe(false);
    expect(result, `no result; CLI stderr:\n${stderr.join('').slice(-4000)}`).not.toBeNull();
    expect(toolRuns).toBe(1);
    expect(result).toMatchObject({ subtype: 'success' });
    expect(String(result!.result)).toContain('21');
    // Every upstream call named the bound wire model only, with the credential
    // injected by the gateway (the child never had it).
    expect(upstreamCalls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(upstreamCalls.map((c) => c.model))).toEqual(new Set([r.wireModel]));
    expect(new Set(upstreamAuth)).toEqual(new Set(['Bearer sk-fixture-upstream']));
    // Billing basis (Review Focus 3): per call input 60 (100 − 40 cached), cache read 40, output 10.
    const modelUsage = result!.modelUsage as Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
    expect(Object.keys(modelUsage)).toEqual([r.wireModel]);
    const mu = modelUsage[r.wireModel]!;
    const n = upstreamCalls.length;
    expect(mu).toMatchObject({ inputTokens: 60 * n, outputTokens: 10 * n, cacheReadInputTokens: 40 * n, cacheCreationInputTokens: 0 });
    // The child reached nothing but the loopback gateway: whatever else the CLI
    // tried (it still dials platform.claude.com with nonessential traffic
    // disabled) hit the deny-all proxy grant, refused and audited.
    const connects = egress.events.filter((e) => e.surface === 'sdk_proxy_connect');
    for (const e of connects) expect(e).toMatchObject({ blocked: true, resolvedIp: null, connectionId: 'conn-oai', orgId: 'org-1' });
    expect(connects.map((e) => e.host)).not.toContain('llm.example.com');
    // The CLI's environment context reaches the untrusted endpoint: it must
    // carry no repository or host path, and no git details.
    const systemText = JSON.stringify(upstreamCalls.flatMap((c) => c.messages.filter((m) => m.role === 'system')));
    expect(systemText).toContain('Primary working directory');
    const repoRoot = path.resolve(process.cwd(), '..', '..');
    for (const hostPath of [process.cwd(), repoRoot, os.homedir()]) {
      expect(systemText).not.toContain(hostPath);
    }
    expect(systemText).not.toContain('Is a git repository: true');
  }, 120_000);

  it('only the gateway port is exempt from the deny-all proxy: another loopback port is never dialled directly', async () => {
    // A trap on a second loopback port. Pointing the child at it (with the
    // gateway env otherwise untouched) must route through the deny-all proxy,
    // so the trap never sees a request. The control run, with every loopback
    // port exempt, proves the trap is reachable when the exemption allows it.
    let trapHits = 0;
    const trap = http.createServer((req, res) => {
      trapHits += 1;
      req.resume();
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'trap' } }));
    });
    await new Promise<void>((resolve) => trap.listen(0, '127.0.0.1', resolve));
    const trapUrl = `http://127.0.0.1:${(trap.address() as AddressInfo).port}`;
    const r = makeResolvedModel('openai_compatible');
    const runAgainstTrap = async (noProxyOverride?: string): Promise<void> => {
      const child = await prepareSdkChild(r, { key: 'e2e-trap', orgId: 'org-1', aiSessionId: null });
      const env = { ...child.env, ANTHROPIC_BASE_URL: trapUrl, ...(noProxyOverride !== undefined ? { NO_PROXY: noProxyOverride } : {}) };
      try {
        for await (const _m of query({
          prompt: 'hi',
          options: {
            model: r.wireModel, maxTurns: 1, tools: [], settingSources: [], persistSession: false, env,
            ...(child.cwd !== undefined ? { cwd: child.cwd } : {}),
          },
        })) { /* drain */ }
      } catch { /* the run is expected to fail either way */ } finally {
        child.revoke();
      }
    };
    try {
      await runAgainstTrap();
      expect(trapHits).toBe(0);
      await runAgainstTrap('127.0.0.1,localhost');
      expect(trapHits).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => trap.close(() => resolve()));
    }
  }, 120_000);
});
