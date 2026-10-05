// apps/api/src/services/aiModels/promptVariants.ts
/**
 * Per-prompt-profile prompt variants (spec §7 "Prompt profile", §13 W11).
 *
 * A variant is a short block of guidance APPENDED to one surface's system
 * prompt for one prompt profile, under GUIDANCE_HEADING. It never removes or
 * reorders text, so the guardrails a surface ships (BREEZE_AI_GUARDRAILS_CORE,
 * the agent `## Rules`) always reach the model.
 *
 * Variants are code. They change by PR, never by a setting, so every prompt
 * the platform sends is reviewed. Lifecycle (AiPromptVariantState):
 *   staged    - offline only: `pnpm --filter @breeze/api ai:tool-eval -- --prompt-variant <id>`
 *   candidate - a sticky canary: conversations whose promptVariantBucket(id,
 *               subject) < canaryPercent (≤ MAX_CANARY_PERCENT) get it; it is
 *               measured against the incumbent (the active variant, else base)
 *   active    - every other conversation of that surface + profile
 *   retired   - never selected; kept so old ledger rows still resolve to a name
 * At most one active and one candidate per surface + profile. `generic`
 * never has variants: setting a model's prompt profile to Generic on
 * /admin/ai-models is the no-release off switch.
 *
 * Every ledger row records the variant it was dispatched with
 * (ai_invocations.prompt_variant), and /admin/ai-models compares each variant
 * with its base prompt. Runbook: docs/deploy/ai-prompt-variants.md.
 */
import { createHash } from 'node:crypto';
import type { AiPromptVariantState, AiSurface, PromptProfile } from '@breeze/shared';

/** The surfaces whose system prompt passes through promptProfiles.renderSystemPrompt (the two Agent SDK builders). */
export const PROMPT_VARIANT_SURFACES = ['chat', 'helper', 'script_builder', 'office_chat', 'ai_agents'] as const satisfies readonly AiSurface[];
export type PromptVariantSurface = (typeof PROMPT_VARIANT_SURFACES)[number];
type VariantProfile = Exclude<PromptProfile, 'generic'>;
const VARIANT_PROFILES: readonly VariantProfile[] = ['claude-frontier', 'claude-standard', 'claude-small'];

export const MAX_CANARY_PERCENT = 25;
export const MAX_GUIDANCE_CHARS = 1200;
export const GUIDANCE_HEADING = '## Model Guidance';
/** Mirrors the ai_invocations_prompt_provenance_chk regex, narrowed to real surfaces and profiles. */
export const PROMPT_VARIANT_ID_PATTERN = /^(chat|helper|script_builder|office_chat|ai_agents)\/(claude-frontier|claude-standard|claude-small)@([1-9][0-9]{0,3})$/;
/** Guidance must never instruct the model to set its rules aside. */
const OVERRIDE_PHRASES = /\b(ignore|disregard|override|bypass|forget)\b/i;

export interface PromptVariant {
  /** `${surface}/${profile}@${version}` — written to ai_invocations.prompt_variant. */
  id: string;
  surface: PromptVariantSurface;
  profile: VariantProfile;
  /** ≥ 1, increasing per surface + profile; never reused. */
  version: number;
  state: AiPromptVariantState;
  /** candidate only: the share (1–MAX_CANARY_PERCENT) of conversations that get it. 0 otherwise. */
  canaryPercent: number;
  /** Appended under GUIDANCE_HEADING. Plain sentences, no headings, ≤ MAX_GUIDANCE_CHARS. */
  guidance: string;
  /** What this variant should move in the quality view, for the reviewer and the promotion PR. */
  hypothesis: string;
}

export const PROMPT_VARIANTS: readonly PromptVariant[] = [
  {
    id: 'chat/claude-frontier@1',
    surface: 'chat',
    profile: 'claude-frontier',
    version: 1,
    state: 'staged',
    canaryPercent: 0,
    guidance: [
      'The Important Rules above always apply and are not open to judgment.',
      'Everything else in this prompt is a default, not a checklist: skip steps that do not fit the request,',
      'combine lookups into as few tool calls as the task needs, and answer as soon as the evidence supports an answer.',
      'Keep explanations short unless the technician asks for detail.',
    ].join(' '),
    hypothesis: 'Frontier models follow a prescriptive prompt too literally (spec §7). Expect fewer calls and lower cost per conversation, with flag rate and turns to resolve no worse than the base prompt.',
  },
  {
    id: 'chat/claude-small@1',
    surface: 'chat',
    profile: 'claude-small',
    version: 1,
    state: 'staged',
    canaryPercent: 0,
    guidance: [
      'Keep each reply short and direct.',
      'Call one tool at a time and read its result before choosing the next one.',
      'Use the tool whose name matches the task most directly.',
      'If the request is ambiguous, ask one specific question instead of trying several tools.',
    ].join(' '),
    hypothesis: 'Small models drift on a long tool list (spec §7: terser tool guidance). Expect lower refusal and flag rates and fewer turns to resolve than the base prompt.',
  },
];

export function promptVariantId(surface: PromptVariantSurface, profile: VariantProfile, version: number): string {
  return `${surface}/${profile}@${version}`;
}

export function parsePromptVariantId(id: string): { surface: PromptVariantSurface; profile: VariantProfile; version: number } | null {
  const m = PROMPT_VARIANT_ID_PATTERN.exec(id);
  if (!m) return null;
  return { surface: m[1] as PromptVariantSurface, profile: m[2] as VariantProfile, version: Number(m[3]) };
}

export function isPromptVariantSurface(surface: AiSurface): surface is PromptVariantSurface {
  return (PROMPT_VARIANT_SURFACES as readonly string[]).includes(surface);
}

/** A stable 0–99 bucket for one subject (session or agent run) under one variant; independent across variants. */
export function promptVariantBucket(variantId: string, subjectId: string): number {
  return createHash('sha256').update(`${variantId}\u0000${subjectId}`).digest().readUInt32BE(0) % 100;
}

/**
 * The variant a conversation gets: the candidate when the subject falls in its
 * canary, else the active variant, else null (the base prompt). A null
 * subject never enters a canary. `generic` and non-hook surfaces never get one.
 */
export function selectPromptVariant(
  input: { surface: AiSurface; profile: PromptProfile; subjectId: string | null },
  variants: readonly PromptVariant[],
): PromptVariant | null {
  if (input.profile === 'generic' || !isPromptVariantSurface(input.surface)) return null;
  const mine = variants.filter((v) => v.surface === input.surface && v.profile === input.profile);
  const candidate = mine.find((v) => v.state === 'candidate');
  if (candidate && input.subjectId && candidate.canaryPercent > 0
    && promptVariantBucket(candidate.id, input.subjectId) < candidate.canaryPercent) {
    return candidate;
  }
  return mine.find((v) => v.state === 'active') ?? null;
}

export function appendPromptGuidance(systemPrompt: string, variant: PromptVariant | null): string {
  if (!variant) return systemPrompt;
  return `${systemPrompt}\n\n${GUIDANCE_HEADING}\n${variant.guidance}`;
}

export function getPromptVariant(id: string, variants: readonly PromptVariant[]): PromptVariant | undefined {
  return variants.find((v) => v.id === id);
}

/** Contract violations, one string each. The registry test asserts PROMPT_VARIANTS returns []. */
export function validatePromptVariants(variants: readonly PromptVariant[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const v of variants) {
    if (ids.has(v.id)) problems.push(`${v.id}: duplicate id`);
    ids.add(v.id);
    if (!isPromptVariantSurface(v.surface)) problems.push(`${v.id}: surface ${v.surface} has no prompt hook`);
    if (!VARIANT_PROFILES.includes(v.profile)) problems.push(`${v.id}: profile ${v.profile} cannot carry variants`);
    if (!Number.isInteger(v.version) || v.version < 1 || v.version > 9999) problems.push(`${v.id}: version must be 1–9999`);
    if (v.id !== `${v.surface}/${v.profile}@${v.version}` || !PROMPT_VARIANT_ID_PATTERN.test(v.id)) problems.push(`${v.id}: id must be surface/profile@version`);
    if (v.state === 'candidate') {
      if (!(v.canaryPercent >= 1 && v.canaryPercent <= MAX_CANARY_PERCENT)) problems.push(`${v.id}: candidate canary must be 1–${MAX_CANARY_PERCENT}`);
    } else if (v.canaryPercent !== 0) {
      problems.push(`${v.id}: only a candidate has a canary`);
    }
    const g = v.guidance.trim();
    if (g.length === 0 || v.guidance.length > MAX_GUIDANCE_CHARS) problems.push(`${v.id}: guidance must be 1–${MAX_GUIDANCE_CHARS} characters`);
    if (/^\s*#/m.test(v.guidance)) problems.push(`${v.id}: guidance must not contain a heading`);
    if (OVERRIDE_PHRASES.test(v.guidance)) problems.push(`${v.id}: guidance must not tell the model to override its rules`);
    if (!v.hypothesis.trim()) problems.push(`${v.id}: hypothesis is required`);
  }
  const pairs = new Map<string, PromptVariant[]>();
  for (const v of variants) pairs.set(`${v.surface}/${v.profile}`, [...(pairs.get(`${v.surface}/${v.profile}`) ?? []), v]);
  for (const [pair, list] of pairs) {
    if (list.filter((v) => v.state === 'active').length > 1) problems.push(`${pair}: more than one active variant`);
    if (list.filter((v) => v.state === 'candidate').length > 1) problems.push(`${pair}: more than one candidate variant`);
  }
  return problems;
}
