#!/usr/bin/env tsx
/**
 * Measure the external MCP server's tools/list in both modes (#12427 W01 T5).
 *
 * Two synthetic principals (unrestricted ai:read+write+execute; a core+devices
 * domain grant with ai:read+write) × `full` / `progressive`, every enable flag
 * on, built by the route's own list builder with tenant and flow tools off. No
 * database read and no tenant data. Tokens come from the Anthropic count-tokens
 * endpoint when ANTHROPIC_API_KEY is set (the list's JSON counted as one user
 * message), else bytes ÷ 3.5, labelled "estimate".
 *
 * Usage:
 *   DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/unused \
 *   pnpm --filter @breeze/api mcp:tools-list-measure -- [--out apps/api/mcp-tools-list.jsonl]
 */
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { McpToolListMode } from '../../mcpToolListMode';

export type MeasurePrincipal = 'unrestricted' | 'core_devices';
export type MeasureRow = {
  principal: MeasurePrincipal;
  mode: McpToolListMode;
  toolCount: number;
  bytes: number;
  tokens: number;
  tokensSource: 'count_tokens' | 'estimate';
  /** The `initialize` / `server/discover` instructions for this principal and mode. */
  instructionsBytes: number;
};

/** Every flag that adds tools or changes the MCP surface. */
export const MEASURE_FLAGS: Readonly<Record<string, string>> = {
  M365_ENABLED: 'true',
  GOOGLE_WORKSPACE_ENABLED: 'true',
  BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'true',
  FLOWS_ENABLED: 'true',
  DELEGANT_BASE_URL: 'https://delegant.example.com',
  IS_HOSTED: 'true',
  BREEZE_AI_AGENTS_ENABLED: 'true',
  BREEZE_WISP_ENABLED: 'true',
  BREEZE_WORKSPACE_ENABLED: 'true',
  MCP_APPS_ENABLED: 'true',
  MCP_TIER3_INTENTS_ENABLED: 'true',
  MCP_TASKS_ENABLED: 'true',
};

const PRINCIPALS: ReadonlyArray<{ principal: MeasurePrincipal; scopes: string[]; mcpDomains: string[] | null }> = [
  { principal: 'unrestricted', scopes: ['ai:read', 'ai:write', 'ai:execute'], mcpDomains: null },
  { principal: 'core_devices', scopes: ['ai:read', 'ai:write'], mcpDomains: ['devices'] },
];

const bytesOf = (text: string) => Buffer.byteLength(text, 'utf8');
const estimate = (bytes: number) => Math.round(bytes / 3.5);

async function withFlags<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(MEASURE_FLAGS).map((key) => [key, process.env[key]]));
  Object.assign(process.env, MEASURE_FLAGS);
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function syntheticCaller(scopes: string[], mcpDomains: string[] | null) {
  const auth = {
    scope: 'organization', orgId: 'org-measure', partnerId: 'partner-measure', accessibleOrgIds: ['org-measure'],
    canAccessOrg: () => true, user: { id: 'user-measure' }, token: {},
    principal: { kind: 'api_key', id: 'key-measure', apiKeyId: 'key-measure' },
  } as never;
  const apiKey = { id: 'key-measure', orgId: 'org-measure', partnerId: 'partner-measure', scopes, mcpDomains } as never;
  return { auth, apiKey };
}

async function catalogFor(scopes: string[], mcpDomains: string[] | null) {
  const { buildToolsListEntries } = await import('../../../routes/mcpServer');
  const { NO_MCP_CLIENT_EXTENSIONS } = await import('../../mcpClientExtensions');
  return buildToolsListEntries({ scopes, ...syntheticCaller(scopes, mcpDomains), clientExtensions: NO_MCP_CLIENT_EXTENSIONS, dynamicTools: false });
}

export async function measure(opts: { countTokens?: (text: string) => Promise<number> }): Promise<MeasureRow[]> {
  const { presentProgressiveList, progressiveGuidanceFor } = await import('../../../routes/mcpServer');
  const { buildMcpServerInstructions } = await import('../../mcpGuidance');
  return withFlags(async () => {
    const rows: MeasureRow[] = [];
    for (const { principal, scopes, mcpDomains } of PRINCIPALS) {
      const { entries } = await catalogFor(scopes, mcpDomains);
      for (const mode of ['full', 'progressive'] as const) {
        const tools = mode === 'progressive' ? presentProgressiveList(entries) : entries;
        const text = JSON.stringify({ tools });
        const bytes = bytesOf(text);
        const instructions = buildMcpServerInstructions(true, mode === 'progressive' ? progressiveGuidanceFor(entries) : undefined);
        rows.push({
          principal,
          mode,
          toolCount: tools.length,
          bytes,
          tokens: opts.countTokens ? await opts.countTokens(text) : estimate(bytes),
          tokensSource: opts.countTokens ? 'count_tokens' : 'estimate',
          instructionsBytes: bytesOf(instructions),
        });
      }
    }
    return rows;
  });
}

/** One search_tools result (8 rows) and one get_tool_details result (1 tool), unrestricted principal. */
export async function measureMetaToolResults(): Promise<{ searchRows: number; searchBytes: number; detailsBytes: number }> {
  const { handleGetToolDetails, handleSearchTools } = await import('../../mcpMetaTools');
  return withFlags(async () => {
    const { scopes, mcpDomains } = PRINCIPALS[0]!;
    const { entries, approvalNotes } = await catalogFor(scopes, mcpDomains);
    const search = handleSearchTools(entries, { query: 'which windows devices are offline' }, approvalNotes);
    const details = handleGetToolDetails(entries, { names: ['query_devices'] });
    if (!('result' in search) || !('result' in details)) throw new Error('meta-tool measurement failed');
    return {
      searchRows: (search.result.structuredContent as { tools: unknown[] }).tools.length,
      searchBytes: bytesOf(JSON.stringify(search.result)),
      detailsBytes: bytesOf(JSON.stringify(details.result)),
    };
  });
}

async function anthropicCounter(): Promise<((text: string) => Promise<number>) | undefined> {
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  const [{ default: Anthropic }, { resolveDefaultModel }] = await Promise.all([import('@anthropic-ai/sdk'), import('../../aiModel')]);
  const client = new Anthropic();
  const model = resolveDefaultModel();
  return async (text) => (await client.messages.countTokens({ model, messages: [{ role: 'user', content: text }] })).input_tokens;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (outIndex >= 0 && !out) throw new Error('--out needs a path');
  const rows = await measure({ countTokens: await anthropicCounter() });
  const meta = await measureMetaToolResults();
  console.table(rows);
  console.table([meta]);
  if (out) {
    const measuredAt = new Date().toISOString();
    await appendFile(out, rows.map((row) => JSON.stringify({ measuredAt, ...row })).join('\n') + `\n${JSON.stringify({ measuredAt, ...meta })}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(async () => {
      const { closeDb } = await import('../../../db');
      await closeDb();
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'MCP tools/list measurement failed');
      process.exit(1);
    });
}
