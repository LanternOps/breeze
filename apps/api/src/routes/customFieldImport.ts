import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import {
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
  canManagePartnerWidePolicies,
} from '../services/partnerWideAccess';
import { resolveImportPartnerId } from './importScope';
import {
  commitCustomFieldDefinitionImport,
  previewCustomFieldDefinitionImport,
  type DefinitionImportContext,
} from '../services/customFields/import/definitionImport';
import { writeCustomFieldDefinitionImportAudits } from '../services/customFields/import/audit';
import { DEFAULT_IMPORT_SYSTEM, MAX_IMPORT_ROWS } from '../services/customFields/import/types';

/**
 * The DEFINITIONS half of the RMM custom-field importer (#3257 W07):
 * `POST /custom-fields/import/preview` and `POST /custom-fields/import`.
 *
 * A separate Hono app mounted at the same `/custom-fields` prefix as
 * `customFieldRoutes`, rather than registered onto it, so the importer's
 * schemas and its partner-wide gate stay out of the CRUD file. It carries its
 * own `authMiddleware` for the same reason `customFieldRoutes` does: mounting
 * without one would silently skip auth.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * There is **no `dualAuth` / X-API-Key branch**. `dualAuth` applies `requireMfa`
 * only on the JWT branch and skips the site allowlist for API keys, and an
 * unattended integration is not a user of a one-off migration tool. With plain
 * `authMiddleware` an X-API-Key-only request never authenticates at all — it is
 * a 401, which is the intended answer.
 *
 * Values (W08) are a different pipeline with different tenancy and live under
 * `/devices`.
 */

export const customFieldImportRoutes = new Hono();

customFieldImportRoutes.use('*', authMiddleware);

// PERMISSIONS.ORGS_WRITE would be wrong here: a custom field is device
// metadata, and this is the same grant the sibling `POST /custom-fields`
// create route requires.
const requireCustomFieldWrite = requirePermission(
  PERMISSIONS.DEVICES_WRITE.resource,
  PERMISSIONS.DEVICES_WRITE.action,
);

// Mirrors `routes/customFields.ts` — the same enum, the same key regex and the
// same options contract, restated locally for the same reason that file states
// them locally rather than importing them across a rootDir boundary. A row this
// importer accepts must be one the single-create route would also accept.
const customFieldTypeSchema = z.enum(['text', 'number', 'boolean', 'dropdown', 'date']);

const customFieldChoiceSchema = z.union([
  z.string().min(1).max(255),
  z.object({ label: z.string().min(1).max(255), value: z.string().min(1).max(255) }),
]);

const customFieldOptionsSchema = z.object({
  choices: z.array(customFieldChoiceSchema).max(200).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  pattern: z.string().max(512).optional(),
  placeholder: z.string().max(255).optional(),
});

const ORG_SCOPE_NEEDS_ORG_ID = 'organizationId is required when ownerScope is "organization"';
const ALREADY_EXISTS_NEEDS_PIN =
  'expectedDefinitionId is required when expectedAnnotation is "already-exists"';

/** The base object is kept unrefined so the commit variant can extend it. */
const definitionImportRowFields = z.object({
  fieldKey: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_]*$/, 'Field key must be lowercase alphanumeric with underscores'),
  name: z.string().min(1).max(100),
  type: customFieldTypeSchema,
  options: customFieldOptionsSchema.nullish(),
  required: z.boolean().optional(),
  deviceTypes: z.array(z.enum(['windows', 'macos', 'linux'])).nullish(),
  ownerScope: z.enum(['partner', 'organization']),
  organizationId: z.string().guid().optional(),
  /** e.g. `udf7` — preserved in the audit, never stored. */
  sourceLabel: z.string().min(1).max(120).optional(),
});

function requiresOrganizationId(value: { ownerScope: string; organizationId?: string }): boolean {
  return value.ownerScope !== 'organization' || value.organizationId !== undefined;
}

const definitionImportRowSchema = definitionImportRowFields.refine(requiresOrganizationId, {
  message: ORG_SCOPE_NEEDS_ORG_ID,
  path: ['organizationId'],
});

/**
 * A row as submitted to a COMMIT. Both acknowledgements are checked against
 * freshly re-derived state, so a stale one is refused rather than applied.
 *
 * `expectedDefinitionId` is REQUIRED for `already-exists`: without it the
 * acknowledgement says "this row is already that field" without saying WHICH
 * field, so an approval given for definition A would be honoured against
 * definition B if the key changed hands between preview and commit.
 */
const commitDefinitionImportRowSchema = definitionImportRowFields
  .extend({
    expectedAnnotation: z
      .enum(['create', 'already-exists', 'type-conflict', 'key-shadowed', 'org-not-found', 'partner-wide-denied'])
      .optional(),
    expectedDefinitionId: z.string().guid().optional(),
  })
  .refine(requiresOrganizationId, { message: ORG_SCOPE_NEEDS_ORG_ID, path: ['organizationId'] })
  .refine(
    (value) => value.expectedAnnotation !== 'already-exists' || value.expectedDefinitionId !== undefined,
    { message: ALREADY_EXISTS_NEEDS_PIN, path: ['expectedDefinitionId'] },
  );

const previewImportSchema = z.object({
  partnerId: z.string().guid().optional(),
  /** Free-form on the wire (see IMPORT_SYSTEMS); recorded in the audit trail. */
  externalSystem: z.string().min(1).max(64).default(DEFAULT_IMPORT_SYSTEM),
  rows: z.array(definitionImportRowSchema).min(1).max(MAX_IMPORT_ROWS),
});

const commitImportSchema = z.object({
  partnerId: z.string().guid().optional(),
  externalSystem: z.string().min(1).max(64).default(DEFAULT_IMPORT_SYSTEM),
  rows: z.array(commitDefinitionImportRowSchema).min(1).max(MAX_IMPORT_ROWS),
});

type ImportBody = { partnerId?: string; rows: Array<{ ownerScope: 'partner' | 'organization' }> };

/**
 * Resolve the partner and the caller's reach, and refuse a partner-wide import
 * the caller may not perform.
 *
 * The capability refusal is a whole-request 403 rather than a per-row error,
 * matching the sibling `POST /custom-fields` create route (epic #2135): a
 * partner-wide field pushes config to EVERY organization under the partner,
 * including ones created later, so "you may not do this" is an authorization
 * answer and belongs in the same band as the scope and permission gates — not
 * mixed into a 200 that also reports data problems. The service still derives
 * its own `partner-wide-denied` annotation, because it is reachable directly
 * and must fail closed there too.
 */
function resolveDefinitionImportContext(
  auth: AuthContext,
  body: ImportBody,
): DefinitionImportContext | { error: string; status: 400 | 403 } {
  const resolved = resolveImportPartnerId(auth, body.partnerId, 'custom fields');
  if ('error' in resolved) return resolved;

  const canManagePartnerWide = canManagePartnerWidePolicies(auth);
  if (!canManagePartnerWide && body.rows.some((row) => row.ownerScope === 'partner')) {
    return { error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, status: 403 };
  }

  // The caller's own organization allowlist travels with the request: the
  // importer's snapshot READ runs in a SYSTEM db context (see the service
  // header — the table has no partner-wide RLS SELECT branch), so RLS is not
  // the boundary on it and this is. Null is system scope; for an organization
  // token it is the single org, which is what makes admitting that scope safe —
  // rows naming any other organization come back `org-not-found` and write
  // nothing.
  return {
    partnerId: resolved.partnerId,
    accessibleOrgIds: auth.accessibleOrgIds ?? null,
    canManagePartnerWide,
  };
}

customFieldImportRoutes.post(
  '/import/preview',
  // `organization` must be in this list: an org-scoped token carries a
  // partnerId and its single-org allowlist bounds the writes, matching
  // routes/orgContacts.ts.
  requireScope('organization', 'partner', 'system'),
  requireCustomFieldWrite,
  // A bulk backfill is exactly the operation that should need it.
  requireMfa(),
  zValidator('json', previewImportSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const body = c.req.valid('json');
    const ctx = resolveDefinitionImportContext(auth, body);
    if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status);

    return c.json({ rows: await previewCustomFieldDefinitionImport(body.rows, ctx) });
  },
);

customFieldImportRoutes.post(
  '/import',
  requireScope('organization', 'partner', 'system'),
  requireCustomFieldWrite,
  requireMfa(),
  zValidator('json', commitImportSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const body = c.req.valid('json');
    const ctx = resolveDefinitionImportContext(auth, body);
    if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status);

    const summary = await commitCustomFieldDefinitionImport(body.rows, ctx, {
      userId: auth.user?.id ?? null,
    });

    // The service has no Hono context, so every route that commits an import
    // must write the audit events here.
    writeCustomFieldDefinitionImportAudits(c, {
      summary,
      rows: body.rows,
      externalSystem: body.externalSystem,
    });

    // Always 200, including a partial success: the web caller consumes this
    // through runAction, which reads a failure body as a hard failure and would
    // hide the rows that DID import. Per-row problems are carried as typed
    // `errors[].code` instead.
    return c.json(summary);
  },
);
