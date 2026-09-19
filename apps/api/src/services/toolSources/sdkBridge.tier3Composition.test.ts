/**
 * Tool catalog W01 PR B (#5216) — the COMPOSITION that only became reachable
 * in this PR: a Tier-3 external tool whose approval succeeds must actually
 * reach `executeTenantToolDetailed`, and one whose approval is refused must
 * not.
 *
 * Before PR B, `createSessionPreToolUse` denied every tier-3 tenant tool
 * outright, so `wrapExtraToolWithHooks(buildTenantSdkTools(...)[0], gate)` was
 * a composition nothing could traverse. Each half is covered in its own suite
 * (`aiAgentSdk.test.ts` for the gate's decision, `sdkBridge.test.ts` for the
 * handler); this pins them TOGETHER, because the handler dispatches through
 * the descriptor the SESSION captured, and the only thing standing between an
 * un-approved external call and the customer's system is the gate returning
 * `allowed: false` first.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeTenantToolDetailed = vi.hoisted(() => vi.fn());
vi.mock('./execute', () => ({ executeTenantToolDetailed }));

import { buildTenantSdkTools } from './sdkBridge';
import { wrapExtraToolWithHooks } from '../aiAgentSdkTools';
import type { TenantToolDescriptor } from './resolver';

const auth = {
  scope: 'organization',
  orgId: 'org-1',
  accessibleOrgIds: ['org-1'],
  partnerId: 'partner-1',
  user: { id: 'user-1' },
} as never;

const descriptor = {
  id: 'tool-3',
  sourceId: 'source-1',
  sourceName: 'Hudu',
  sourceKind: 'mcp',
  ownerRef: { orgId: 'org-1', partnerId: null },
  qualifiedName: 'hudu__create_asset',
  name: 'create_asset',
  description: 'Create an asset',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  tier: 3,
  revision: 'rev-7',
  rateLimitPerMinute: 60,
  validate: () => ({ success: true as const }),
  definition: { name: 'hudu__create_asset', description: 'Create an asset', input_schema: { type: 'object' } },
} satisfies TenantToolDescriptor;

function wrapWithGate(gate: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  const [sdkTool] = buildTenantSdkTools([descriptor], () => auth, () => 'org-1');
  return wrapExtraToolWithHooks(sdkTool!, gate as never);
}

describe('tier-3 external tool: gate + sdkBridge composition (#5216 PR B)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dispatches the external call once the intent gate allows it', async () => {
    executeTenantToolDetailed.mockResolvedValueOnce({ isError: false, text: '{"id":"asset-9"}' });
    const gate = vi.fn(async () => ({ allowed: true as const, intentId: 'intent-1' }));

    const result = await wrapWithGate(gate).handler({ name: 'Printer 3' }, {});

    expect(gate).toHaveBeenCalledWith('hudu__create_asset', { name: 'Printer 3' });
    expect(executeTenantToolDetailed).toHaveBeenCalledWith(
      descriptor,
      { name: 'Printer 3' },
      auth,
      { surface: 'chat', orgId: 'org-1' },
    );
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  it('never dispatches when the gate refuses (rejected / expired approval)', async () => {
    const gate = vi.fn(async () => ({
      allowed: false as const,
      error: 'Tool execution was rejected, cancelled, or expired',
    }));

    const result = await wrapWithGate(gate).handler({ name: 'Printer 3' }, {});

    expect(executeTenantToolDetailed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
  });

  it("surfaces the executor's failure as isError rather than a silent success", async () => {
    executeTenantToolDetailed.mockResolvedValueOnce({ isError: true, text: 'MCP call failed: 502' });
    const gate = vi.fn(async () => ({ allowed: true as const }));

    const result = await wrapWithGate(gate).handler({ name: 'Printer 3' }, {});

    expect(result).toMatchObject({ isError: true });
  });
});
