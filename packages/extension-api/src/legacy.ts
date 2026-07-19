import { z } from 'zod';
import type { SQLWrapper } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { ExtensionJobDefinition } from '@breeze/extension-sdk';

/**
 * Route namespaces already mounted by core (apps/api/src/index.ts, /api/v1/*).
 * An extension may not shadow them. Keep in sync when core adds mounts.
 *
 * Regenerate the inner-mount list with:
 *   grep -oE "api\.route\('/[a-z0-9-]+" apps/api/src/index.ts
 * then add the outer-app mounts `oauth`, `settings`, and the shortlink
 * prefix `s`, which are mounted directly on the outer Hono app rather than
 * through the versioned `/api/v1` router. See src/index.test.ts for the
 * hand-maintained ground-truth contract this set is checked against.
 */
export const RESERVED_ROUTE_NAMESPACES = new Set([
  'access-reviews', 'accounting', 'admin', 'agent-versions', 'agent-ws',
  'agents', 'ai', 'alert-templates', 'alerts', 'analytics', 'api-keys',
  'audit-baselines', 'audit-logs', 'auth', 'authenticator', 'automations',
  'backup', 'browser-security', 'c2c', 'catalog', 'changes', 'cis',
  'client-ai', 'config', 'configuration-policies', 'contracts',
  'custom-fields', 'deployments', 'desktop-ws', 'dev', 'device-groups',
  'devices', 'discovery', 'dns-security', 'docs', 'dr', 'enrollment-keys',
  'events', 'ext', 'extensions', 'filters', 'google', 'groups', 'helper',
  'huntress',
  'incidents', 'installer', 'integrations', 'internal', 'invoices', 'logs',
  'm365', 'maintenance', 'mcp', 'me', 'metrics', 'mobile', 'monitoring',
  'monitors', 'network', 'notifications', 'oauth', 'onedrive', 'orgs',
  'pam', 'partner', 'partners', 'patch-policies', 'patches', 'pax8',
  'peripherals', 'permissions', 'playbooks', 'plugins', 'policies',
  'portal', 'psa', 'quotes', 'reliability', 'remediation-suggestions',
  'remote', 'reports', 'roles', 's', 's1', 'script-library', 'scripts',
  'search', 'security', 'sensitive-data', 'settings', 'snmp', 'software',
  'software-inventory', 'software-policies', 'sso', 'system',
  'system-tools', 'tags', 'third-party-catalog', 'ticket-categories',
  'ticket-config', 'tickets', 'time-entries', 'tunnel-http', 'tunnel-ws',
  'tunnels', 'unifi', 'update-rings', 'user-risk', 'users', 'viewers',
  'vnc-exchange', 'vnc-viewer', 'vulnerabilities', 'webhooks',
]);

const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Tables an extension may reference that are NOT `<name>_`-prefixed, because
 * they are deliberately shared across extensions and owned by core.
 *
 * Exported so the loader's boot-time tripwire can apply the same exemption when
 * it reconciles the live catalog against the manifest — a shared table is not
 * the extension's to declare or to own.
 */
export const SHARED_TABLE_ALLOWLIST: ReadonlySet<string> = new Set(['memory_blocks']);

/**
 * Columns that mark a table as tenant-scoped. Used by the loader to reject a
 * `nonTenantTables` opt-out for a table that is plainly tenant data. Covers the
 * tenancy hierarchy: Partner -> Organization -> Site -> Device.
 *
 * This is a HINT, not the contract. Column names are chosen by the policed
 * party, so `organization_id` / `tenant_id` / `customer_id` would sail straight
 * past a name match. The load-bearing check is the FOREIGN-KEY one in the loader
 * (CORE_TENANT_FK_TABLES): a genuinely global lookup table has no FK into a
 * tenant entity, whatever it calls its columns. Keep both — names catch the
 * denormalized tables that carry no FK, keys catch the renamed ones.
 *
 * `user_id` is deliberately NOT here: it appears on plenty of genuinely global
 * tables as a plain actor/author reference (shape 6, user-id-scoped, is an
 * explicit core allowlist rather than an auto-discovered shape), so treating it
 * as a tenancy signal would produce false boot failures. The FK check covers the
 * cases that matter.
 */
export const TENANT_SCOPE_COLUMNS: readonly string[] = [
  'org_id',
  'partner_id',
  'site_id',
  'device_id',
];

const tenancySchema = z.object({
  /** org_id-bearing tables, deleted by org cascade before `organizations`. */
  orgCascadeDeleteTables: z.array(z.string()).default([]),
  /** device_id tables hard-deleted before the device row (FK order, children first). */
  deviceCascadeDeleteTables: z.array(z.string()).default([]),
  /** device_id + org_id tables whose org_id is rewritten when a device moves org. */
  deviceOrgDenormalizedTables: z.array(z.string()).default([]),
  /** device_id tables whose rows are deleted when a device moves org. */
  deviceOrgMoveDeleteTables: z.array(z.string()).optional(),
  /**
   * Tables the extension creates that are deliberately NOT tenant-scoped —
   * global lookup/catalog data carrying no org_id/partner_id/device_id.
   *
   * This is an explicit OPT-OUT, not a free pass. The loader reconciles the
   * live catalog against the manifest at boot and fails on any `<name>_`-
   * prefixed table declared nowhere; listing a table here is how an extension
   * says "this one is global on purpose", making it a deliberate, reviewable
   * act rather than a silent omission. The loader still verifies the claim
   * against pg_attribute: a table listed here that actually carries a tenant
   * column fails the boot, so this cannot be used to smuggle a tenant table
   * past the RLS tripwire.
   */
  nonTenantTables: z.array(z.string()).optional(),
});

const manifestSchema = z
  .object({
    name: z.string().regex(NAME_RE).refine((n) => n !== 'plugins', {
      message: '"plugins" collides with the existing plugin-catalog feature',
    }),
    routeNamespace: z
      .string()
      .regex(NAME_RE)
      .refine((ns) => !RESERVED_ROUTE_NAMESPACES.has(ns), {
        message: 'routeNamespace collides with a core /api/v1 mount',
      }),
    entry: z.string().min(1),
    migrationsDir: z.string().min(1).default('migrations'),
    // Opts /api/v1/<routeNamespace>/agent/ out of the global per-IP rate
    // limiter (agent-token auth carries its own per-agent/org limits). The
    // loader grants the exemption only for prefixes it wraps with
    // agentAuthMiddleware itself — manifest trust alone never lifts the limit.
    agentRoutes: z.boolean().optional(),
    // Routes /api/v1/<routeNamespace>/helper/ through the core helper
    // (Breeze Assist device-token) auth middleware instead of user auth.
    // Helper paths can never be listed in publicRoutes.
    helperRoutes: z.boolean().default(false),
    // Default-deny escape hatch: sub-paths (relative to /api/v1/<routeNamespace>)
    // served WITHOUT core auth. Exact paths ('/health') or prefix wildcards
    // ('/webhooks/*'). Everything not listed here gets authMiddleware
    // (or agentAuthMiddleware under /agent/) applied by the loader.
    publicRoutes: z
      .array(
        z
          .string()
          .regex(/^\/[a-zA-Z0-9\-_./]*(\/\*)?$/, {
            message: 'publicRoutes entries must be absolute sub-paths like "/health" or "/webhooks/*"',
          })
          .refine((p) => p !== '/' && p !== '/*', {
            message: 'publicRoutes may not blanket the whole namespace ("/" or "/*") — default-deny would be meaningless',
          })
          .refine((p) => p !== '/agent' && !p.startsWith('/agent/'), {
            message: 'publicRoutes may not expose /agent/ paths — they must stay behind agentAuthMiddleware (they are exempt from the global rate limiter)',
          })
          .refine((p) => p !== '/helper' && !p.startsWith('/helper/'), {
            message: 'publicRoutes may not expose /helper/ paths — they must stay behind the core helper auth middleware',
          }),
      )
      .optional(),
    tenancy: tenancySchema.optional().default({
      orgCascadeDeleteTables: [],
      deviceCascadeDeleteTables: [],
      deviceOrgDenormalizedTables: [],
    }),
  })
  .superRefine((m, ctx) => {
    const tenantTables = [
      ...m.tenancy.orgCascadeDeleteTables,
      ...m.tenancy.deviceCascadeDeleteTables,
      ...m.tenancy.deviceOrgDenormalizedTables,
      ...(m.tenancy.deviceOrgMoveDeleteTables ?? []),
    ];
    const nonTenantTables = m.tenancy.nonTenantTables ?? [];
    // Every table an extension names — tenant-scoped or opted out — must carry
    // the extension's prefix. The loader's catalog reconciliation depends on
    // that prefix to decide which live tables an extension OWNS, so an
    // unprefixed declaration would be a table the tripwire can never find.
    for (const t of [...tenantTables, ...nonTenantTables]) {
      if (!SHARED_TABLE_ALLOWLIST.has(t) && !t.startsWith(`${m.name}_`)) {
        ctx.addIssue({
          code: 'custom',
          message: `table "${t}" must be prefixed "${m.name}_" (or be an allowlisted shared table)`,
        });
      }
    }
    // A table cannot be both tenant-scoped and deliberately global. Left
    // unchecked, the loader would demand RLS on it (as a tenant table) AND
    // demand it carry no tenant column (as a nonTenantTable) — an unsatisfiable
    // pair that would surface as a baffling double boot failure. Reject the
    // contradiction here, where the message can name the actual mistake.
    const tenantSet = new Set(tenantTables);
    for (const t of nonTenantTables) {
      if (tenantSet.has(t)) {
        ctx.addIssue({
          code: 'custom',
          message: `table "${t}" is declared in BOTH a tenancy array and tenancy.nonTenantTables — it is either tenant-scoped or it is not`,
        });
      }
    }
  });

export type ExtensionTenancyDeclaration = z.infer<typeof tenancySchema>;
export type LegacyExtensionManifest = z.infer<typeof manifestSchema>;

export function parseLegacyExtensionManifest(raw: unknown): LegacyExtensionManifest {
  try {
    return manifestSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new Error(z.prettifyError(err));
    }
    throw err;
  }
}

/** Structural mirror of apps/api AiTool — extensions never import @breeze/api. */
export interface AiToolLike {
  definition: { name: string; description: string; input_schema: Record<string, unknown> };
  tier: 1 | 2 | 3 | 4;
  handler: (input: Record<string, unknown>, auth: unknown) => Promise<string>;
  deviceArgs?: readonly string[];
}

/** Helper-device identity injected by the core helper authentication middleware. */
export interface ExtensionHelperDevice {
  id: string;
  agentId: string;
  orgId: string;
  siteId: string | null;
  hostname: string;
  osType: string;
  osVersion: string;
  agentVersion: string;
}

/** Agent identity injected by the core agent authentication middleware. */
export interface ExtensionAgentContext {
  deviceId: string;
  agentId: string;
  orgId: string;
  siteId: string | null;
  role: string;
}

/** Audit event accepted by the core audit pipeline. */
export interface ExtensionAuditEvent {
  orgId?: string | null;
  actorType?: 'user' | 'api_key' | 'agent' | 'system';
  actorId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  resourceName?: string;
  details?: Record<string, unknown>;
  result: 'success' | 'failure' | 'denied';
  errorMessage?: string;
}

/** Column-bound encryption helpers injected by core. */
export interface ExtensionSecrets {
  encryptForColumn(table: string, column: string, plaintext: string): string;
  decryptForColumn(table: string, column: string, ciphertext: string): string;
}

/**
 * Structural core database handle. Extensions cast this to their own Drizzle type:
 * `const db = ctx.db as unknown as PostgresJsDatabase;` The extension must pin the
 * same drizzle-orm version as core.
 */
export type ExtensionDatabase = {
  execute(query: SQLWrapper | string): Promise<unknown>;
} & Record<string, unknown>;

/** Injected by the core loader — the ONLY channel through which an extension touches Breeze. */
export interface LegacyExtensionContext {
  /**
   * Mounts subApp at /api/v1/<routeNamespace>. The loader default-denies:
   * `/agent/*` paths get core agentAuthMiddleware, everything else gets core
   * authMiddleware, unless the sub-path is listed in `manifest.publicRoutes`.
   * Extensions may still apply `ctx.authMiddleware` / `ctx.agentAuthMiddleware`
   * themselves (e.g. on public routes) — the injected handlers no-op when the
   * loader guard already authenticated the request.
   */
  mountRoute: (subApp: Hono) => void;
  /**
   * Registers a cron job the BullMQ job host will schedule and run. The job's
   * `name` MUST match a `jobs[].name` the manifest declares (the staging
   * session enforces declared-vs-registered parity), and `cron` is a standard
   * cron pattern. An extension that declares no jobs never calls this.
   *
   * OPTIONAL on the type so that adding it does not break the typecheck of
   * out-of-repo extensions that construct a `LegacyExtensionContext` literal
   * (e.g. in their own tests). The core loader ALWAYS provides it; an extension
   * that wants to register a job must therefore guard the call itself.
   */
  registerJob?: (job: ExtensionJobDefinition) => void;
  /** Core auth middleware, injected so the extension need not import @breeze/api. */
  authMiddleware: MiddlewareHandler;
  /** Core agent auth middleware; sets `c.get('agent')` and opens the org RLS context. */
  agentAuthMiddleware: MiddlewareHandler;
  /**
   * Core helper (Breeze Assist device-token) auth; sets `c.get('helperDevice')`
   * and an org-scoped synthetic auth, opens org RLS. Only meaningful when
   * manifest.helperRoutes is true.
   */
  helperAuthMiddleware: MiddlewareHandler;
  /** Core ALS-bound Drizzle handle; active RLS GUCs apply. */
  db: ExtensionDatabase;
  /** Core column-bound encryption helpers. */
  secrets: ExtensionSecrets;
  /** Queues an audit event with fire-and-forget retry semantics. */
  audit: (event: ExtensionAuditEvent) => Promise<void>;
  /** The shared AI tool registry map (keys = tool names; collisions throw in the loader). */
  aiTools: Map<string, AiToolLike>;
  log: (message: string) => void;
}

/** The default export shape of an extension's entry module. */
export interface LegacyBreezeExtension {
  register: (ctx: LegacyExtensionContext) => void | Promise<void>;
}
