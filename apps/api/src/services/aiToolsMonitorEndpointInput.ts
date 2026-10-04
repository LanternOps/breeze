/**
 * `manage_monitor_definitions` create/update input: resolve endpoint values a
 * model copied out of a tool result back to what is stored.
 *
 * `get_monitor` / `list_monitors` show a network_check `condition.target` as
 * scheme + host plus `targetFingerprint`, and tool output masks every header
 * value as `[REDACTED]`. Writing those shown values back would replace the
 * working URL / header with the display string. The shared rules live in
 * `utils/endpointDisplay.ts`; this module applies them to a definition.
 */
import {
  findDisplayPlaceholderPath,
  resolveEndpointTargetInput,
  resolveHeaderValuesInput,
} from '../utils/endpointDisplay';

export interface StoredMonitorForInput {
  kind: string;
  condition: unknown;
}

export type MonitorDefinitionInputResolution =
  | { ok: true; definition: unknown; keptStored: string[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True when an update patch replaces the condition (so the stored row is needed to resolve it). */
export function definitionReplacesCondition(definition: unknown): boolean {
  return isRecord(definition) && isRecord(definition.condition);
}

/**
 * `stored` is the current definition on update, null on create (where any
 * display-form value is refused, since there is nothing to keep).
 */
export function resolveMonitorDefinitionInput(
  definition: unknown,
  stored: StoredMonitorForInput | null,
): MonitorDefinitionInputResolution {
  if (!isRecord(definition)) return { ok: true, definition, keptStored: [] };

  const keptStored: string[] = [];
  let resolved: Record<string, unknown> = definition;
  const kind = definition.kind ?? stored?.kind;

  if (kind === 'network_check' && isRecord(definition.condition)) {
    const { targetFingerprint, ...condition } = definition.condition;
    const storedCondition =
      stored?.kind === 'network_check' && isRecord(stored.condition) ? stored.condition : null;

    if (typeof condition.target === 'string') {
      const target = resolveEndpointTargetInput(condition.target, {
        stored: typeof storedCondition?.target === 'string' ? storedCondition.target : null,
        fingerprint: targetFingerprint,
        field: 'condition.target',
      });
      if (!target.ok) return target;
      condition.target = target.value;
      if (target.keptStored) keptStored.push('condition.target');
    }

    if (condition.headers !== undefined) {
      const headers = resolveHeaderValuesInput(condition.headers, storedCondition?.headers, 'condition.headers');
      if (!headers.ok) return headers;
      condition.headers = headers.value;
      if (headers.keptStored) keptStored.push('condition.headers');
    }

    resolved = { ...definition, condition };
  }

  const placeholderPath = findDisplayPlaceholderPath(resolved);
  if (placeholderPath !== null) {
    return {
      ok: false,
      error: `definition.${placeholderPath} holds a masked placeholder copied from a tool result. Omit fields you are not changing, or supply the real value.`,
    };
  }
  return { ok: true, definition: resolved, keptStored };
}
