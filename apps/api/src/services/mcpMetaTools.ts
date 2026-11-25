/**
 * The external MCP server's three meta-tools (#12427): `search_tools`,
 * `get_tool_details` and `call_tool`.
 *
 * Server-intrinsic, like `whoami`: never in the aiTools registry, so
 * TOOL_TIERS, the Wisp classification and the chat tool index are untouched.
 * They are listed only in `progressive` mode and callable in either.
 */
import { AI_TOOL_DOMAINS } from '@breeze/shared';
import { MCP_CALL_TOOL_TOOL_NAME, MCP_GET_TOOL_DETAILS_TOOL_NAME, MCP_SEARCH_TOOLS_TOOL_NAME } from './aiToolNames';
import type { McpToolAnnotations } from './mcpToolPresentation';
import { getToolSearchHint, getToolTier } from './aiTools';
import { boundDeniedName } from './mcpDomains';
import { rankTools } from './mcpToolSearch';

/** One `tools/list` entry, as the external MCP server emits it. */
export type McpToolListEntry = {
  title: string;
  annotations: McpToolAnnotations;
  _meta: Record<string, unknown>;
  name: string;
  description: string;
  inputSchema: unknown;
};

export const MCP_SEARCH_TOOLS_DEFAULT_LIMIT = 8;
export const MCP_SEARCH_TOOLS_MAX_LIMIT = 20;
export const MCP_SEARCH_TOOLS_MAX_QUERY_CHARS = 200;
export const MCP_GET_TOOL_DETAILS_MAX_NAMES = 10;
/** Longer than any real tool name; a longer one cannot be in the catalog. */
export const MCP_META_TOOL_NAME_MAX_CHARS = 128;

const SEARCH_TOOLS_DEFINITION = {
  name: MCP_SEARCH_TOOLS_TOOL_NAME,
  description: 'Find tools this connection can call, by keywords. Returns name, title, domain, a short hint, tier and whether it is read-only. Read a match\'s schema with get_tool_details before calling it.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', minLength: 1, maxLength: MCP_SEARCH_TOOLS_MAX_QUERY_CHARS, description: 'What you want to do or find, in plain words.' },
      domain: { type: 'string', enum: [...AI_TOOL_DOMAINS], description: 'Only search this domain.' },
      limit: { type: 'integer', minimum: 1, maximum: MCP_SEARCH_TOOLS_MAX_LIMIT, description: `Maximum results (default ${MCP_SEARCH_TOOLS_DEFAULT_LIMIT}).` },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

const GET_TOOL_DETAILS_DEFINITION = {
  name: MCP_GET_TOOL_DETAILS_TOOL_NAME,
  description: 'Read the full definitions (description, annotations, input schema) of up to 10 tools by exact name, as tools/list would show them.',
  input_schema: {
    type: 'object' as const,
    properties: {
      names: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: MCP_META_TOOL_NAME_MAX_CHARS },
        minItems: 1,
        maxItems: MCP_GET_TOOL_DETAILS_MAX_NAMES,
        description: 'Exact tool names, from search_tools.',
      },
    },
    required: ['names'],
    additionalProperties: false,
  },
};

const CALL_TOOL_DEFINITION = {
  name: MCP_CALL_TOOL_TOOL_NAME,
  description: 'Call any tool this connection can call, by exact name. It runs with the same checks, approvals and limits as calling that tool directly, so it can read or change anything the named tool can.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: MCP_META_TOOL_NAME_MAX_CHARS, description: 'The exact tool name.' },
      arguments: { type: 'object', description: 'The tool\'s arguments, as its inputSchema describes.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

/**
 * The list entries are static rather than built at import: buildMcpToolPresentation
 * reads the tool registry, which a module-level call would load (or hit a test
 * mock of) before anything else. mcpMetaTools.test.ts pins search_tools and
 * get_tool_details to buildMcpToolPresentation(def, 1, 'core') (the `whoami`
 * precedent) and call_tool's title and domain to it; call_tool's annotations
 * deliberately differ.
 */
const READ_ONLY_CORE: McpToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function listEntry(title: string, def: { name: string; description: string; input_schema: unknown }, annotations: McpToolAnnotations): McpToolListEntry {
  return {
    title,
    annotations: { ...annotations },
    _meta: { 'app.breeze/domain': 'core' },
    name: def.name,
    description: def.description,
    inputSchema: def.input_schema,
  };
}

export const MCP_SEARCH_TOOLS_LIST_ENTRY: McpToolListEntry = listEntry('Search tools', SEARCH_TOOLS_DEFINITION, READ_ONLY_CORE);
export const MCP_GET_TOOL_DETAILS_LIST_ENTRY: McpToolListEntry = listEntry('Get tool details', GET_TOOL_DETAILS_DEFINITION, READ_ONLY_CORE);
/**
 * A dispatcher has no tier of its own; the inner tool's governs. Its
 * annotations therefore claim the worst case, so a client that keeps its own
 * allowlist or per-tool prompt treats it as the multiplexer it is.
 */
export const MCP_CALL_TOOL_LIST_ENTRY: McpToolListEntry = listEntry('Call tool', CALL_TOOL_DEFINITION, {
  readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
});

export const MCP_META_TOOL_DEFINITIONS = [SEARCH_TOOLS_DEFINITION, GET_TOOL_DETAILS_DEFINITION, CALL_TOOL_DEFINITION] as const;

export const MCP_META_TOOL_LIST_ENTRIES: readonly McpToolListEntry[] = [
  MCP_SEARCH_TOOLS_LIST_ENTRY, MCP_GET_TOOL_DETAILS_LIST_ENTRY, MCP_CALL_TOOL_LIST_ENTRY,
];

// ---------------------------------------------------------------------------
// search_tools / get_tool_details
// ---------------------------------------------------------------------------

/** A dynamic tool source buildToolsListEntries resolves; a failed one leaves the catalog partial. */
export type McpCatalogSource = 'tenant' | 'flow';

export type SearchToolsRow = {
  name: string;
  title: string;
  domain: string;
  hint: string | null;
  tier: number | null;
  readOnly: boolean;
  approvalNote?: string;
};

export type MetaToolOutcome =
  | { result: Record<string, unknown> }
  | { error: { code: -32602; message: 'Invalid params'; data: { reason: string } } };

const INVALID_ARGUMENTS: MetaToolOutcome = { error: { code: -32602, message: 'Invalid params', data: { reason: 'invalid_arguments' } } };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function structuredResult(structured: Record<string, unknown>): MetaToolOutcome {
  return { result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured } };
}

/**
 * `catalog` is the caller's `full` tool list (buildToolsListEntries), so a
 * tool the caller could not list is never ranked. `approvalNotes` holds the
 * approval / MFA sentences the list appended to a registry description.
 */
export function handleSearchTools(
  catalog: readonly McpToolListEntry[],
  input: unknown,
  approvalNotes: ReadonlyMap<string, string>,
  /** Dynamic tool sources that failed to load for this catalog; flagged, never hidden. */
  incomplete: readonly McpCatalogSource[] = [],
): MetaToolOutcome {
  if (!isPlainObject(input) || !onlyKeys(input, ['query', 'domain', 'limit'])) return INVALID_ARGUMENTS;
  const { query, domain, limit } = input;
  if (typeof query !== 'string' || query.trim().length === 0 || query.length > MCP_SEARCH_TOOLS_MAX_QUERY_CHARS) return INVALID_ARGUMENTS;
  if (domain !== undefined && (typeof domain !== 'string' || !(AI_TOOL_DOMAINS as readonly string[]).includes(domain))) return INVALID_ARGUMENTS;
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MCP_SEARCH_TOOLS_MAX_LIMIT)) return INVALID_ARGUMENTS;

  const domainOf = (entry: McpToolListEntry) => String(entry._meta['app.breeze/domain'] ?? 'unknown');
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  const ranked = rankTools(
    catalog.map((entry) => ({ name: entry.name, description: entry.description, domain: domainOf(entry), searchHint: getToolSearchHint(entry.name) })),
    query,
    { domain, limit: limit ?? MCP_SEARCH_TOOLS_DEFAULT_LIMIT },
  );
  const tools: SearchToolsRow[] = ranked.map((name) => {
    const entry = byName.get(name)!;
    const note = approvalNotes.get(name);
    return {
      name,
      title: entry.title,
      domain: domainOf(entry),
      hint: getToolSearchHint(name) ?? null,
      tier: getToolTier(name) ?? null,
      readOnly: entry.annotations.readOnlyHint,
      ...(note ? { approvalNote: note } : {}),
    };
  });
  return structuredResult({ tools, ...(incomplete.length > 0 ? { catalogIncomplete: [...incomplete] } : {}) });
}

/**
 * Returns each requested tool exactly as tools/list (`full`) emits it for this
 * caller. A name outside the catalog answers `Unknown tool: <name>` the same
 * way whether it does not exist, is wholly gated or is outside the grant, and
 * no partial details are returned.
 */
export function handleGetToolDetails(
  catalog: readonly McpToolListEntry[],
  input: unknown,
  incomplete: readonly McpCatalogSource[] = [],
): MetaToolOutcome {
  if (!isPlainObject(input) || !onlyKeys(input, ['names'])) return INVALID_ARGUMENTS;
  const { names } = input;
  if (!Array.isArray(names) || names.length === 0 || names.length > MCP_GET_TOOL_DETAILS_MAX_NAMES) return INVALID_ARGUMENTS;
  if (!names.every((name): name is string => typeof name === 'string' && name.length > 0)) return INVALID_ARGUMENTS;

  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  const tools: McpToolListEntry[] = [];
  for (const name of new Set(names)) {
    const found = byName.get(name);
    if (!found) {
      // Uniform for every unknown name (no existence signal), but honest that
      // the catalog is partial when a tool source failed to load.
      const retry = incomplete.length > 0 ? '. Some integration tools could not be loaded right now; retry.' : '';
      return { result: { isError: true, content: [{ type: 'text', text: `Unknown tool: ${boundDeniedName(name)}${retry}` }] } };
    }
    tools.push(found);
  }
  return structuredResult({ tools });
}

// ---------------------------------------------------------------------------
// call_tool
// ---------------------------------------------------------------------------

export type UnwrappedCallTool =
  | { wrapped: false; params: Record<string, unknown> | undefined }
  | { wrapped: true; params: { name: string; arguments: Record<string, unknown>; requestState?: unknown; inputResponses?: unknown } }
  | { wrapped: true; invalid: 'invalid_call_tool_arguments' };

/**
 * `tools/call` of call_tool → the inner call's params. Pure. The continuation
 * fields (`requestState`, `inputResponses`) belong to the MCP request, so they
 * stay on the outer params and are copied onto the inner ones unchanged: a
 * wrapper retry reaches the continuation exactly as a direct retry does.
 */
export function unwrapCallToolRequest(params: Record<string, unknown> | undefined): UnwrappedCallTool {
  if (params?.name !== MCP_CALL_TOOL_TOOL_NAME) return { wrapped: false, params };
  const args = params.arguments;
  const invalid = { wrapped: true, invalid: 'invalid_call_tool_arguments' } as const;
  // Unknown keys are refused, never dropped: flattened inner arguments would
  // otherwise run the tool unfiltered, and a nested requestState would start
  // a fresh call instead of continuing one.
  if (!isPlainObject(args) || !onlyKeys(args, ['name', 'arguments'])) return invalid;
  const { name, arguments: innerArguments } = args;
  if (typeof name !== 'string' || name.length === 0 || name.length > MCP_META_TOOL_NAME_MAX_CHARS) return invalid;
  if (innerArguments !== undefined && !isPlainObject(innerArguments)) return invalid;
  return {
    wrapped: true,
    params: {
      name,
      arguments: innerArguments ?? {},
      ...(Object.hasOwn(params, 'requestState') ? { requestState: params.requestState } : {}),
      ...(Object.hasOwn(params, 'inputResponses') ? { inputResponses: params.inputResponses } : {}),
    },
  };
}
