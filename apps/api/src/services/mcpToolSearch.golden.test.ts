/**
 * #12427 W01 T4 golden gate: search_tools finds an acceptable tool for the
 * chat golden prompts.
 *
 * Denominator: every GOLDEN_CASES entry on the chat surface whose first
 * expected tool is in the unrestricted synthetic principal's `full` catalog
 * (built by the route's own list builder). Hit: any expected tool in the top 8.
 * Below the gate, tune the ranker, never the bar.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env', async (orig) => (await import('../routes/__tests__/mcpServerToolList.testHarness')).envMock(orig as never));
vi.mock('../middleware/apiKeyAuth', async () => (await import('../routes/__tests__/mcpServerToolList.testHarness')).apiKeyAuthMock());
vi.mock('../middleware/bearerTokenAuth', async () => (await import('../routes/__tests__/mcpServerToolList.testHarness')).bearerMock());
vi.mock('../db', async (orig) => (await import('../routes/__tests__/mcpServerToolList.testHarness')).dbMock(orig as never));
vi.mock('../services/permissions', async (orig) => (await import('../routes/__tests__/mcpServerToolList.testHarness')).permissionsMock(orig as never));
vi.mock('../services/aiTools', async (orig) => (await import('../routes/__tests__/mcpServerToolList.testHarness')).aiToolsMock(orig as never));
vi.mock('../services/aiGuardrails', async (orig) => (await import('../routes/__tests__/mcpServerToolList.testHarness')).guardrailsMock(orig as never));
vi.mock('../services/auditEvents', async () => (await import('../routes/__tests__/mcpServerToolList.testHarness')).auditMock());
vi.mock('../services/toolSources/resolver', async () => (await import('../routes/__tests__/mcpServerToolList.testHarness')).resolverMock());
vi.mock('../services/flows/mcpFlowTools', async () => (await import('../routes/__tests__/mcpServerToolList.testHarness')).flowToolsMock());
vi.mock('../routes/mcpExecutionOrg', async () => (await import('../routes/__tests__/mcpServerToolList.testHarness')).executionOrgMock());
vi.mock('../services/redis', async () => (await import('../routes/__tests__/mcpServerToolList.testHarness')).redisMock());
vi.mock('../services/mcpToolExecutionLedger', async () => (await import('../routes/__tests__/mcpServerToolList.testHarness')).ledgerMock());
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../modules/mcpInvites', () => ({ initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }) }));

import { buildToolsListEntries } from '../routes/mcpServer';
import { harnessState, resetHarnessState, UNRESTRICTED_KEY } from '../routes/__tests__/mcpServerToolList.testHarness';
import { NO_MCP_CLIENT_EXTENSIONS } from './mcpClientExtensions';
import { GOLDEN_CASES } from './llm/toolEval/goldenPrompts';
import { getToolSearchHint } from './aiTools';
import { rankTools, type RankableTool } from './mcpToolSearch';

const SCOPES = ['ai:read', 'ai:write', 'ai:execute', 'ai:execute_admin'];
let catalog: RankableTool[] = [];

beforeAll(async () => {
  resetHarnessState();
  harnessState.realRegistry = true;
  vi.stubEnv('MCP_TIER3_INTENTS_ENABLED', 'true');
  const auth = {
    scope: 'organization', orgId: 'org-1', partnerId: 'partner-1', accessibleOrgIds: ['org-1'],
    canAccessOrg: () => true, user: { id: 'user-1' }, token: {}, principal: { kind: 'api_key', id: 'k', apiKeyId: 'k' },
  } as never;
  const { entries } = await buildToolsListEntries({
    scopes: SCOPES, auth, apiKey: { ...UNRESTRICTED_KEY, scopes: SCOPES } as never, clientExtensions: NO_MCP_CLIENT_EXTENSIONS, dynamicTools: false,
  });
  catalog = entries.map((e) => ({
    name: e.name, description: e.description, domain: String(e._meta['app.breeze/domain']), searchHint: getToolSearchHint(e.name),
  }));
});
afterAll(() => { vi.unstubAllEnvs(); });

describe('search_tools golden gate', () => {
  it('≥ 90% top-8 and ≥ 75% top-3 over the eligible chat golden cases', () => {
    const names = new Set(catalog.map((t) => t.name));
    expect(names.size).toBeGreaterThan(200);
    const eligible = GOLDEN_CASES.filter((c) => (c.surfaces === undefined || c.surfaces.includes('chat')) && names.has(c.expect[0]!.tool));
    expect(eligible.length).toBeGreaterThan(100);
    const misses8: string[] = [];
    let top3 = 0;
    for (const c of eligible) {
      const ranked = rankTools(catalog, c.prompt);
      const wanted = new Set(c.expect.map((e) => e.tool));
      if (ranked.slice(0, 3).some((n) => wanted.has(n))) top3 += 1;
      if (!ranked.slice(0, 8).some((n) => wanted.has(n))) misses8.push(`${c.id} "${c.prompt}" want ${[...wanted].join('|')} got ${ranked.slice(0, 5).join(',')}`);
    }
    const top8Rate = (eligible.length - misses8.length) / eligible.length;
    const top3Rate = top3 / eligible.length;
    console.info(`[search_tools golden] eligible=${eligible.length} top8=${top8Rate.toFixed(3)} top3=${top3Rate.toFixed(3)}\n${misses8.join('\n')}`);
    expect(top8Rate, misses8.join('\n')).toBeGreaterThanOrEqual(0.9);
    expect(top3Rate).toBeGreaterThanOrEqual(0.75);
  });
});
