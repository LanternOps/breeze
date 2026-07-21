/**
 * TEST-ONLY shared logic for the AI guardrail tier-parity contract tests
 * (issue #2686). Not imported by any runtime code path.
 *
 * Two hand-maintained surfaces mirror the tier tables in aiGuardrails.ts:
 *   • apps/web/src/components/ai-risk/tierConfig.ts  — the in-product tier
 *     explainer an MSP shows a customer (aiGuardrailsTierConfig.parity.test.ts)
 *   • apps/docs/src/content/docs/features/ai.mdx     — the published docs
 *     (aiGuardrailsAiDocs.parity.test.ts)
 *
 * Both express the same claim ("this tool/action is Tier N"), so the parsing of
 * a `tool (action/action)` label and the comparison against checkGuardrails
 * live here once rather than being copied per surface.
 */
import { checkGuardrails } from './aiGuardrails';
import { TOOL_TIERS } from './aiAgentSdkTools';

/** A tier claim made by a mirror surface, ready to be checked. */
export interface ClaimedTierEntry {
  /** The tier the surface says this tool/action runs at. */
  claimedTier: number;
  /** Verbatim source text, quoted back in failure output. */
  label: string;
  /** Guardrail tool key. */
  tool: string;
  /** Guardrail action identifiers; empty means "the tool with no action". */
  actions: string[];
  /** Optional locator (file + line) for failure output. */
  where?: string;
}

/**
 * A tool label is either `tool_name` or `tool_name (action/action/...)`, using
 * REAL guardrail action identifiers. Prose inside the parentheses
 * ("add/remove devices", "acknowledge/resolve actions") deliberately does NOT
 * match: an unreadable label must fail loudly, because a label the guard cannot
 * parse is a label it is not guarding.
 */
const TOOL_LABEL_RE = /^(?<tool>[a-z0-9_]+)(?: \((?<actions>[a-z0-9_/]+)\))?$/;

export interface ParsedToolLabel {
  tool: string;
  actions: string[];
}

/** Returns null when the label is not machine-checkable. */
export function parseToolLabel(label: string): ParsedToolLabel | null {
  const m = TOOL_LABEL_RE.exec(label.trim());
  if (!m?.groups) return null;
  return {
    tool: m.groups.tool!,
    actions: m.groups.actions ? m.groups.actions.split('/') : [],
  };
}

/**
 * checkGuardrails only knows tools registered in the `aiTools` registry. A
 * handful of assistant-only tools live solely in the Claude-Agent-SDK tool map
 * (`TOOL_TIERS` in aiAgentSdkTools.ts) — `propose_action_plan` is one — and
 * come back as Tier 4 "Unknown tool". Those are real, documented tools, so fall
 * back to their SDK tier rather than reporting a false drift. Anything neither
 * registry knows stays Tier 4 and IS reported: documenting a tool that does not
 * exist is drift too.
 */
function resolveTier(tool: string, input: Record<string, unknown>): { tier: number; reason?: string } {
  const result = checkGuardrails(tool, input);
  if (result.reason?.startsWith('Unknown tool')) {
    const sdkTier = (TOOL_TIERS as Record<string, number>)[tool];
    if (sdkTier !== undefined) return { tier: sdkTier };
  }
  return result;
}

/**
 * Resolve every claim through checkGuardrails and return one human-readable
 * message per mismatch (empty array = the surface agrees with the tables).
 */
export function findTierMismatches(entries: ClaimedTierEntry[]): string[] {
  const mismatches: string[] = [];

  for (const entry of entries) {
    const inputs: Array<Record<string, unknown>> = entry.actions.length > 0
      ? entry.actions.map((action) => ({ action }))
      : [{}];

    for (const input of inputs) {
      const action = input.action as string | undefined;
      const actual = resolveTier(entry.tool, input);
      if (actual.tier === entry.claimedTier) continue;
      mismatches.push(
        `${entry.tool}${action ? ` (action="${action}")` : ' (no action)'}: ` +
        `claims Tier ${entry.claimedTier}, checkGuardrails returns Tier ${actual.tier}` +
        `${actual.reason ? ` — ${actual.reason}` : ''} ` +
        `[${entry.where ? `${entry.where} ` : ''}entry "${entry.label}"]`,
      );
    }
  }

  return mismatches;
}

/** Consistent failure banner for both suites. */
export function driftMessage(surface: string, mismatches: string[]): string {
  return (
    `${surface} has drifted from the guardrail tables in ` +
    `apps/api/src/services/aiGuardrails.ts. These are customer-facing claims ` +
    `about what the AI may do without approval — fix the mirror (or the tier ` +
    `tables), do not relax this test.\n` +
    mismatches.map((m) => `  • ${m}`).join('\n')
  );
}
