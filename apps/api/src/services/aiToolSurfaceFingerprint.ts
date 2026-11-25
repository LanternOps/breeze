// TOOL_SURFACE_FINGERPRINT (#12421 plan Decision 3): a per-session hash of
// what the session's tool server advertises — every tool's name, description
// and input schema — plus whether examples were applied and whether tool
// search was on. Stored on every ai_tool_search_events row so the report can
// compare schema-invalid and discovery rates before and after a description
// or example change.
//
// Not the tool-exposure fingerprint (toolExposure.ts fingerprintOf), which
// hashes names, extras, compactSchemas and promptMode, never descriptions or
// examples; ai_invocations already carries that one.

import { createHash } from 'node:crypto';
import { z } from 'zod';

export interface AdvertisedToolDecl {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** JSON Schema text per schema object; registry schemas are shared across sessions. */
const schemaJsonCache = new WeakMap<object, string>();

function schemaJson(inputSchema: unknown): string {
  if (!inputSchema || typeof inputSchema !== 'object') return 'null';
  const cached = schemaJsonCache.get(inputSchema);
  if (cached !== undefined) return cached;
  const schema = '_zod' in inputSchema ? inputSchema as z.ZodType : z.object(inputSchema as z.ZodRawShape);
  let text: string;
  try {
    text = JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' }));
  } catch {
    // A schema JSON Schema cannot express still identifies itself by its keys.
    text = JSON.stringify({ unconvertible: Object.keys(inputSchema).sort() });
  }
  schemaJsonCache.set(inputSchema, text);
  return text;
}

export function toolSurfaceFingerprint(input: {
  tools: readonly AdvertisedToolDecl[];
  examplesApplied: boolean;
  searchEnabled: boolean;
}): string {
  const t = input.tools
    .map((tool) => [tool.name, tool.description ?? '', schemaJson(tool.inputSchema)] as const)
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify({ t, e: input.examplesApplied, s: input.searchEnabled }))
    .digest('hex')
    .slice(0, 16);
}
