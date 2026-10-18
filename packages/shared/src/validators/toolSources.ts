import { z } from 'zod';

export const TOOL_SOURCE_SLUG_RE = /^[a-z][a-z0-9]{1,23}$/;
export const SOURCE_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const QUALIFIED_TOOL_NAME_MAX = 64;
export const RESERVED_TOOL_SOURCE_SLUGS: ReadonlySet<string> = new Set(['mcp', 'breeze', 'core', 'flow', 'ext']);

const httpsUrl = z.string().url().refine((u) => u.startsWith('https://'), 'must be an https URL');
const headerToken = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'invalid header name');

export const toolSourceAuthConfigSchema = z.discriminatedUnion('authKind', [
  z.object({ authKind: z.literal('none') }),
  z.object({ authKind: z.literal('bearer'), authConfig: z.object({ token: z.string().min(1).max(4096) }) }),
  z.object({ authKind: z.literal('api_key_header'), authConfig: z.object({ headerName: headerToken, value: z.string().min(1).max(4096) }) }),
  z.object({ authKind: z.literal('basic'), authConfig: z.object({ username: z.string().min(1).max(256), password: z.string().min(1).max(4096) }) }),
  z.object({ authKind: z.literal('oauth2_client_credentials'), authConfig: z.object({
    tokenUrl: httpsUrl, clientId: z.string().min(1).max(512), clientSecret: z.string().min(1).max(4096), scope: z.string().max(1024).optional(),
  }) }),
]);

export const TOOL_SOURCE_KINDS = ['mcp', 'openapi'] as const;

const sourceCore = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().regex(TOOL_SOURCE_SLUG_RE).refine((s) => !RESERVED_TOOL_SOURCE_SLUGS.has(s), 'reserved slug'),
  kind: z.enum(TOOL_SOURCE_KINDS),
  // For an `openapi` source this is the API BASE url — the origin the
  // credential is pinned to (`credentialOriginFor(endpointUrl)`), and the only
  // host operations are ever sent to (the document's `servers[]` never routes).
  endpointUrl: httpsUrl,
  // W2: the OpenAPI document URL. Only read; the credential travels with it
  // only when it shares `endpointUrl`'s origin.
  specUrl: httpsUrl.optional(),
  rateLimitPerMinute: z.number().int().min(1).max(6000).default(120),
  ownerScope: z.enum(['organization', 'partner']).optional(),
  orgId: z.string().uuid().optional(),
});

/** `openapi` needs a document; `mcp` must not carry one (mirrors `tool_sources_spec_url_kind_chk`). */
function kindSpecUrlRule(v: { kind?: string; specUrl?: string }, ctx: z.RefinementCtx): void {
  if (v.kind === 'openapi' && !v.specUrl) {
    ctx.addIssue({ code: 'custom', path: ['specUrl'], message: 'an openapi source requires a spec URL' });
  }
  if (v.kind === 'mcp' && v.specUrl !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['specUrl'], message: 'an mcp source must not have a spec URL' });
  }
}

// slug/kind/ownerScope/orgId are create-only; auth may be replaced wholesale.
// `kind` is refused outright on update rather than silently stripped, so a
// client that believes it can flip a source's transport gets a 400, not a
// 200 that changed nothing. (`.strict()` cannot be used here: the auth union
// on the other side of the intersection owns `authKind`/`authConfig`.)
const updateOnly = { kind: z.never({ message: 'kind cannot be changed after creation' }).optional() };

export const createToolSourceSchema = z.intersection(sourceCore, toolSourceAuthConfigSchema).superRefine(kindSpecUrlRule);
export const updateToolSourceSchema = z.intersection(
  sourceCore.omit({ slug: true, kind: true, ownerScope: true, orgId: true }).partial().extend(updateOnly),
  z.union([toolSourceAuthConfigSchema, z.object({})]),
);
// Explicit opt-in for self-hosted APIs; the default schemas remain HTTPS-only.
const httpOrHttpsUrl = z.string().url().refine(
  (url) => url.startsWith('https://') || url.startsWith('http://'),
  'must be an http or https URL',
);
const sourceCoreWithHttp = sourceCore.extend({
  endpointUrl: httpOrHttpsUrl,
  specUrl: httpOrHttpsUrl.optional(),
});
export const createToolSourceSchemaWithHttp = z
  .intersection(sourceCoreWithHttp, toolSourceAuthConfigSchema)
  .superRefine(kindSpecUrlRule);
export const updateToolSourceSchemaWithHttp = z.intersection(
  sourceCoreWithHttp.omit({ slug: true, kind: true, ownerScope: true, orgId: true }).partial().extend(updateOnly),
  z.union([toolSourceAuthConfigSchema, z.object({})]),
);
export const patchToolSourceToolSchema = z.object({
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((v) => v.tier !== undefined || v.enabled !== undefined, 'nothing to patch');
export const bulkEnableToolsSchema = z.object({ mode: z.enum(['enable_reads', 'disable_all']) });
export const testToolCallSchema = z.object({ input: z.record(z.string(), z.unknown()).default({}) });

export function qualifiedToolName(slug: string, name: string): string { return `${slug}__${name}`; }
export function splitQualifiedToolName(q: string): { slug: string; name: string } | null {
  const i = q.indexOf('__');
  if (i <= 0) return null;
  const slug = q.slice(0, i); const name = q.slice(i + 2);
  if (!TOOL_SOURCE_SLUG_RE.test(slug) || !SOURCE_TOOL_NAME_RE.test(name)) return null;
  return { slug, name };
}
export function isTenantToolName(q: string): boolean { return splitQualifiedToolName(q) !== null; }
export type CreateToolSourceInput = z.infer<typeof createToolSourceSchema>;
export type UpdateToolSourceInput = z.infer<typeof updateToolSourceSchema>;
export type PatchToolSourceToolInput = z.infer<typeof patchToolSourceToolSchema>;
