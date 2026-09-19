/**
 * Tool action/discriminator enumeration, shared by the agent tool catalog and
 * the approval-scope contract test. Lives in its own module (not
 * aiGuardrails.ts) because it needs the tool REGISTRY and the Zod input
 * schemas, and aiToolSchemas.ts imports Drizzle enum objects from db/schema:
 * pulling those into aiGuardrails.ts broke every test that partially mocks
 * db/schema and transitively imports guardrails (mcpServer.*.test.ts,
 * intentService.tier2Agent.test.ts on #5054). Guardrails must stay free of
 * registry/schema imports.
 */
import { getToolDefinitions } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_ACTION_INPUT_KEYS } from './aiGuardrails';

/**
 * `getToolDefinitions()` walks every registered tool (core + extension) and
 * is called once per tool by `toolActionEnum` below; building the by-name
 * lookup fresh on every call made tool-catalog generation quadratic in the
 * tool count. Registries are populated once at import time and are static
 * for the life of the process (same assumption `aiTools`'s own Maps make),
 * so a module-level memo of the DEFAULT registry's definitions is safe.
 */
let toolDefinitionsByName: Map<string, ReturnType<typeof getToolDefinitions>[number]> | null = null;

function getToolDefinitionByName(toolName: string): ReturnType<typeof getToolDefinitions>[number] | undefined {
  toolDefinitionsByName ??= new Map(getToolDefinitions().map((d) => [d.name, d]));
  return toolDefinitionsByName.get(toolName);
}

/**
 * A tool's REAL action/discriminator enum, from the two places a discriminator
 * string can enter the system: the Anthropic tool definition the model is
 * shown, and the Zod schema `validateToolInput` enforces. Unioned, so a new
 * member added to EITHER source is caught. Returns null for a tool that is
 * not action-multiplexed (no enum on either side).
 *
 * Reads under `TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action'` — most tools
 * multiplex on `action`, but `execute_command` multiplexes on `commandType`
 * (#3088). Shared by `agentToolCatalog.ts` (catalog operation enumeration)
 * and `aiGuardrails.approvalScope.contract.test.ts` (tier-table coverage),
 * which each used to carry their own byte-identical copy.
 */
export function toolActionEnum(toolName: string): string[] | null {
  const key = TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action';
  const values = new Set<string>();

  const definition = getToolDefinitionByName(toolName);
  const properties = (definition?.input_schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const jsonEnum = (properties?.[key] as { enum?: unknown[] } | undefined)?.enum;
  if (Array.isArray(jsonEnum)) for (const v of jsonEnum) if (typeof v === 'string') values.add(v);

  const zodField = (toolInputSchemas[toolName] as { shape?: Record<string, unknown> } | undefined)?.shape?.[key];
  const zodEnum = (zodField as { options?: unknown[] } | undefined)?.options;
  if (Array.isArray(zodEnum)) for (const v of zodEnum) if (typeof v === 'string') values.add(v);

  return values.size > 0 ? [...values] : null;
}
