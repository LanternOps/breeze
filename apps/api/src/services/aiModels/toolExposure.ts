/**
 * The tool exposure a surface gives one model (#11393 W01, spec
 * 2026-11-06-small-model-tool-profiles §3.2). Pure: no IO.
 *
 * Contract:
 *  - It only REMOVES. `names` is always a subset of the surface's own set
 *    (`surfaceBaseSet`); `null` means "unchanged" (the identity exposure).
 *  - It is EXPOSURE, never authority: it never feeds
 *    `guardrailPolicy.toolAllowlist`, RBAC, approvals or the Wisp gate.
 *  - `full` (and `auto` with an unknown window or unmeasured prefixes) is the
 *    identity: names null, every extra tool kept, standard prompt, tool search
 *    allowed, 8,000-char results, fingerprint `FULL_IDENTITY_FINGERPRINT`, so
 *    a surface's registration, prompt and live-query key stay byte-identical.
 *  - The input carries no page context: the exposure (and the live-query key
 *    it feeds) must not churn as the user moves between pages.
 */
import { createHash } from 'node:crypto';
import type { AiAgentRunProfile, AiApprovalMode, AiSurface, AiToolDomain, AiToolProfile } from '@breeze/shared';
import { CONTEXT_MIN_OUTPUT_TOKENS } from './gateway/openai/contextWindow';
import { getToolDomain } from '../aiTools';
import { FULL_IDENTITY_FINGERPRINT, type ToolProfileFacts } from './toolProfileFacts';
import {
  CURATED_PROFILES,
  PROFILE_PREFIX_TOKENS,
  isProfiledSurface,
  type ProfilePrefixTokens,
} from './toolProfiles';

export { DEFAULT_TOOL_PROFILE_FACTS, type ToolProfileFacts } from './toolProfileFacts';

export interface ExtraToolInput {
  /** The name as registered (an MCP-qualified name for tenant tools, the bare name for outcome/flow tools). */
  name: string;
  /** Tenant (BYO MCP) tools count as `integrations`, flow tools as `scripts` (plan Decision 4); null = no domain. */
  domain: AiToolDomain | null;
  /** Survives every profile (a run's outcome tools). */
  alwaysKeep?: boolean;
}

export interface ToolExposureInput {
  surface: AiSurface;
  runProfile?: AiAgentRunProfile;
  facts: ToolProfileFacts;
  /** Bare names the surface registers today, in its own order. */
  surfaceBaseSet: readonly string[];
  extraTools: readonly ExtraToolInput[];
  approvalMode?: AiApprovalMode;
}

/** The complete set of input keys. Adding one (a page key, say) is a reviewed contract change. */
export const TOOL_EXPOSURE_INPUT_KEYS: ReadonlySet<string> = new Set([
  'surface', 'runProfile', 'facts', 'surfaceBaseSet', 'extraTools', 'approvalMode',
]);

export type ResolvedToolProfile = Exclude<AiToolProfile, 'auto'>;

export interface ToolExposure {
  profile: ResolvedToolProfile;
  /** Bare names to register, a subset of the surface's set; null = unchanged. */
  names: string[] | null;
  /** Extra tools kept, in input order. */
  extraToolNames: string[];
  promptMode: 'standard' | 'constrained';
  toolSearchAllowed: boolean;
  /** Strip size/format keywords from the advertised upstream schemas (gateway only, W03). */
  compactSchemas: boolean;
  resultCharBudget: number;
  fingerprint: string;
  /** `custom` tool names this surface does not register (shown as a warning, W05). */
  droppedCustomNames: string[];
  /** `auto` found no profile that fits the window; the session start refuses (W02). */
  tooSmall: boolean;
}

export const AUTO_FIT_FRACTION = 0.75;
/** Page / device context allowance inside the `auto` reserve, in tokens. */
export const PAGE_CONTEXT_RESERVE_TOKENS = 2000;
export const RESULT_CHAR_BUDGET = { minimal: 2000, standard: 4000, full: 8000, custom: 8000 } as const;
/** The fingerprint of the identity exposure (leaf module, shared with turnBinding). */
export { FULL_IDENTITY_FINGERPRINT };

const ALWAYS_KEEP: Readonly<Partial<Record<AiSurface, readonly string[]>>> = {
  chat: ['set_device_context'],
};
const PLAN_APPROVAL_MODES: ReadonlySet<AiApprovalMode> = new Set(['action_plan', 'hybrid_plan']);

function reserveTokens(profile: 'minimal' | 'standard' | 'full'): number {
  return CONTEXT_MIN_OUTPUT_TOKENS + Math.ceil((2 * RESULT_CHAR_BUDGET[profile]) / 3) + PAGE_CONTEXT_RESERVE_TOKENS;
}

/**
 * The largest profile whose measured prefix fits the window: prefix + reserve
 * (output allowance, two tool results at the profile's budget, page context)
 * within the window, AND the prefix itself within `AUTO_FIT_FRACTION` of it,
 * so the fixed part never crowds out the conversation. `minimal` is the
 * floor; below it, `too_small`. An unmeasured prefix (W03 has not pinned it)
 * answers `full`: nothing is constrained on a guess.
 */
export function pickAutoProfile(
  window: number,
  surface: AiSurface,
  prefixTokens: ProfilePrefixTokens = PROFILE_PREFIX_TOKENS,
): Exclude<AiToolProfile, 'auto' | 'custom'> | 'too_small' {
  if (!isProfiledSurface(surface)) return 'full';
  const prefixes = prefixTokens[surface];
  const order = ['full', 'standard', 'minimal'] as const;
  if (order.some((p) => prefixes[p] === null)) return 'full';
  for (const profile of order) {
    const prefix = prefixes[profile]!;
    if (prefix + reserveTokens(profile) <= window && prefix <= AUTO_FIT_FRACTION * window) return profile;
  }
  return 'too_small';
}

function identity(extraTools: readonly ExtraToolInput[]): ToolExposure {
  return {
    profile: 'full',
    names: null,
    extraToolNames: extraTools.map((t) => t.name),
    promptMode: 'standard',
    toolSearchAllowed: true,
    compactSchemas: false,
    resultCharBudget: RESULT_CHAR_BUDGET.full,
    fingerprint: FULL_IDENTITY_FINGERPRINT,
    droppedCustomNames: [],
    tooSmall: false,
  };
}

function fingerprintOf(names: readonly string[], extras: readonly string[], compactSchemas: boolean, promptMode: string): string {
  const payload = JSON.stringify({ n: [...names].sort(), x: [...extras].sort(), c: compactSchemas, p: promptMode });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function resolveToolExposure(
  input: ToolExposureInput,
  opts: { prefixTokens?: ProfilePrefixTokens } = {},
): ToolExposure {
  for (const key of Object.keys(input)) {
    if (!TOOL_EXPOSURE_INPUT_KEYS.has(key)) throw new Error(`resolveToolExposure: unexpected key: ${key}`);
  }
  const { surface, facts, surfaceBaseSet, extraTools, approvalMode } = input;
  if (!isProfiledSurface(surface)) return identity(extraTools);

  let profile: ResolvedToolProfile;
  let tooSmall = false;
  if (facts.toolProfile === 'auto') {
    if (facts.effectiveWindow === null) return identity(extraTools);
    const picked = pickAutoProfile(facts.effectiveWindow, surface, opts.prefixTokens);
    if (picked === 'too_small') {
      profile = 'minimal';
      tooSmall = true;
    } else {
      profile = picked;
    }
  } else {
    profile = facts.toolProfile;
  }
  if (profile === 'full') return identity(extraTools);

  const alwaysKeep = new Set(ALWAYS_KEEP[surface] ?? []);
  if (approvalMode && PLAN_APPROVAL_MODES.has(approvalMode)) alwaysKeep.add('propose_action_plan');

  let keepName: (name: string, domain: AiToolDomain | null | undefined) => boolean;
  let droppedCustomNames: string[] = [];
  if (profile === 'custom') {
    const domains = new Set<AiToolDomain>(facts.toolAllowlist?.domains ?? []);
    const tools = new Set(facts.toolAllowlist?.tools ?? []);
    keepName = (name, domain) => tools.has(name) || (domain != null && domains.has(domain));
    const known = new Set([...surfaceBaseSet, ...extraTools.map((t) => t.name)]);
    droppedCustomNames = [...tools].filter((n) => !known.has(n)).sort();
  } else {
    const curated = new Set(CURATED_PROFILES[surface][profile]);
    keepName = (name) => curated.has(name);
  }

  const names = surfaceBaseSet.filter((n) => alwaysKeep.has(n) || keepName(n, getToolDomain(n)));
  const extraToolNames = extraTools.filter((t) => t.alwaysKeep || keepName(t.name, t.domain)).map((t) => t.name);
  const compactSchemas = facts.transport === 'gateway';
  const promptMode = 'constrained';
  return {
    profile,
    names,
    extraToolNames,
    promptMode,
    toolSearchAllowed: false,
    compactSchemas,
    resultCharBudget: RESULT_CHAR_BUDGET[profile],
    fingerprint: fingerprintOf(names, extraToolNames, compactSchemas, promptMode),
    droppedCustomNames,
    tooSmall,
  };
}
