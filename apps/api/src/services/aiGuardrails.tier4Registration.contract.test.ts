/**
 * #11989: a tool REGISTERED at base Tier 4 is refused, not returned as
 * approvable.
 *
 * Tier 4 means blocked (aiGuardrails.ts header). No core tool is registered at
 * Tier 4, but the extension SDK's `ExtensionAiTool.tier` admits `4`, so an
 * extension can register one. `checkGuardrails`' `baseTier === 4` arm used to
 * return `allowed: true, requiresApproval: true` for it, which sent the call
 * down each surface's approval path instead of refusing it.
 *
 * This file pins the guardrail itself and the agent gate. The two other
 * surfaces that consume the same verdict are pinned beside their harnesses,
 * which run the REAL checkGuardrails:
 *   - chat gate: aiAgentSdk.enforcementArmingGate.test.ts
 *   - MCP route: routes/mcpServer.effectiveTier.test.ts
 *
 * The tool is injected through the extension contribution registry — the one
 * path that can register a Tier-4 tool — so getToolTier stays real.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';
import { extensionContributionRegistry } from '../extensions/contributionRegistry';
import { getToolTier } from './aiTools';
import { checkAgentGuardrails, checkGuardrails, type AgentGuardrailPolicy } from './aiGuardrails';

const TIER4_TOOL = 'demo_ext_tier4_tool';
const TIER4_REASON = `Tool "${TIER4_TOOL}" is registered at Tier 4 and is not available`;

function registerTier4ExtensionTool(): void {
  const manifest: ExtensionManifestV1 = {
    apiVersion: 'breeze.extensions/v1',
    name: 'demo-tier4',
    version: '1.0.0',
    routeNamespace: 'demo-tier4',
    requires: { breeze: '>=1.0.0', serverSdk: '^1.0.0', capabilities: [] },
    server: { entry: 'dist/server.js' },
    migrationsDir: 'migrations',
    schemaCompatibilityFloor: '1.0.0',
    jobs: [],
    aiTools: [{ name: TIER4_TOOL }],
    tenancy: { orgCascadeDeleteTables: [], deviceCascadeDeleteTables: [], deviceOrgDenormalizedTables: [] },
  };
  const staging = extensionContributionRegistry.begin(manifest);
  staging.registrar.mountRoute(new Hono());
  staging.registrar.registerAiTool(TIER4_TOOL, {
    definition: { name: TIER4_TOOL, description: 'demo', input_schema: { type: 'object' } },
    tier: 4,
    handler: async () => 'ok',
  });
  extensionContributionRegistry.activate(staging.finish());
}

const POLICY = {
  enabled: true,
  mode: 'act' as const,
  // Allowlisted, so a refusal cannot be the allowlist's doing.
  toolAllowlist: [TIER4_TOOL],
  protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
  deviceSiteId: 'site-a',
  deviceId: 'dev-1',
} satisfies AgentGuardrailPolicy;

describe('#11989: a tool registered at base Tier 4 is refused', () => {
  beforeAll(() => {
    registerTier4ExtensionTool();
  });

  it('the seam is live: the real getToolTier answers 4 for the registered tool', () => {
    // Without this, every refusal below could be the "Unknown tool" arm.
    expect(getToolTier(TIER4_TOOL)).toBe(4);
  });

  it('checkGuardrails refuses it with the Tier-4 reason and no approval path', () => {
    expect(checkGuardrails(TIER4_TOOL, {})).toEqual({
      tier: 4,
      allowed: false,
      requiresApproval: false,
      reason: TIER4_REASON,
    });
  });

  describe('checkAgentGuardrails', () => {
    beforeEach(() => {
      vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('denies it with the guardrail reason, even when allowlisted in act mode', () => {
      const check = checkAgentGuardrails(TIER4_TOOL, {}, POLICY);
      expect(check).toMatchObject({
        allowed: false,
        requiresApproval: false,
        disposition: 'deny',
        reason: TIER4_REASON,
      });
    });
  });
});
