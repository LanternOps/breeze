#!/usr/bin/env tsx
/**
 * Capture tool schemas and SDK observations without executing tools.
 * API scripts do not load dotenv; DATABASE_URL is required by registry imports.
 *
 * Usage:
 *   DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/unused ANTHROPIC_API_KEY=… \
 *   pnpm --filter @breeze/api ai:tool-capture -- \
 *     --surface chat|helper-basic|helper-standard|helper-extended|agent-full|script-builder|all
 *     [--tool-search default|on|off]  default: default; proxy requires on or off
 *     [--proxy]                      record tools/defer_loading/system bytes
 *     [--turns 1|2]                  default: 1; 2 resumes to measure cache reads
 *     [--prompt "…"]                 default: Which Windows devices in the fleet are offline right now?
 *     [--model <id>]                 default: resolveDefaultModel()
 *     [--base-url URL --auth-token T | --api-key K]  BYO rows labeled byo:<host>
 *     [--tenant-tools none|a|b]      chat only: synthetic BYO MCP tools via buildTenantSdkTools (default none)
 *     [--tenant-count N]             tools in that set (default: the set's 12 named tools)
 *     [--out apps/api/tool-capture.jsonl]
 */
import { appendFile } from 'node:fs/promises';
import { closeDb } from '../../../db';
import { resolveDefaultModel } from '../../aiModel';
import { buildClaudeSdkChildEnv } from '../../streamingSessionManager';
import { platformLlmConfig } from '../llmConfigResolver';
import { startCaptureProxy, type CaptureProxy } from '../toolCapture/captureProxy';
import { getCaptureSystemPrompt, runSurfaceCapture } from '../toolCapture/runSurface';
import { CAPTURE_SURFACES, type CaptureSurfaceId } from '../toolCapture/surfaces';
import { CAPTURE_TENANT_SET_IDS, MAX_CAPTURE_TENANT_TOOLS, captureTenantDescriptors, type CaptureTenantSetId } from '../toolCapture/tenantFixtures';

class UsageError extends Error {}

function parseArgs(args: string[]) {
  const values = new Map<string, string>();
  const valueFlags = new Set(['--surface', '--tool-search', '--turns', '--prompt', '--model', '--base-url', '--auth-token', '--api-key', '--out', '--tenant-tools', '--tenant-count']);
  let proxy = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--') continue;
    if (flag === '--proxy') { proxy = true; continue; }
    if (!valueFlags.has(flag)) throw new UsageError('Unknown option; see the usage block in tool-capture.ts');
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new UsageError(`Missing value for ${flag}`);
    values.set(flag, value);
  }
  const surface = values.get('--surface');
  if (!surface || (surface !== 'all' && !Object.hasOwn(CAPTURE_SURFACES, surface))) {
    throw new UsageError('--surface must be all or a capture surface ID');
  }
  const toolSearch = values.get('--tool-search') ?? 'default';
  if (!['default', 'on', 'off'].includes(toolSearch)) throw new UsageError('--tool-search must be default, on, or off');
  if (proxy && toolSearch === 'default') {
    throw new UsageError('--proxy requires --tool-search on or off: the local proxy is not a first-party host and silently disables default tool search');
  }
  const turns = values.get('--turns') ?? '1';
  if (turns !== '1' && turns !== '2') throw new UsageError('--turns must be 1 or 2');
  const baseUrl = values.get('--base-url');
  if (baseUrl) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new UsageError('--base-url must be an HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new UsageError('--base-url must be HTTP(S) without embedded credentials');
    }
  }
  if (values.has('--auth-token') && values.has('--api-key')) throw new UsageError('Choose --auth-token or --api-key');
  const tenantSet = values.get('--tenant-tools') ?? 'none';
  if (!(CAPTURE_TENANT_SET_IDS as readonly string[]).includes(tenantSet)) {
    throw new UsageError(`--tenant-tools must be one of ${CAPTURE_TENANT_SET_IDS.join(', ')}`);
  }
  const tenantCountRaw = values.get('--tenant-count');
  const tenantCount = tenantCountRaw === undefined ? undefined : Number(tenantCountRaw);
  if (tenantCount !== undefined
    && (!/^\d+$/.test(tenantCountRaw!) || tenantCount > MAX_CAPTURE_TENANT_TOOLS || tenantSet === 'none')) {
    throw new UsageError(`--tenant-count must be an integer from 0 to ${MAX_CAPTURE_TENANT_TOOLS} and needs --tenant-tools a or b`);
  }
  if (tenantSet !== 'none' && surface !== 'chat') {
    throw new UsageError('--tenant-tools needs --surface chat (not all): no other surface resolves tenant tools');
  }
  return { values, surface, toolSearch, turns: Number(turns), proxy, baseUrl, tenantSet: tenantSet as CaptureTenantSetId, tenantCount };
}

async function main(): Promise<void> {
  let proxy: CaptureProxy | undefined;
  try {
    const args = parseArgs(process.argv.slice(2));
    const resolved = platformLlmConfig();
    const env = buildClaudeSdkChildEnv(resolved);
    if (args.baseUrl) env.ANTHROPIC_BASE_URL = args.baseUrl;
    const authToken = args.values.get('--auth-token');
    const apiKey = args.values.get('--api-key');
    if (authToken || apiKey) {
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.ANTHROPIC_API_KEY;
      if (authToken) env.ANTHROPIC_AUTH_TOKEN = authToken;
      if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    }
    // The production policy (runSurface → aiToolSearchPolicy) owns
    // ENABLE_TOOL_SEARCH; --tool-search stands in for the AI_TOOL_SEARCH
    // override. The local proxy is a non-first-party host, so a proxy run
    // needs `on` to search — the same rule a self-host gateway follows.
    delete env.ENABLE_TOOL_SEARCH;
    const toolSearchOverride = args.toolSearch === 'default' ? 'auto' : args.toolSearch as 'on' | 'off';
    const upstreamHost = new URL(env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').host;
    if (args.proxy) {
      proxy = await startCaptureProxy(env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com');
      env.ANTHROPIC_BASE_URL = proxy.url;
    }
    const surfaces = args.surface === 'all' ? Object.values(CAPTURE_SURFACES) : [CAPTURE_SURFACES[args.surface as CaptureSurfaceId]];
    const model = args.values.get('--model') ?? resolveDefaultModel();
    const out = args.values.get('--out') ?? 'tool-capture.jsonl';
    const rows: Record<string, string | number | null>[] = [];
    const tenantTools = captureTenantDescriptors(args.tenantSet, args.tenantCount);
    for (const surface of surfaces) {
      proxy?.setLabel(surface.id);
      let resume: string | undefined;
      for (let turn = 1; turn <= args.turns; turn++) {
        const requestStart = proxy?.records().length ?? 0;
        const result = await runSurfaceCapture({
          surface, model, env, resume, toolSearchOverride, tenantTools,
          prompt: turn === 1
            ? args.values.get('--prompt') ?? 'Which Windows devices in the fleet are offline right now?'
            : 'Thanks. And how many of those are servers?',
        });
        const { observation } = result;
        const proxyRequests = proxy?.records().slice(requestStart) ?? [];
        const label = args.baseUrl ? `byo:${upstreamHost}` : surface.id;
        await appendFile(out, JSON.stringify({
          at: new Date().toISOString(), ...result, turn,
          toolSearch: args.toolSearch, proxy: args.proxy, model,
          tenantSet: args.tenantSet, tenantToolCount: tenantTools.length,
          host: new URL(env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').host,
          label, upstreamHost, toolSearchForcedByProxy: args.proxy,
          systemPromptBytes: Buffer.byteLength(getCaptureSystemPrompt(surface), 'utf8'), proxyRequests,
        }) + '\n');
        const usage = observation.apiCalls.reduce((sum, call) => ({
          input: sum.input + call.inputTokens,
          create: sum.create + call.cacheCreationInputTokens,
          read: sum.read + call.cacheReadInputTokens,
        }), { input: 0, create: 0, read: 0 });
        // The proxy also captures the CLI's own /api/hello handshake and a
        // small Haiku title/summary call, both with tools: []. Prefer the
        // last request that actually carried tools (the real turn), falling
        // back to the last request if none did — see the baseline doc's
        // "trap found while running this task" note.
        const toolBearingRequest = [...proxyRequests].reverse().find((r) => r.tools.length > 0)
          ?? proxyRequests.at(-1);
        rows.push({
          surface: args.baseUrl ? `${label}/${surface.id}` : surface.id, turn,
          tenant: args.tenantSet === 'none' ? 0 : `${args.tenantSet}:${tenantTools.length}`,
          'tools sent': toolBearingRequest?.tools.length ?? null,
          deferred: toolBearingRequest?.tools.filter((tool) => tool.deferLoading).length ?? null,
          input: usage.input, cache_create: usage.create, cache_read: usage.read,
          'ttft ms': observation.ttftMs,
          'ToolSearch seen': `uses=${observation.toolSearchUses}, blocks=${observation.toolSearchResultBlocks}, refs=${observation.toolReferenceNames.length}, stderr=${observation.stderrToolSearchLines.length}`,
          'first tool': observation.toolUses[0]?.name ?? null,
          'result subtype': observation.result?.subtype ?? null,
        });
        if (turn < args.turns) {
          if (!observation.sessionId) {
            // Deny mode routinely ends a turn with a non-success result
            // subtype (e.g. `error_max_turns` — every tool call is refused,
            // so the model has nothing left to try). That is an EXPECTED
            // ending, not a harness failure: the row above is already
            // written, so stop resuming this surface and move on instead of
            // failing the whole run.
            console.error(`tool-capture: ${surface.id} turn ${turn} ended (result subtype=${observation.result?.subtype ?? 'unknown'}) with no session id to resume; skipping remaining turns for this surface.`);
            break;
          }
          resume = observation.sessionId;
        }
      }
    }
    console.table(rows);
  } finally {
    try { await proxy?.close(); } finally { await closeDb(); }
  }
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Tool capture failed');
  process.exit(error instanceof UsageError ? 2 : 1);
});
