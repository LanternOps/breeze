// apps/api/src/services/aiModels/modelWireOptions.ts
/**
 * AI model registry W01 (#7599): per-model thinking/effort options for the
 * eight call sites that used W00's aiModelThinking.ts. Synchronous, because
 * those call sites build `query()` / `messages.create()` options inline. It
 * reads the in-process registry snapshot (platformModelSnapshot.ts).
 *
 * A row with known capabilities decides. Otherwise the W00 rules in
 * aiModel.ts apply: cold snapshot, unregistered id, or capabilities that
 * derive to `unknown`. The params themselves are always built by
 * buildWireParams (index invariant 2).
 *
 * W03's resolveModel supersedes this with assignment options and per-offering
 * capabilities.
 */
import type { OfferingOptions, OptionSupport } from '@breeze/shared';
import { legacyThinksWhenOmitted, legacyWireProfile } from '../aiModel';
import { deriveCapabilities, type ThinkingMode } from './capabilities';
import { peekPlatformModel } from './platformModelSnapshot';
import {
  buildWireParams,
  toAgentSdkOptions,
  toMessagesApiParams,
  type AgentSdkThinkingOptions,
  type MessagesApiThinkingParams,
} from './wireParams';

/** W00's per-surface default, kept until W03 assignments carry options. */
export const W01_SURFACE_DEFAULT_OPTIONS: Readonly<OfferingOptions> = Object.freeze({ effort: 'medium' });

/** `query()` takes no max_tokens; budget thinking (the only consumer) is off in v1. Validation only. */
const AGENT_SDK_NOMINAL_MAX_TOKENS = 32_000;

export interface ModelWireProfile {
  thinkingMode: ThinkingMode;
  optionSupport: OptionSupport;
  source: 'registry' | 'legacy';
}

export function modelWireProfile(modelId: string): ModelWireProfile {
  const row = peekPlatformModel(modelId);
  if (row) {
    const { thinkingMode } = deriveCapabilities(row.capabilities);
    if (thinkingMode !== 'unknown') return { thinkingMode, optionSupport: row.optionSupport, source: 'registry' };
  }
  const legacy = legacyWireProfile(modelId);
  return { thinkingMode: legacy.thinkingMode, optionSupport: legacy.optionSupport, source: 'legacy' };
}

const warnedDrops = new Set<string>();

/** Spec §7: an empty intersection at runtime omits the param and logs a warning (once per model + value). */
function warnOnDroppedEffort(modelId: string, profile: ModelWireProfile, requested: OfferingOptions, applied: OfferingOptions): void {
  if (profile.thinkingMode !== 'adaptive' || !requested.effort || applied.effort === requested.effort) return;
  const key = `${modelId}:${requested.effort}`;
  if (warnedDrops.has(key)) return;
  warnedDrops.add(key);
  console.warn(`[aiModels] ${modelId} does not support effort "${requested.effort}"; sending no effort`);
}

export function agentSdkWireOptions(
  modelId: string,
  requested: OfferingOptions = W01_SURFACE_DEFAULT_OPTIONS,
): AgentSdkThinkingOptions {
  const profile = modelWireProfile(modelId);
  const wire = buildWireParams({
    thinkingMode: profile.thinkingMode,
    optionSupport: profile.optionSupport,
    requested,
    maxTokens: AGENT_SDK_NOMINAL_MAX_TOKENS,
  });
  warnOnDroppedEffort(modelId, profile, requested, wire.applied);
  return toAgentSdkOptions(wire);
}

export function messagesApiWireOptions(
  modelId: string,
  maxTokens: number,
  requested: OfferingOptions = W01_SURFACE_DEFAULT_OPTIONS,
): MessagesApiThinkingParams {
  const profile = modelWireProfile(modelId);
  const wire = buildWireParams({
    thinkingMode: profile.thinkingMode,
    optionSupport: profile.optionSupport,
    requested,
    maxTokens,
  });
  warnOnDroppedEffort(modelId, profile, requested, wire.applied);
  return toMessagesApiParams(wire, { thinksWhenOmitted: legacyThinksWhenOmitted(modelId) });
}
