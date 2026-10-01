/**
 * AI model registry (spec §7): turn the raw Anthropic Models API
 * `capabilities` tree into the facts the wire layer needs. Pure; no I/O.
 *
 * Leaves used: `thinking.types.{adaptive,enabled}.supported`,
 * `effort.{low..max}.supported`, `image_input.supported`. A leaf counts
 * only when it is literally `{ supported: true }`. Anything not
 * recognisably a Models API tree derives to `unknown`. The wire layer then
 * sends nothing, and the W01 bootstrap applies the W00 rules instead
 * (modelWireOptions.ts).
 */
import {
  EFFORT_LEVELS,
  MODEL_SPEEDS,
  THINKING_DISPLAYS,
  type EffortLevel,
  type OptionSupport,
  type ThinkingDisplay,
} from '@breeze/shared';

export type ThinkingMode = 'adaptive' | 'budget' | 'none' | 'unknown';

export interface DerivedCapabilities {
  thinkingMode: ThinkingMode;
  effortLevels: EffortLevel[];
  supportsTools: boolean;
  supportsVision: boolean;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function supported(value: unknown): boolean {
  return isRecord(value) && value.supported === true;
}

function explicitlyUnsupported(value: unknown): boolean {
  return isRecord(value) && value.supported === false;
}

function unknownCapabilities(): DerivedCapabilities {
  return { thinkingMode: 'unknown', effortLevels: [], supportsTools: false, supportsVision: false };
}

export function deriveCapabilities(raw: unknown): DerivedCapabilities {
  if (!isRecord(raw) || !isRecord(raw.thinking)) return unknownCapabilities();
  const thinking = raw.thinking;
  const types = isRecord(thinking.types) ? thinking.types : null;

  let thinkingMode: ThinkingMode;
  if (types && supported(types.adaptive)) {
    thinkingMode = 'adaptive';
  } else if (types && supported(types.enabled)) {
    thinkingMode = 'budget';
  } else if (
    thinking.supported === false
    || (types && explicitlyUnsupported(types.adaptive) && explicitlyUnsupported(types.enabled))
  ) {
    thinkingMode = 'none';
  } else {
    // A thinking subtree we can't read (e.g. `supported: true` with no types)
    // is not a recognisable Models API tree: nothing about it is verified.
    return unknownCapabilities();
  }

  const effort = isRecord(raw.effort) ? raw.effort : null;
  const effortLevels = effort && effort.supported === true
    ? EFFORT_LEVELS.filter((level) => supported(effort[level]))
    : [];

  // Spike D4: the Models API (`ModelCapabilities` in @anthropic-ai/sdk 0.128)
  // has no tool-use leaf, and every Claude model it lists supports tool use.
  // An explicit leaf, should one appear, wins.
  const toolsLeaf = raw.tool_use ?? raw.tools;
  const supportsTools = isRecord(toolsLeaf) && typeof toolsLeaf.supported === 'boolean'
    ? toolsLeaf.supported
    : true;

  return { thinkingMode, effortLevels: [...effortLevels], supportsTools, supportsVision: supported(raw.image_input) };
}

/** Support derivable from the API alone. `speed: fast`, `updates` and geos are operator-set (spec §5.1). */
export function deriveOptionSupport(derived: DerivedCapabilities): OptionSupport {
  const thinks = derived.thinkingMode === 'adaptive' || derived.thinkingMode === 'budget';
  return {
    effort: derived.thinkingMode === 'adaptive' ? [...derived.effortLevels] : [],
    thinkingDisplay: thinks ? ['omitted', 'summarized'] : [],
    speed: ['standard'],
    inferenceGeo: [],
  };
}

function ordered<T extends string>(order: readonly T[], values: Iterable<T>): T[] {
  const set = new Set(values);
  return order.filter((value) => set.has(value));
}

/**
 * Discovery refresh: the API owns effort and the base thinking displays; the
 * operator owns `updates`, `fast` and inference geos, which are kept only while
 * the model can still use them.
 */
export function mergeDiscoveredOptionSupport(existing: OptionSupport, derived: DerivedCapabilities): OptionSupport {
  const base = deriveOptionSupport(derived);
  const displays: ThinkingDisplay[] = [...base.thinkingDisplay];
  if (derived.thinkingMode === 'adaptive' && existing.thinkingDisplay.includes('updates')) displays.push('updates');
  return {
    effort: base.effort,
    thinkingDisplay: ordered(THINKING_DISPLAYS, displays),
    speed: ordered(MODEL_SPEEDS, ['standard', ...existing.speed]),
    inferenceGeo: [...existing.inferenceGeo],
  };
}

/** Operator-entered support must stay inside what the model can do. Empty array = valid. */
export function optionSupportErrors(derived: DerivedCapabilities, support: OptionSupport): string[] {
  const errors: string[] = [];
  if (derived.thinkingMode !== 'adaptive') {
    if (support.effort.length > 0) errors.push('Effort applies only to models with adaptive thinking.');
  } else {
    for (const level of support.effort) {
      if (!derived.effortLevels.includes(level)) errors.push(`Effort "${level}" is not supported by this model.`);
    }
  }
  if (derived.thinkingMode === 'none' || derived.thinkingMode === 'unknown') {
    if (support.thinkingDisplay.length > 0) errors.push('Thinking display applies only to models that think.');
  } else if (derived.thinkingMode !== 'adaptive' && support.thinkingDisplay.includes('updates')) {
    errors.push('Thinking display "updates" needs adaptive thinking.');
  }
  return errors;
}
