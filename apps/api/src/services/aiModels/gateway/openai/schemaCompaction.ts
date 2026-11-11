/**
 * Schema compaction for the ADVERTISED upstream tool parameters (#11393 W03,
 * spec 2026-11-06-small-model-tool-profiles §3.4). A constrained tool profile
 * on a gateway (OpenAI-compatible) connection strips size and format
 * keywords from what the small model reads, to save prompt tokens.
 *
 * It never loosens anything that is enforced:
 *  - `translateMessagesRequest` keeps the ORIGINAL schema in
 *    `ToolNameMap.schemas`, so `matchesToolSchema` (which checks only
 *    `$ref/type/enum/const/required/properties/additionalProperties/items`)
 *    validates the model's calls against the original, and returns the same
 *    verdict on either schema (schemaCompaction.noLoosening.test.ts).
 *  - Each tool handler's own Zod validation (`validateToolInput`) is untouched.
 *
 * Pure; never mutates its input.
 */

/** Exactly these keywords are stripped; nothing structural. */
export const COMPACTED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'maxLength', 'minLength', 'maximum', 'minimum', 'pattern', 'format', 'examples', 'default',
]);

/** Keywords whose value is ONE subschema. */
const SUBSCHEMA_KEYS = new Set(['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'additionalItems', 'unevaluatedItems', 'unevaluatedProperties']);
/** Keywords whose value is an ARRAY of subschemas. */
const SUBSCHEMA_ARRAY_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems', 'items']);
/** Keywords whose value maps NAMES (not keywords) to subschemas. */
const SUBSCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compactSchemaNode(node: unknown): unknown {
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (COMPACTED_SCHEMA_KEYWORDS.has(key)) continue;
    if (SUBSCHEMA_MAP_KEYS.has(key) && isPlainObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, compactSchemaNode(sub)]));
    } else if (SUBSCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      out[key] = value.map(compactSchemaNode);
    } else if (SUBSCHEMA_KEYS.has(key)) {
      out[key] = compactSchemaNode(value);
    } else {
      // enum, const, required, type, description, $ref, …: data, never walked.
      out[key] = value;
    }
  }
  return out;
}

/** A copy of `schema` without the eight size/format keywords, at every schema position. */
export function compactInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return compactSchemaNode(schema) as Record<string, unknown>;
}
