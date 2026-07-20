import { valid as validSemver, validRange } from 'semver';
import { z } from 'zod';

export const SUPPORTED_EXTENSION_CAPABILITIES = [
  'server.routes.v1',
  'server.agent-routes.v1',
  'server.jobs.v1',
  'server.ai-tools.v1',
  'server.db.rls.v1',
  'server.secrets.v1',
  'server.audit.v1',
  'web.pages.v1',
  'web.navigation.v1',
  'web.slots.v1',
] as const;

/**
 * Route namespaces already owned by the Breeze API.
 *
 * Mirrored verbatim in packages/extension-api/src/legacy.ts; the two sets are
 * asserted equal by packages/extension-api/src/index.test.ts, which also
 * derives the core mounts from apps/api/src/index.ts at test time so a new
 * core mount that isn't reserved here fails the build automatically.
 *
 * Exception: `api.route('/', subRouter)` mounts declare their segments in
 * another file and are reserved by hand; a tripwire test pins how many exist.
 * See the fuller note in packages/extension-api/src/legacy.ts.
 */
export const RESERVED_ROUTE_NAMESPACES = new Set([
  'access-reviews', 'accounting', 'admin', 'agent-versions', 'agent-ws',
  'agents', 'ai', 'alert-templates', 'alerts', 'analytics', 'api-keys',
  'audit-baselines', 'audit-logs', 'auth', 'authenticator', 'automations',
  'backup', 'billing', 'browser-security', 'c2c', 'catalog', 'changes',
  'cis',
  'client-ai', 'config', 'configuration-policies', 'contracts',
  'custom-fields', 'deployments', 'desktop-ws', 'dev', 'device-groups',
  'devices', 'discovery', 'dns-security', 'docs', 'dr', 'enrollment-keys',
  'events', 'ext', 'extensions', 'filters', 'google', 'groups', 'helper',
  'huntress',
  'incidents', 'installer', 'integrations', 'internal', 'invoices', 'logs',
  'm365', 'maintenance', 'mcp', 'me', 'metrics', 'mobile', 'monitoring',
  'monitors', 'network', 'notifications', 'oauth', 'onedrive', 'orgs',
  'pam', 'partner', 'partner-api', 'partner-service-principals', 'partners',
  'patch-policies', 'patches', 'pax8',
  'peripherals', 'permissions', 'playbooks', 'plugins', 'policies',
  'portal', 'psa', 'quotes', 'reliability', 'remediation-suggestions',
  'remote', 'reports', 'roles', 's', 's1', 'script-library', 'scripts',
  'search', 'security', 'sensitive-data', 'service-principals', 'settings',
  'snmp', 'software',
  'software-inventory', 'software-policies', 'sso', 'support',
  'system', 'system-tools', 'tags', 'third-party-catalog',
  'ticket-categories', 'ticket-config', 'ticket-forms',
  'ticket-response-templates', 'tickets', 'time-entries', 'tunnel-http', 'tunnel-ws',
  'tunnels', 'unifi', 'update-rings', 'user-risk', 'users', 'viewers',
  'vnc-exchange', 'vnc-viewer', 'vulnerabilities', 'webhooks',
]);

export const SHARED_TABLE_ALLOWLIST: ReadonlySet<string> = new Set(['memory_blocks']);

export const TENANT_SCOPE_COLUMNS: readonly string[] = [
  'org_id',
  'partner_id',
  'site_id',
  'device_id',
];

const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
const IDENTIFIER_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const CUSTOM_ELEMENT_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

function isSafeRelativePath(value: string): boolean {
  if (value.startsWith('/') || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.every((segment) => (
    segment !== ''
    && segment !== '.'
    && segment !== '..'
    && /^[A-Za-z0-9._-]+$/.test(segment)
  ));
}

const nonemptyString = z.string().trim().min(1);
const identifier = z.string().regex(IDENTIFIER_RE);
const semver = z.string().refine((value) => validSemver(value) !== null, {
  message: 'must be a valid semantic version',
});
const semverRange = nonemptyString.refine((value) => validRange(value) !== null, {
  message: 'must be a valid semantic-version range',
});
const safeRelativePath = z.string().min(1).refine(isSafeRelativePath, {
  message: 'must be a safe relative path without traversal or backslashes',
});
const safeJavaScriptPath = safeRelativePath.refine((value) => /\.(?:c|m)?js$/.test(value), {
  message: 'must point to a .js, .cjs, or .mjs file',
});
const absoluteWebPath = z
  .string()
  .regex(/^\/[a-zA-Z0-9\-_./]*$/, { message: 'must be an absolute web path' })
  .refine((value) => !value.split('/').includes('..'), { message: 'must not traverse parent paths' });

function uniqueBy<T>(values: readonly T[], key: (value: T) => string | undefined): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    const current = key(value);
    if (current === undefined) continue;
    if (seen.has(current)) return false;
    seen.add(current);
  }
  return true;
}

const tenancySchema = z.object({
  orgCascadeDeleteTables: z.array(z.string()).default([]),
  deviceCascadeDeleteTables: z.array(z.string()).default([]),
  deviceOrgDenormalizedTables: z.array(z.string()).default([]),
  deviceOrgMoveDeleteTables: z.array(z.string()).optional(),
  nonTenantTables: z.array(z.string()).optional(),
}).strict();

const pageSchema = z.object({
  id: identifier.optional(),
  path: absoluteWebPath,
  element: z.string().regex(CUSTOM_ELEMENT_RE),
}).strict();

const navigationSchema = z.object({
  id: identifier.optional(),
  label: nonemptyString,
  path: absoluteWebPath,
  order: z.number().int().finite().optional(),
}).strict();

const slotSchema = z.object({
  id: identifier.optional(),
  slot: identifier,
  contractVersion: z.number().int().positive(),
  element: z.string().regex(CUSTOM_ELEMENT_RE),
  label: nonemptyString.optional(),
  order: z.number().int().finite().optional(),
}).strict();

const webSchema = z.object({
  entry: safeJavaScriptPath,
  pages: z.array(pageSchema),
  navigation: z.array(navigationSchema),
  slots: z.array(slotSchema),
}).strict();

const jobSchema = z.object({
  name: identifier,
  cron: nonemptyString,
}).strict();

const aiToolSchema = z.object({
  name: identifier,
}).strict();

const capabilitySchema = z.enum(SUPPORTED_EXTENSION_CAPABILITIES);

const manifestSchemaV1 = z.object({
  apiVersion: z.literal('breeze.extensions/v1'),
  name: z.string().regex(NAME_RE).refine((name) => name !== 'plugins', {
    message: '"plugins" collides with the existing plugin-catalog feature',
  }),
  version: semver,
  routeNamespace: z.string().regex(NAME_RE).refine(
    (namespace) => !RESERVED_ROUTE_NAMESPACES.has(namespace),
    { message: 'routeNamespace collides with a core /api/v1 mount' },
  ),
  requires: z.object({
    breeze: semverRange,
    serverSdk: semverRange,
    webSdk: semverRange.optional(),
    capabilities: z.array(capabilitySchema).refine(
      (capabilities) => new Set(capabilities).size === capabilities.length,
      { message: 'capabilities must be unique' },
    ),
  }).strict(),
  server: z.object({ entry: safeJavaScriptPath }).strict(),
  web: webSchema.optional(),
  migrationsDir: safeRelativePath.default('migrations'),
  schemaCompatibilityFloor: semver,
  publicRoutes: z.array(
    z.string()
      .regex(/^\/[a-zA-Z0-9\-_./]*(\/\*)?$/, {
        message: 'publicRoutes entries must be absolute sub-paths like "/health" or "/webhooks/*"',
      })
      .refine((path) => !path.split('/').some((segment) => segment === '.' || segment === '..'), {
        message: 'publicRoutes entries may not contain "." or ".." path segments',
      })
      .refine((path) => path !== '/' && path !== '/*', {
        message: 'publicRoutes may not blanket the whole namespace',
      })
      .refine((path) => path !== '/agent' && !path.startsWith('/agent/'), {
        message: 'publicRoutes may not expose /agent/ paths',
      }),
  ).optional(),
  agentRoutes: z.boolean().optional(),
  // TODO(runtime-platform): carry legacy helperRoutes forward as capability
  // 'server.helper-routes.v1' (see internal/plans/2026-07-18-workspace-finder-phase3-plan.md).
  jobs: z.array(jobSchema),
  aiTools: z.array(aiToolSchema),
  tenancy: tenancySchema.default({
    orgCascadeDeleteTables: [],
    deviceCascadeDeleteTables: [],
    deviceOrgDenormalizedTables: [],
  }),
}).strict().superRefine((manifest, ctx) => {
  if (manifest.web && !manifest.requires.webSdk) {
    ctx.addIssue({ code: 'custom', path: ['requires', 'webSdk'], message: 'webSdk is required when web is declared' });
  }
  if (!uniqueBy(manifest.jobs, (job) => job.name)) {
    ctx.addIssue({ code: 'custom', path: ['jobs'], message: 'job names must be unique' });
  }
  if (!uniqueBy(manifest.aiTools, (tool) => tool.name)) {
    ctx.addIssue({ code: 'custom', path: ['aiTools'], message: 'AI tool names must be unique' });
  }
  if (manifest.web && (
    !uniqueBy(manifest.web.pages, (page) => page.id)
    || !uniqueBy(manifest.web.pages, (page) => page.path)
  )) {
    ctx.addIssue({ code: 'custom', path: ['web', 'pages'], message: 'page declarations must be unique' });
  }
  if (manifest.web && (
    !uniqueBy(manifest.web.slots, (slot) => slot.id)
    || !uniqueBy(manifest.web.slots, (slot) => `${slot.slot}:${slot.element}`)
  )) {
    ctx.addIssue({ code: 'custom', path: ['web', 'slots'], message: 'slot declarations must be unique' });
  }

  const tenantTables = [
    ...manifest.tenancy.orgCascadeDeleteTables,
    ...manifest.tenancy.deviceCascadeDeleteTables,
    ...manifest.tenancy.deviceOrgDenormalizedTables,
    ...(manifest.tenancy.deviceOrgMoveDeleteTables ?? []),
  ];
  const nonTenantTables = manifest.tenancy.nonTenantTables ?? [];
  for (const table of [...tenantTables, ...nonTenantTables]) {
    if (!SHARED_TABLE_ALLOWLIST.has(table) && !table.startsWith(`${manifest.name}_`)) {
      ctx.addIssue({ code: 'custom', path: ['tenancy'], message: `table "${table}" must be prefixed "${manifest.name}_" (or be an allowlisted shared table)` });
    }
  }
  const tenantSet = new Set(tenantTables);
  for (const table of nonTenantTables) {
    if (tenantSet.has(table)) {
      ctx.addIssue({ code: 'custom', path: ['tenancy'], message: `table "${table}" is declared in BOTH a tenancy array and tenancy.nonTenantTables` });
    }
  }
});

export type ExtensionCapability = (typeof SUPPORTED_EXTENSION_CAPABILITIES)[number];
export type ExtensionTenancyDeclaration = z.infer<typeof tenancySchema>;
export type ExtensionManifestV1 = z.infer<typeof manifestSchemaV1>;

export function parseExtensionManifestV1(raw: unknown): ExtensionManifestV1 {
  try {
    return manifestSchemaV1.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error(z.prettifyError(error));
    throw error;
  }
}

/**
 * Non-throwing counterpart to {@link parseExtensionManifestV1}. Returns the raw
 * Zod result so callers (e.g. the conformance testkit) can enumerate every issue
 * with its structured `path`/`code`, rather than a flattened, prettified string.
 */
export function safeParseExtensionManifestV1(
  raw: unknown,
): z.ZodSafeParseResult<ExtensionManifestV1> {
  return manifestSchemaV1.safeParse(raw);
}
