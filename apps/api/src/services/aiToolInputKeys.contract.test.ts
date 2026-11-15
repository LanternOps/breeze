/**
 * #11861 contract: every key a caller is TOLD about is a key validation
 * ACCEPTS. Unknown arguments are now refused (validateToolInput on every
 * dispatch path, the SDK PreToolUse hook on the chat/agent surfaces), so an
 * advertised-but-undeclared property would turn into a refusal of a call the
 * caller was invited to make. Three advertised surfaces, one internal injector:
 *
 *  1. the registry `input_schema` (what MCP `tools/list` sends),
 *  2. the chat/agent SDK declarations and the script-builder declarations
 *     (what the in-process SDK servers advertise),
 *  3. the Helper device-scope gate, which INJECTS `deviceId`/`deviceIds`.
 *
 * NOTE: no vi.mock — this needs the real registry and declarations.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import './aiTools';
import { aiTools } from './aiToolNames';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';
import { buildBreezeSdkTools } from './aiAgentSdkTools';
import { scriptBuilderServerTools } from './scriptBuilderTools';
import { HELPER_TOOL_SCOPING, applyHelperDeviceScope } from './helperToolFilter';
import { findUnknownInputKeys } from './aiToolUnknownKeys';

type JsonSchema = { type?: unknown; properties?: Record<string, JsonSchema>; items?: JsonSchema };

/**
 * An input carrying EVERY property a JSON schema advertises, nested objects
 * and array items included. Leaf values are placeholders: only the unknown-key
 * check is asserted, never the full parse.
 */
function everyAdvertisedKey(schema: JsonSchema | undefined, depth = 0): unknown {
  if (!schema || depth > 8) return 'x';
  if (schema.properties) {
    return Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, everyAdvertisedKey(v, depth + 1)]));
  }
  if (schema.type === 'array') return [everyAdvertisedKey(schema.items, depth + 1)];
  return 'x';
}

function countKeys(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countKeys(v), 0);
  if (value && typeof value === 'object') return Object.entries(value).reduce((n, [, v]) => n + 1 + countKeys(v), 0);
  return 0;
}

const unknownKeyLines = (tool: string, input: unknown) => {
  const result = validateToolInput(tool, input as Record<string, unknown>);
  return result.success ? [] : result.error.split('; ').filter((part) => part.includes('unknown argument'));
};

describe('registry input_schema (MCP tools/list) ⊆ accepted keys (#11861)', () => {
  const registered = [...aiTools.values()];

  it('probes the whole registry (vacuity guard)', () => {
    expect(registered.length).toBeGreaterThan(300);
    const probed = registered.reduce((n, t) => n + countKeys(everyAdvertisedKey(t.definition.input_schema as JsonSchema)), 0);
    expect(probed).toBeGreaterThan(2000);
  });

  it('every advertised property of every registered tool passes the unknown-argument check', () => {
    const offenders = registered
      .filter((t) => Object.hasOwn(toolInputSchemas, t.definition.name))
      .map((t) => ({ tool: t.definition.name, unknown: unknownKeyLines(t.definition.name, everyAdvertisedKey(t.definition.input_schema as JsonSchema)) }))
      .filter((o) => o.unknown.length > 0);
    expect(offenders, 'advertised in the registry input_schema but not declared in toolInputSchemas: declare it, or stop advertising it').toEqual([]);
  });

  it('the probe catches an advertised-but-undeclared key (control)', () => {
    const schema = z.object({ a: z.string() });
    const advertised: JsonSchema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } };
    expect(findUnknownInputKeys(schema, everyAdvertisedKey(advertised)).map((f) => f.keys)).toEqual([['b']]);
  });
});

describe('SDK declarations ⊆ accepted keys (#11861)', () => {
  const sdkDeclarations = (() => {
    vi.stubEnv('M365_ENABLED', 'true');
    vi.stubEnv('GOOGLE_WORKSPACE_ENABLED', 'true');
    vi.stubEnv('BREEZE_AI_SCRIPT_AUTHORING_ENABLED', 'true');
    vi.stubEnv('FLOWS_ENABLED', 'true');
    try {
      const fakeAuth = (() => { throw new Error('handlers must not run in this test'); }) as never;
      return [
        ...buildBreezeSdkTools(fakeAuth).map((t) => ({ server: 'breeze', t })),
        ...scriptBuilderServerTools(fakeAuth).map((t) => ({ server: 'script_builder', t })),
      ];
    } finally {
      vi.unstubAllEnvs();
    }
  })();

  it('builds both servers', () => {
    expect(sdkDeclarations.filter((d) => d.server === 'breeze').length).toBeGreaterThan(140);
    expect(sdkDeclarations.filter((d) => d.server === 'script_builder').length).toBeGreaterThan(5);
  });

  it('every key a registry tool\'s SDK shape advertises passes that tool\'s unknown-argument check', () => {
    const offenders = sdkDeclarations
      .filter(({ t }) => Object.hasOwn(toolInputSchemas, t.name))
      .map(({ server, t }) => {
        const advertised = z.toJSONSchema(z.object(t.inputSchema as z.ZodRawShape), { io: 'input', unrepresentable: 'any' }) as JsonSchema;
        return { server, tool: t.name, unknown: unknownKeyLines(t.name, everyAdvertisedKey(advertised)) };
      })
      .filter((o) => o.unknown.length > 0);
    expect(offenders, 'the SDK shape advertises a key toolInputSchemas does not declare: executeTool would now refuse it').toEqual([]);
  });
});

describe('internally injected keys are accepted (#11861)', () => {
  it('the Helper device-scope field of every scoped tool is a declared key', () => {
    const device = '00000000-0000-4000-8000-000000000001';
    const offenders = Object.keys(HELPER_TOOL_SCOPING).flatMap((tool) => {
      const scoped = applyHelperDeviceScope(tool, {}, device);
      if ('error' in scoped) return [`${tool}: ${scoped.error}`];
      const schema = toolInputSchemas[tool];
      if (!schema) return [`${tool}: no input schema`];
      return findUnknownInputKeys(schema, scoped.input).map((f) => `${tool}: ${f.keys.join(', ')}`);
    });
    expect(offenders).toEqual([]);
  });
});
