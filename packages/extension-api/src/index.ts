import { z } from 'zod';
import type { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';

/**
 * Route namespaces already mounted by core (apps/api/src/index.ts, /api/v1/*).
 * An extension may not shadow them. Keep in sync when core adds mounts.
 */
const RESERVED_ROUTE_NAMESPACES = new Set([
  'auth', 'config', 'devices', 'plugins', 'ai', 'mcp', 'oauth', 'settings',
  'organizations', 'sites', 'alerts', 'scripts', 'automations', 'users',
  'partners', 'billing', 'tickets', 'reports', 'remote', 'desktop-ws',
]);

const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

const tenancySchema = z.object({
  /** org_id-bearing tables, deleted by org cascade before `organizations`. */
  orgCascadeDeleteTables: z.array(z.string()).default([]),
  /** device_id tables hard-deleted before the device row (FK order, children first). */
  deviceCascadeDeleteTables: z.array(z.string()).default([]),
  /** device_id + org_id tables whose org_id is rewritten when a device moves org. */
  deviceOrgDenormalizedTables: z.array(z.string()).default([]),
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
    tenancy: tenancySchema.optional().default({
      orgCascadeDeleteTables: [],
      deviceCascadeDeleteTables: [],
      deviceOrgDenormalizedTables: [],
    }),
  })
  .superRefine((m, ctx) => {
    const allTables = [
      ...m.tenancy.orgCascadeDeleteTables,
      ...m.tenancy.deviceCascadeDeleteTables,
      ...m.tenancy.deviceOrgDenormalizedTables,
    ];
    // memory_blocks is the shared Wick-shaped table, deliberately unprefixed.
    const SHARED_TABLE_ALLOWLIST = new Set(['memory_blocks']);
    for (const t of allTables) {
      if (!SHARED_TABLE_ALLOWLIST.has(t) && !t.startsWith(`${m.name}_`)) {
        ctx.addIssue({
          code: 'custom',
          message: `table "${t}" must be prefixed "${m.name}_" (or be an allowlisted shared table)`,
        });
      }
    }
  });

export type ExtensionTenancyDeclaration = z.infer<typeof tenancySchema>;
export type ExtensionManifest = z.infer<typeof manifestSchema>;

export function parseExtensionManifest(raw: unknown): ExtensionManifest {
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

/** Injected by the core loader — the ONLY channel through which an extension touches Breeze. */
export interface ExtensionContext {
  /** Mounts subApp at /api/v1/<routeNamespace>. Extension must apply its own auth middleware. */
  mountRoute: (subApp: Hono) => void;
  /** Core auth middleware, injected so the extension need not import @breeze/api. */
  authMiddleware: MiddlewareHandler;
  /** The shared AI tool registry map (keys = tool names; collisions throw in the loader). */
  aiTools: Map<string, AiToolLike>;
  log: (message: string) => void;
}

/** The default export shape of an extension's entry module. */
export interface BreezeExtension {
  register: (ctx: ExtensionContext) => void | Promise<void>;
}
