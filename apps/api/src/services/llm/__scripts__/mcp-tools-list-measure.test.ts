/**
 * #12427 W01 T5: the tools/list measurement. No database and no network: the
 * test never passes a token counter, so every row is an estimate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/env', async (orig) => (await import('../../../routes/mcpServerToolList.testHarness')).envMock(orig as never));
vi.mock('../../../middleware/apiKeyAuth', async () => (await import('../../../routes/mcpServerToolList.testHarness')).apiKeyAuthMock());
vi.mock('../../../middleware/bearerTokenAuth', async () => (await import('../../../routes/mcpServerToolList.testHarness')).bearerMock());
vi.mock('../../../db', async (orig) => (await import('../../../routes/mcpServerToolList.testHarness')).dbMock(orig as never));
vi.mock('../../../services/permissions', async (orig) => (await import('../../../routes/mcpServerToolList.testHarness')).permissionsMock(orig as never));
vi.mock('../../../services/aiTools', async (orig) => (await import('../../../routes/mcpServerToolList.testHarness')).aiToolsMock(orig as never));
vi.mock('../../../services/aiGuardrails', async (orig) => (await import('../../../routes/mcpServerToolList.testHarness')).guardrailsMock(orig as never));
vi.mock('../../../services/auditEvents', async () => (await import('../../../routes/mcpServerToolList.testHarness')).auditMock());
vi.mock('../../../services/toolSources/resolver', async () => (await import('../../../routes/mcpServerToolList.testHarness')).resolverMock());
vi.mock('../../../services/flows/mcpFlowTools', async () => (await import('../../../routes/mcpServerToolList.testHarness')).flowToolsMock());
vi.mock('../../../routes/mcpExecutionOrg', async () => (await import('../../../routes/mcpServerToolList.testHarness')).executionOrgMock());
vi.mock('../../../services/redis', async () => (await import('../../../routes/mcpServerToolList.testHarness')).redisMock());
vi.mock('../../../services/mcpToolExecutionLedger', async () => (await import('../../../routes/mcpServerToolList.testHarness')).ledgerMock());
vi.mock('../../../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../../../modules/mcpInvites', () => ({ initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }) }));

import { measure, measureMetaToolResults } from './mcp-tools-list-measure';
import { harnessState, resetHarnessState } from '../../../routes/mcpServerToolList.testHarness';

beforeEach(() => {
  resetHarnessState();
  // The real registry: the measurement is of the real list.
  harnessState.realRegistry = true;
});

afterEach(() => { vi.unstubAllEnvs(); });

// The first dynamic import of the route module (and the registry) is slow.
vi.setConfig({ testTimeout: 60_000 });

describe('measure()', () => {
  it('returns four rows (2 principals × 2 modes), estimated without a counter', async () => {
    const rows = await measure({});
    expect(rows.map((r) => `${r.principal}/${r.mode}`)).toEqual([
      'unrestricted/full', 'unrestricted/progressive', 'core_devices/full', 'core_devices/progressive',
    ]);
    for (const row of rows) {
      expect(row.toolCount).toBeGreaterThan(0);
      expect(row.bytes).toBeGreaterThan(0);
      expect(row.tokens).toBe(Math.round(row.bytes / 3.5));
      expect(row.tokensSource).toBe('estimate');
      expect(row.instructionsBytes).toBeGreaterThan(0);
    }
  });

  it('progressive is under 15% of full for the unrestricted principal', async () => {
    const rows = await measure({});
    const full = rows.find((r) => r.principal === 'unrestricted' && r.mode === 'full')!;
    const progressive = rows.find((r) => r.principal === 'unrestricted' && r.mode === 'progressive')!;
    expect(progressive.bytes).toBeLessThan(0.15 * full.bytes);
    expect(progressive.toolCount).toBeLessThan(25);
  });

  it('uses the counter when one is given', async () => {
    const counter = vi.fn(async (text: string) => text.length);
    const rows = await measure({ countTokens: counter });
    expect(rows.every((r) => r.tokensSource === 'count_tokens')).toBe(true);
    expect(counter).toHaveBeenCalledTimes(rows.length);
  });

  it('measures one search_tools result (8 rows) and one get_tool_details result (1 tool)', async () => {
    const meta = await measureMetaToolResults();
    expect(meta.searchRows).toBe(8);
    expect(meta.searchBytes).toBeGreaterThan(0);
    expect(meta.detailsBytes).toBeGreaterThan(0);
  });
});
