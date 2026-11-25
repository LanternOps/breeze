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
  description: 'Call any tool this connection can call, by exact name. It runs with exactly the checks, approvals and limits of calling that tool directly, so it can read or change anything the named tool can.',
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
 * Static rather than built at import: buildMcpToolPresentation reads the tool
 * registry, which a module-level call would load (or hit a test mock of)
 * before anything else. mcpMetaTools.test.ts pins each entry to
 * buildMcpToolPresentation(def, 1, 'core'), the `whoami` precedent.
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
