/**
 * Synthetic tenant (BYO MCP) tool sets for the capture harness (#7429).
 *
 * A capture registers these through the real `buildTenantSdkTools` bridge
 * (`runSurface.ts`), the same path `streamingSessionManager` uses for a chat
 * session's resolved tenant tools. The descriptors never execute: the harness
 * denies every call in `onPreToolUse`, before the tenant handler (and its DB /
 * vendor dispatch) runs.
 *
 * Two disjoint sets (`a`, `b`) let a capture compare sessions whose tenant tool
 * sets differ; `none` is the zero-tenant baseline. Order matches the resolver
 * (`resolveTenantTools` orders by `qualifiedName`).
 */
import type { TenantToolDescriptor } from '../../toolSources/resolver';

export const CAPTURE_TENANT_SET_IDS = ['none', 'a', 'b'] as const;
export type CaptureTenantSetId = (typeof CAPTURE_TENANT_SET_IDS)[number];

/** Well above any real tenant catalog; stops a typo from allocating millions of tools. */
export const MAX_CAPTURE_TENANT_TOOLS = 1000;

interface TenantSetSpec {
  sourceName: string;
  prefix: string;
  tools: ReadonlyArray<readonly [name: string, description: string]>;
}

const SETS: Record<Exclude<CaptureTenantSetId, 'none'>, TenantSetSpec> = {
  a: {
    sourceName: 'Hudu',
    prefix: 'hudu',
    tools: [
      ['get_asset', 'Get one asset by id, with its custom fields.'],
      ['list_assets', 'List assets for a company, filtered by layout.'],
      ['search_assets', 'Full-text search across asset names and fields.'],
      ['get_company', 'Get one company record.'],
      ['list_companies', 'List companies, paged.'],
      ['get_article', 'Get a knowledge-base article.'],
      ['search_articles', 'Search knowledge-base articles.'],
      ['get_password_meta', 'Get password metadata (never the secret).'],
      ['list_password_meta', 'List password metadata for a company.'],
      ['list_websites', 'List monitored websites for a company.'],
      ['get_procedure', 'Get a procedure and its steps.'],
      ['list_procedures', 'List procedures for a company.'],
    ],
  },
  b: {
    sourceName: 'IT Glue',
    prefix: 'itglue',
    tools: [
      ['get_configuration', 'Get one configuration item.'],
      ['list_configurations', 'List configuration items for an organization.'],
      ['search_configurations', 'Search configuration items by name or serial.'],
      ['get_organization', 'Get one organization record.'],
      ['list_organizations', 'List organizations, paged.'],
      ['get_document', 'Get a document.'],
      ['search_documents', 'Search documents.'],
      ['get_contact', 'Get one contact.'],
      ['list_contacts', 'List contacts for an organization.'],
      ['get_flexible_asset', 'Get a flexible asset.'],
      ['list_flexible_assets', 'List flexible assets of a type.'],
      ['list_domains', 'List domains for an organization.'],
    ],
  },
};

const INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Record id.' },
    query: { type: 'string', description: 'Search text.' },
    page: { type: 'integer', minimum: 1 },
  },
};

function descriptor(spec: TenantSetSpec, name: string, description: string): TenantToolDescriptor {
  const qualifiedName = `${spec.prefix}__${name}`;
  return {
    id: `capture-${qualifiedName}`,
    sourceId: `capture-source-${spec.prefix}`,
    sourceName: spec.sourceName,
    sourceKind: 'mcp',
    ownerRef: { orgId: 'capture-org', partnerId: null },
    qualifiedName,
    name,
    description,
    inputSchema: INPUT_SCHEMA,
    tier: 1,
    revision: 'capture-1',
    rateLimitPerMinute: 60,
    validate: () => ({ success: true }),
    definition: { name: qualifiedName, description, input_schema: INPUT_SCHEMA },
  };
}

/**
 * The descriptors a capture registers for `set`. `count` defaults to the set's
 * named tools; a larger count pads with generated `extra_tool_NNN` entries so a
 * capture can measure a big tenant catalog.
 */
export function captureTenantDescriptors(set: CaptureTenantSetId, count?: number): TenantToolDescriptor[] {
  if (count !== undefined && (!Number.isInteger(count) || count < 0)) {
    throw new Error(`tenant tool count must be a non-negative integer, got ${count}`);
  }
  if (count !== undefined && count > MAX_CAPTURE_TENANT_TOOLS) {
    throw new Error(`tenant tool count must be at most ${MAX_CAPTURE_TENANT_TOOLS}, got ${count}`);
  }
  if (set === 'none') {
    if (count) throw new Error('the none tenant set has no tools; drop the count');
    return [];
  }
  const spec = SETS[set];
  const wanted = count ?? spec.tools.length;
  const named = spec.tools.slice(0, wanted).map(([name, description]) => descriptor(spec, name, description));
  const extra = Array.from({ length: Math.max(0, wanted - spec.tools.length) }, (_, i) =>
    descriptor(spec, `extra_tool_${String(i + 1).padStart(3, '0')}`, `Synthetic ${spec.sourceName} tool ${i + 1}.`));
  return [...named, ...extra].sort((x, y) => (x.qualifiedName < y.qualifiedName ? -1 : x.qualifiedName > y.qualifiedName ? 1 : 0));
}
