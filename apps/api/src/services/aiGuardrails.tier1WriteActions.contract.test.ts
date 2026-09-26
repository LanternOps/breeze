import { describe, expect, it } from 'vitest';
import { getAllRegisteredToolNames, getToolTier } from './aiTools';
import { toolActionEnum } from './aiToolActions';
import {
  checkGuardrails, isReadOnlyResolution, TIER1_NON_READONLY_TOOLS, TIER1_READ_ACTIONS,
  TIER2_ACTIONS, TIER2_READONLY_ACTIONS, TIER3_ACTIONS, TOOL_ACTION_INPUT_KEYS,
} from './aiGuardrails';

/**
 * Contract: every action of a registry-tier-1 multiplexer is CLASSIFIED,
 * spec 2026-09-23 W01-D3.
 *
 * Tier 1 means read-only to headless agents (`isReadOnlyResolution`), so an
 * action that is neither declared as a read (`TIER1_READ_ACTIONS`) nor
 * escalated (`TIER2_ACTIONS`/`TIER3_ACTIONS`) resolves to the tool's base
 * tier — 1 — and skips the agent allowlist entirely. A new enum member must
 * default to unclassified and fail CI, never to read.
 */

const tier1Multiplexers = () => getAllRegisteredToolNames()
  .filter((n) => getToolTier(n) === 1 && !TIER1_NON_READONLY_TOOLS.has(n) && toolActionEnum(n) !== null)
  .sort();

describe('tier-1 multiplexers: every write action is escalated (spec 2026-09-23 contract)', () => {
  // Quorum amendment WQ6: a tool named in TOOL_ACTION_INPUT_KEYS switches its
  // tier on a discriminator OTHER than `action` (execute_command:commandType).
  // If that discriminator has no resolvable enum, toolActionEnum() returns
  // null and tier1Multiplexers() silently drops the tool from every check
  // above — a free-string discriminator would escape classification entirely.
  it('every tool in TOOL_ACTION_INPUT_KEYS has a non-null toolActionEnum()', () => {
    const withoutEnum = Object.keys(TOOL_ACTION_INPUT_KEYS)
      .filter((tool) => toolActionEnum(tool) === null);
    expect(withoutEnum, 'A discriminator key with no resolvable enum lets any write escape the tier-1 write-action classification below.').toEqual([]);
  });
  it('every action is classified: TIER1_READ_ACTIONS, TIER2_ACTIONS or TIER3_ACTIONS (a new action defaults to unclassified)', () => {
    const unclassified = tier1Multiplexers().flatMap((tool) => toolActionEnum(tool)!
      .filter((a) => ![...(TIER1_READ_ACTIONS[tool] ?? []), ...(TIER2_ACTIONS[tool] ?? []), ...(TIER3_ACTIONS[tool] ?? [])].includes(a))
      .map((a) => `${tool}:${a}`));
    expect(unclassified, 'Classify the action. A read goes in TIER1_READ_ACTIONS; anything that changes state goes in TIER2_ACTIONS/TIER3_ACTIONS. Tier-1 means read-only to headless agents (isReadOnlyResolution), so an unescalated write skips the agent allowlist.').toEqual([]);
  });
  it('a declared read is never also escalated, and names a real action of a real tier-1 tool', () => {
    const bad = Object.entries(TIER1_READ_ACTIONS).flatMap(([tool, actions]) => actions.flatMap((a) => [
      ...(getToolTier(tool) !== 1 ? [`${tool}: not registry tier 1`] : []),
      ...(!(toolActionEnum(tool) ?? []).includes(a) ? [`${tool}:${a}: not in the action enum`] : []),
      ...([...(TIER2_ACTIONS[tool] ?? []), ...(TIER3_ACTIONS[tool] ?? [])].includes(a) ? [`${tool}:${a}: also escalated`] : []),
    ]));
    expect(bad).toEqual([]);
  });
  it('resolution: declared reads are read-only for agents; every other action is not (unless TIER2_READONLY_ACTIONS)', () => {
    const wrong = tier1Multiplexers().flatMap((tool) => toolActionEnum(tool)!.flatMap((a) => {
      const key = TOOL_ACTION_INPUT_KEYS[tool] ?? 'action';
      const ro = isReadOnlyResolution(tool, checkGuardrails(tool, { [key]: a }));
      const expected = (TIER1_READ_ACTIONS[tool] ?? []).includes(a) || (TIER2_READONLY_ACTIONS[tool] ?? []).includes(a);
      return ro === expected ? [] : [`${tool}:${a} readOnly=${ro}, expected ${expected}`];
    }));
    expect(wrong).toEqual([]);
  });
});
