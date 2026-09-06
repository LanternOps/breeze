import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
  type AuthContext,
} from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { resolveImportPartnerId } from '../importScope';
import {
  commitDeviceCustomFieldImport,
  previewDeviceCustomFieldImport,
  type ValueImportContext,
} from '../../services/customFields/import/valueImport';
import { writeCustomFieldValueImportAudits } from '../../services/customFields/import/audit';
import {
  DEFAULT_IMPORT_SYSTEM,
  MAX_IMPORT_ROWS,
  MAX_IMPORT_VALUES,
} from '../../services/customFields/import/types';

/**
 * The VALUES half of the RMM custom-field importer (#3257 W08):
 * `POST /devices/custom-fields/import/preview` and
 * `POST /devices/custom-fields/import`.
 *
 * Lives under `/devices` rather than beside the definitions pair
 * (`routes/customFieldImport.ts`) because it is a different pipeline with
 * different tenancy: definitions are dual-axis config owned by an organization
 * XOR a partner, values are device-scoped rows in one organization.
 *
 * ── Auth wiring — PER-ROUTE, never `.use('*')` ──────────────────────────────
 * A wildcard `.use('*')` in a sub-router attaches to every route mounted AFTER
 * it in `devices/index.ts`. This router is mounted immediately after
 * `customFieldValuesRoutes`, whose X-API-Key branch a wildcard here would
 * shadow and whose 401 it would resurrect (issue #2066) — so the middleware is
 * attached per route and `customFieldImport.mountorder.test.ts` proves, through
 * the fully-assembled router, that the API-key PATCH still reaches its handler.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * There is **no `dualAuth` / X-API-Key branch**, matching W07. `dualAuth`
 * applies `requireMfa` only on the JWT branch and skips the site allowlist for
 * API keys; an unattended integration is not a user of a one-off migration
 * tool. With plain `authMiddleware` an X-API-Key-only request never
 * authenticates at all — a 401, which is the intended answer.
 *
 * ── Always 200 ─────────────────────────────────────────────────────────────
 * Both routes answer 200 even with a non-empty `errors[]`. The web caller
 * consumes them through `runAction`, which reads a failure body as a hard
 * failure and would hide the rows that DID import. Per-row problems ride as
 * typed `errors[].code`, never free text.
 */

export const customFieldImportRoutes = new Hono();

// The same grant the device custom-field VALUE write path requires
// (`routes/devices/customFieldValues.ts`). An importer must not be a cheaper
// way to reach a write than the endpoint it bulk-loads.
const requireDeviceWrite = requirePermission(
  PERMISSIONS.DEVICES_WRITE.resource,
  PERMISSIONS.DEVICES_WRITE.action,
);

const WARRANTY_FIELDS = ['warrantyStartDate', 'warrantyEndDate', 'manufacturer'] as const;

const ROW_CAP_MESSAGE =
  `At most ${MAX_IMPORT_ROWS} device rows per request — split the file into chunks`;
const VALUE_CAP_MESSAGE =
  `At most ${MAX_IMPORT_VALUES} values per request — split the file into smaller chunks`;
const AMBIGUOUS_NEEDS_PIN =
  'expectedDeviceId is required when expectedOutcome is "ambiguous"';

/**
 * Where one mapped column lands. Mirrors `MappingTarget`, so the parsed body
 * matches the service's own union exactly and nothing downstream re-checks it.
 *
 * `fieldKey` deliberately carries NO `^[a-z][a-z0-9_]*$` regex, unlike the
 * definitions importer's create rows. A key that could never own a definition
 * simply has none, and the value is annotated `no-definition` — one bad column
 * header in a thirty-column file must not 400 the whole batch, which is the
 * entire reason this importer annotates per value.
 */
const mappingTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('customField'), fieldKey: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('warranty'), field: z.enum(WARRANTY_FIELDS) }),
]);

// Mirrors `customFieldValueSchema` in `routes/devices/customFieldValues.ts`, so
// a bulk write cannot carry a value the single PATCH would reject on size.
const importValueSchema = z.object({
  target: mappingTargetSchema,
  value: z.union([z.string().max(10000), z.number(), z.boolean(), z.null()]),
});

/**
 * Identifiers are all optional and none is required. A row that supplies none
 * resolves to `not-found` and is reported as such — the same treatment as a row
 * whose identifiers matched nothing, and far more useful to an operator with a
 * mis-mapped join column than a 400 naming a row index.
 */
const importRowFields = {
  organizationId: z.string().guid().nullish(),
  deviceId: z.string().guid().nullish(),
  externalSystem: z.string().min(1).max(64).nullish(),
  externalId: z.string().min(1).max(255).nullish(),
  /** Reserved discriminator for the external-link key; always null today. */
  externalSourceInstance: z.string().min(1).max(255).nullish(),
  serialNumber: z.string().max(255).nullish(),
  hostname: z.string().max(255).nullish(),
  values: z.array(importValueSchema).max(MAX_IMPORT_VALUES),
};

const previewRowSchema = z.object(importRowFields);

/**
 * A row as submitted to a COMMIT. Both acknowledgements are re-checked against
 * freshly derived state, so a stale one is refused rather than applied.
 *
 * `expectedDeviceId` is REQUIRED for `ambiguous`: without it the
 * acknowledgement says "apply this" without saying to WHOM, and an approval
 * given for device A would be honoured against device B if the candidate set
 * moved between preview and commit.
 */
const commitRowSchema = z
  .object({
    ...importRowFields,
    expectedOutcome: z
      .enum(['matched', 'link-match', 'ambiguous', 'not-found', 'org-not-found', 'identity-conflict'])
      .optional(),
    expectedDeviceId: z.string().guid().optional(),
  })
  .refine(
    (row) => row.expectedOutcome !== 'ambiguous' || row.expectedDeviceId !== undefined,
    { message: AMBIGUOUS_NEEDS_PIN, path: ['expectedDeviceId'] },
  );

/**
 * The row cap alone does not bound the work: 1000 rows x 30 values is 30,000
 * writes in one request. Both caps are enforced here, with copy that tells the
 * browser to SPLIT rather than merely refusing it.
 */
function rowsSchema<T extends z.ZodTypeAny>(row: T) {
  return z
    .array(row)
    .min(1)
    .max(MAX_IMPORT_ROWS, ROW_CAP_MESSAGE)
    .refine(
      (rows) => rows.reduce((total, r) => total + (r as { values: unknown[] }).values.length, 0) <= MAX_IMPORT_VALUES,
      { message: VALUE_CAP_MESSAGE },
    );
}

const importOptionFields = {
  partnerId: z.string().guid().optional(),
  /** Free-form on the wire (see IMPORT_SYSTEMS); recorded in the audit trail. */
  externalSystem: z.string().min(1).max(64).default(DEFAULT_IMPORT_SYSTEM),
  /** Verbatim from the contacts importer, including the default. */
  mode: z.enum(['skip', 'update']).default('skip'),
  /** Decision 7: an operator opt-in, off by default. */
  overrideProviderWarranty: z.boolean().default(false),
};

const previewImportSchema = z.object({ ...importOptionFields, rows: rowsSchema(previewRowSchema) });
const commitImportSchema = z.object({ ...importOptionFields, rows: rowsSchema(commitRowSchema) });

type ImportBody = z.infer<typeof previewImportSchema>;

/**
 * Resolve the partner and the caller's reach.
 *
 * The site allowlist is carried explicitly because RLS NEVER covered the site
 * axis — the predicate W06's snapshot loader builds from it is its only
 * enforcement. A missing `permissions` context on this path means a gate was
 * dropped upstream (every route here runs `requirePermission`), so it denies
 * rather than degrading into "no site restriction", mirroring
 * `loadAccessibleDevice`'s fail-closed stance in `customFieldValues.ts`.
 *
 * `accessibleOrgIds` travels with the request for the same reason it does in
 * W07: the resolution snapshot READ runs in a SYSTEM db context, so RLS is not
 * the boundary on it and this is. Null is system scope; for an organization
 * token it is that single org, which is what makes admitting that scope safe —
 * a row naming any other organization comes back `org-not-found` and writes
 * nothing, the same answer an organization that does not exist gets, so the
 * response is never an existence oracle.
 */
function resolveValueImportContext(
  auth: AuthContext,
  permissions: UserPermissions | undefined,
  body: ImportBody,
): ValueImportContext | { error: string; status: 400 | 403 } {
  const resolved = resolveImportPartnerId(auth, body.partnerId, 'device custom fields');
  if ('error' in resolved) return resolved;

  if (!permissions) {
    return { error: 'Access denied', status: 403 };
  }

  return {
    partnerId: resolved.partnerId,
    accessibleOrgIds: auth.accessibleOrgIds ?? null,
    allowedSiteIds: permissions.allowedSiteIds ?? null,
    mode: body.mode,
    overrideProviderWarranty: body.overrideProviderWarranty,
  };
}

customFieldImportRoutes.post(
  '/custom-fields/import/preview',
  authMiddleware,
  // `organization` must be in this list: an org-scoped token carries a
  // partnerId and its single-org allowlist bounds the reach, matching W07.
  requireScope('organization', 'partner', 'system'),
  requireDeviceWrite,
  // A bulk backfill across a partner's whole fleet is exactly the operation
  // that should need it.
  requireMfa(),
  zValidator('json', previewImportSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const body = c.req.valid('json');
    const ctx = resolveValueImportContext(auth, c.get('permissions') as UserPermissions | undefined, body);
    if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status);

    return c.json({ rows: await previewDeviceCustomFieldImport(body.rows, ctx) });
  },
);

customFieldImportRoutes.post(
  '/custom-fields/import',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requireDeviceWrite,
  requireMfa(),
  zValidator('json', commitImportSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const body = c.req.valid('json');
    const ctx = resolveValueImportContext(auth, c.get('permissions') as UserPermissions | undefined, body);
    if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status);

    const summary = await commitDeviceCustomFieldImport(body.rows, ctx, { userId: auth.user?.id ?? null });

    // The service has no Hono context, so the route fans the audits out from
    // the summary.
    //
    // Guarded, unlike a plain CRUD route's single `writeRouteAudit`: the rows
    // are ALREADY COMMITTED by this point and `writeAuditEventAsync` does its
    // payload sanitisation synchronously on this stack. A throw from that
    // prelude would escape as a 500 describing a request that in fact
    // succeeded — the exact "hide the rows that DID import" failure the
    // always-200 contract exists to prevent. Losing an audit event is bad;
    // misreporting a successful import as a total failure is worse, and the
    // loss is loud in the log either way.
    try {
      writeCustomFieldValueImportAudits(c, {
        summary,
        rowCount: body.rows.length,
        externalSystem: body.externalSystem,
      });
    } catch (err) {
      console.error('[device-custom-field-import] audit write failed', {
        devices: summary.rows.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return c.json(summary);
  },
);
