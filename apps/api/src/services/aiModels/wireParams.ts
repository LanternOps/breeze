/**
 * AI model registry (spec §7): the ONLY place a thinking / effort / speed /
 * inference-geo request param is built (index invariant 2). Pure; no I/O.
 *
 * `buildWireParams` states what the Claude API should receive. The two
 * adapters spell that for a transport:
 * - `toAgentSdkOptions` for `query()`;
 * - `toMessagesApiParams` for raw `messages.create` one-shots.
 *
 * Neither adapter carries `display: 'updates'`, `speed` or `inferenceGeo`
 * yet. The W01 spike (docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-w01-spike-findings.md)
 * found, on Agent SDK 0.3.286:
 * - D1: the SDK CLI rejects `display: 'updates'`;
 * - D2: `speed: 'fast'` travels via `settings: { fastMode: true }`;
 * - D3: `inference_geo` travels only via `CLAUDE_CODE_EXTRA_BODY`, and the
 *   API accepts `us` / `global` but not `eu`.
 * W03/W05 extend the adapters accordingly.
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, OfferingOptions, OptionSupport, ThinkingDisplay } from '@breeze/shared';
import type { ThinkingMode } from './capabilities';

export const THINKING_DISPLAY_UPDATES_BETA = 'thinking-display-updates-2026-08-18';
export const FAST_MODE_BETA = 'fast-mode-2026-02-01';

export type WireThinking =
  | { type: 'adaptive'; display?: ThinkingDisplay }
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'disabled' };

export interface WireParams {
  thinking?: WireThinking;
  effort?: EffortLevel;
  speed?: 'fast';
  inferenceGeo?: string;
  betas: string[];
  /** What was actually requested on the wire: the input to pricing (option rates) and the ledger. */
  applied: OfferingOptions;
}

export interface BuildWireParamsInput {
  thinkingMode: ThinkingMode;
  optionSupport: OptionSupport;
  requested: OfferingOptions;
  inferenceGeo?: string | null;
  maxTokens: number;
}

export function buildWireParams(input: BuildWireParamsInput): WireParams {
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < 1) {
    throw new RangeError(`buildWireParams: maxTokens must be a positive integer, got ${String(input.maxTokens)}`);
  }
  const { thinkingMode, optionSupport: support, requested } = input;
  const applied: OfferingOptions = {};
  const betas: string[] = [];
  const wire: WireParams = { betas, applied };

  if (thinkingMode === 'adaptive') {
    // Never `disabled` on an adaptive model: Sonnet 5.5 / Opus 5.5 / Fable 400 on it.
    const thinking: { type: 'adaptive'; display?: ThinkingDisplay } = { type: 'adaptive' };
    if (requested.thinkingDisplay && support.thinkingDisplay.includes(requested.thinkingDisplay)) {
      thinking.display = requested.thinkingDisplay;
      applied.thinkingDisplay = requested.thinkingDisplay;
      if (requested.thinkingDisplay === 'updates') betas.push(THINKING_DISPLAY_UPDATES_BETA);
    }
    wire.thinking = thinking;
    if (requested.effort && support.effort.includes(requested.effort)) {
      wire.effort = requested.effort;
      applied.effort = requested.effort;
    }
  } else if (thinkingMode === 'budget') {
    // v1: budget-mode models run with thinking off. This is W00 parity for
    // Haiku 4.5. OfferingOptions has no on/off knob yet; the chat picker
    // (W05) adds it, and only then does this branch emit `enabled` with a
    // budget below `maxTokens`. Until then `maxTokens` is only validated.
    wire.thinking = { type: 'disabled' };
  }
  // 'none' and 'unknown': no thinking param, no effort (spec §7 table).

  if (requested.speed === 'fast' && support.speed.includes('fast')) {
    wire.speed = 'fast';
    applied.speed = 'fast';
    betas.push(FAST_MODE_BETA);
  } else if (requested.speed === 'standard') {
    applied.speed = 'standard';
  }

  if (input.inferenceGeo && support.inferenceGeo.includes(input.inferenceGeo)) {
    wire.inferenceGeo = input.inferenceGeo;
  }

  return wire;
}

export class UnsupportedWireOptionError extends Error {
  constructor(
    readonly option: 'thinkingDisplay:updates' | 'speed' | 'inferenceGeo',
    transport: 'agent_sdk' | 'messages_api',
  ) {
    super(
      `${option} cannot be sent over ${transport} yet. See `
      + 'docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-w01-spike-findings.md (D1-D3).',
    );
    this.name = 'UnsupportedWireOptionError';
  }
}

function assertCarriable(wire: WireParams, transport: 'agent_sdk' | 'messages_api'): void {
  if (wire.thinking?.type === 'adaptive' && wire.thinking.display === 'updates') {
    throw new UnsupportedWireOptionError('thinkingDisplay:updates', transport);
  }
  if (wire.speed) throw new UnsupportedWireOptionError('speed', transport);
  if (wire.inferenceGeo) throw new UnsupportedWireOptionError('inferenceGeo', transport);
}

export type AgentSdkThinkingOptions = Pick<Options, 'thinking' | 'effort'>;

/**
 * Agent SDK `query()` options. "Send nothing" is spelled `{ type: 'disabled' }`
 * because an omitted option lets the SDK CLI turn extended thinking ON
 * (#7587: Haiku 4.5, ~11x output tokens).
 */
export function toAgentSdkOptions(wire: WireParams): AgentSdkThinkingOptions {
  assertCarriable(wire, 'agent_sdk');
  const thinking = wire.thinking;
  if (!thinking || thinking.type === 'disabled') return { thinking: { type: 'disabled' } };
  if (thinking.type === 'enabled') return { thinking: { type: 'enabled', budgetTokens: thinking.budget_tokens } };
  const adaptive = thinking.display
    ? { type: 'adaptive' as const, display: thinking.display as 'omitted' | 'summarized' }
    : { type: 'adaptive' as const };
  return wire.effort ? { thinking: adaptive, effort: wire.effort } : { thinking: adaptive };
}

export interface MessagesApiThinkingParams {
  thinking?: { type: 'adaptive'; display?: 'omitted' | 'summarized' };
  output_config?: { effort: EffortLevel };
}

/**
 * Raw `messages.create` one-shots (#7587): params only ever REDUCE thinking.
 * They are sent only for an adaptive model that already thinks when the
 * param is omitted, to cap it at the requested effort. Everything else
 * sends nothing, so no new field reaches a catalog or BYO gateway.
 */
export function toMessagesApiParams(
  wire: WireParams,
  opts: { thinksWhenOmitted: boolean },
): MessagesApiThinkingParams {
  assertCarriable(wire, 'messages_api');
  if (wire.thinking?.type !== 'adaptive' || !opts.thinksWhenOmitted) return {};
  if (!wire.effort && !wire.thinking.display) return {};
  const thinking = wire.thinking.display
    ? { type: 'adaptive' as const, display: wire.thinking.display as 'omitted' | 'summarized' }
    : { type: 'adaptive' as const };
  return wire.effort ? { thinking, output_config: { effort: wire.effort } } : { thinking };
}
