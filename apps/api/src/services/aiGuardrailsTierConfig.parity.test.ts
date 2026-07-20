/**
 * Contract test: the customer-facing AI guardrail tier explainer
 * (apps/web/src/components/ai-risk/tierConfig.ts) must agree with the real
 * guardrail tables in aiGuardrails.ts. Issue #2686.
 *
 * Why this test lives in @breeze/api and not @breeze/web:
 * resolving an entry's tier requires executing `checkGuardrails`, which reads
 * the TIER1/2/3 override tables AND the base tier of every tool from the
 * aiTools registry (`getToolTier`). That is a large slice of API internals —
 * db, redis and the whole tool registry — and is not importable from the web
 * jsdom suite. The web side of the contract, by contrast, is a single
 * dependency-free data module, so the cheap direction is to pull the web data
 * into the API suite. tierConfig.ts is deliberately kept free of runtime
 * imports (its icons are named strings resolved in TierOverviewMatrix.tsx) so
 * this relative import stays safe for both vitest and `tsc --noEmit` on
 * apps/api. Precedent for reaching outside the package in an API test:
 * apps/api/src/config/proxyTrustCompose.test.ts (reads root compose files).
 *
 * NOTE: no vi.mock here — unlike aiGuardrails.test.ts this suite must see the
 * REAL aiTools registry, because base tiers are half the answer.
 */
import { describe, expect, it } from 'vitest';

import {
  checkGuardrails,
  TIER1_ACTIONS,
  TIER2_ACTIONS,
  TIER3_ACTIONS,
} from './aiGuardrails';
import { RATE_LIMIT_CONFIGS, TIER_DEFINITIONS } from '../../../web/src/components/ai-risk/tierConfig';

/**
 * Entry names are either `tool_name` or `tool_name (action/action/...)`.
 * The action list must be real guardrail action identifiers — prose such as
 * `manage_groups (add/remove devices)` fails the shape check below rather than
 * silently degrading to a base-tier lookup that happens to pass.
 */
const ENTRY_RE = /^(?<tool>[a-z0-9_]+)(?: \((?<actions>[a-z0-9_/]+)\))?$/;

interface ParsedEntry {
  claimedTier: number;
  displayName: string;
  tool: string;
  actions: string[];
}

const parsed: ParsedEntry[] = [];
const unparseable: Array<{ tier: number; name: string }> = [];

for (const tier of TIER_DEFINITIONS) {
  // Tier 4 lists concepts ("Cross-org access", "Unknown tools"), not tools.
  if (tier.tier === 4) continue;
  for (const entry of tier.tools) {
    const m = ENTRY_RE.exec(entry.name);
    if (!m?.groups) {
      unparseable.push({ tier: tier.tier, name: entry.name });
      continue;
    }
    parsed.push({
      claimedTier: tier.tier,
      displayName: entry.name,
      tool: m.groups.tool!,
      actions: m.groups.actions ? m.groups.actions.split('/') : [],
    });
  }
}

describe('tierConfig.ts ↔ aiGuardrails tier tables parity (#2686)', () => {
  it('every Tier 1-3 entry is machine-checkable (`tool` or `tool (action/...)`)', () => {
    expect(unparseable).toEqual([]);
  });

  it('lists a non-trivial number of tool entries (guards against an empty sweep)', () => {
    expect(parsed.length).toBeGreaterThan(80);
    expect(parsed.some((e) => e.actions.length > 0)).toBe(true);
  });

  it('every tool/action pair resolves to the tier tierConfig.ts claims', () => {
    const mismatches: string[] = [];

    for (const entry of parsed) {
      const inputs = entry.actions.length > 0
        ? entry.actions.map((action) => ({ action }))
        : [{}];

      for (const input of inputs) {
        const action = (input as { action?: string }).action;
        const actual = checkGuardrails(entry.tool, input);
        if (actual.tier !== entry.claimedTier) {
          mismatches.push(
            `${entry.tool}${action ? ` (action="${action}")` : ' (no action)'}: ` +
            `tierConfig.ts claims Tier ${entry.claimedTier}, ` +
            `checkGuardrails returns Tier ${actual.tier}` +
            `${actual.reason ? ` — ${actual.reason}` : ''} ` +
            `[entry "${entry.displayName}"]`,
          );
        }
      }
    }

    expect(
      mismatches,
      `apps/web/src/components/ai-risk/tierConfig.ts has drifted from the ` +
      `guardrail tables in apps/api/src/services/aiGuardrails.ts. This is ` +
      `customer-facing copy explaining what the AI may do without approval — ` +
      `fix tierConfig.ts (or the tier tables), do not relax this test.\n` +
      mismatches.map((m) => `  • ${m}`).join('\n'),
    ).toEqual([]);
  });

  it('every RATE_LIMIT_CONFIGS row claims a tier the tool can actually resolve to', () => {
    // Same file, same failure mode: the rate-limit table carries a `tier` badge
    // rendered next to each tool in RateLimitStatus.tsx. Its `tier` is per-TOOL,
    // not per-action, so an action-multiplexed tool (file_operations is base
    // Tier 1 but every action escalates to Tier 3) legitimately advertises the
    // tier of its actions. Assert membership in the reachable set rather than
    // equality with the base tier.
    const reachableTiers = (tool: string): number[] => {
      const tiers = new Set<number>([checkGuardrails(tool, {}).tier]);
      if (TIER1_ACTIONS[tool]?.length) tiers.add(1);
      if (TIER2_ACTIONS[tool]?.length) tiers.add(2);
      if (TIER3_ACTIONS[tool]?.length) tiers.add(3);
      return [...tiers].sort();
    };

    const mismatches = RATE_LIMIT_CONFIGS
      .map((cfg) => ({ cfg, reachable: reachableTiers(cfg.toolName) }))
      .filter(({ cfg, reachable }) => !reachable.includes(cfg.tier))
      .map(({ cfg, reachable }) =>
        `${cfg.toolName}: RATE_LIMIT_CONFIGS claims Tier ${cfg.tier}, ` +
        `but the tool can only resolve to Tier ${reachable.join('/')}`,
      );

    expect(
      mismatches,
      `RATE_LIMIT_CONFIGS in apps/web/src/components/ai-risk/tierConfig.ts ` +
      `has drifted from the guardrail tiers:\n` +
      mismatches.map((m) => `  • ${m}`).join('\n'),
    ).toEqual([]);
  });
});
