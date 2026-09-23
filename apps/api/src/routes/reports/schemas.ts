import { z } from 'zod';
import { BUSINESS_REPORT_TYPES, REPORT_TYPES } from '@breeze/shared';
import {
  endpointManagementConfigSchema,
  hardwareLifecycleConfigSchema,
  identityAccessConfigSchema,
  legacyReportConfigSchema,
  securityCompliancePostureConfigSchema,
  threatDetectionConfigSchema,
  vulnerabilityManagementConfigSchema,
} from '../../services/reportConfigSchemas';
// Value import of the registry is safe for the route-schema graph: it
// value-imports only zod schemas, the error classes and permission constants;
// every generator is reached through `await import` (see its header).
import { REPORT_GENERATORS, reportTypeDef, type ReportTypeDef } from '../../services/reportRegistry';

/** #3198 W02: the six per-type config schemas moved to
 *  `services/reportConfigSchemas.ts` (the service layer must not import the
 *  route layer). Re-exported here so existing importers keep working. */
export {
  endpointManagementConfigSchema,
  hardwareLifecycleConfigSchema,
  identityAccessConfigSchema,
  securityCompliancePostureConfigSchema,
  threatDetectionConfigSchema,
  vulnerabilityManagementConfigSchema,
};

/**
 * Every value of the `report_type` pgEnum, INCLUDING the internal ones. Reads
 * need the full union: `GET /reports?type=ai_org_narrative` is a legitimate
 * filter, and `GET /reports/:id` returns the stored row's type verbatim.
 *
 * Derived from the canonical tuple (#3198 spec §6, `@breeze/shared`) rather
 * than hand-listed — the three-way TS/zod/web duplication is collapsed to one
 * source; see `packages/shared/src/reportTypes.ts` for the per-type notes.
 * The two WRITE schemas below still narrow it — see `internalReportType`.
 */
export const reportTypeSchema = z.enum(REPORT_TYPES);

/** Report types a human may never create or generate on demand. */
export const INTERNAL_REPORT_TYPES = new Set(['ai_org_narrative', 'ai_fleet_design']);
/**
 * #3198 W02 (spec §3.5). Types whose scheduled delivery goes only to
 * `config.emailRecipients`, never to a `report_schedule_recipients` contact
 * row. Two structural reasons: these reports are internal to the MSP and never
 * portal-visible, and a PARTNER-owned definition cannot hold a contact
 * recipient at all (`report_schedule_recipients (report_id, org_id) →
 * reports(id, org_id)` is an org-only composite FK). The refusal is by TYPE, so
 * it applies to an org-owned business report too.
 *
 * A SECOND set beside INTERNAL_REPORT_TYPES on purpose: an internal type is one
 * a human may not create; these are creatable, they just cannot carry a contact.
 */
export const PARTNER_ONLY_DELIVERY_REPORT_TYPES: ReadonlySet<string> = new Set(BUSINESS_REPORT_TYPES);
const INTERNAL_REPORT_TYPE_MESSAGE = 'internal report type';

/** Applied to the CREATE and AD-HOC GENERATE schemas only — never to the read
 *  filter above. A 400 here is what keeps a technician from minting a second,
 *  human-owned "narrative" definition the agent scheduler would then ignore. */
const notInternalReportType = (type: string) => !INTERNAL_REPORT_TYPES.has(type);

/**
 * #3198 W01 ownership axis (mirrors routes/security/schemas.ts), made a
 * discriminated union on `ownerScope` in W02 (addendum B6):
 *  - 'organization' — a classic org report. `ownerScope` may be omitted; a
 *    missing discriminator selects no arm in zod, so `withDefaultOwnerScope`
 *    fills it in before the union sees the body.
 *  - 'partner' — a partner-owned cross-org aggregate. The server derives
 *    partner_id from the caller's own token (a client-supplied partner id is
 *    NEVER read), and `orgId` is refused outright: W01 accepted-and-ignored it,
 *    which answered 201 to a caller who believed they had aimed the report at
 *    one org.
 * Create-only: `updateReportSchema` forbids `ownerScope` entirely.
 */
function withDefaultOwnerScope(input: unknown): unknown {
  if (
    input !== null
    && typeof input === 'object'
    && !Array.isArray(input)
    && (input as Record<string, unknown>).ownerScope === undefined
  ) {
    return { ...(input as Record<string, unknown>), ownerScope: 'organization' };
  }
  return input;
}

const organizationOwnerFields = {
  ownerScope: z.literal('organization'),
  orgId: z.string().guid().optional(),
};
const partnerOwnerFields = {
  ownerScope: z.literal('partner'),
  orgId: z.never().optional(),
};

/** Shape-only: the per-type parse happens in the enclosing transform, once the
 *  sibling `type` is known. Loose so nothing is stripped before that parse. */
const unparsedConfigSchema = z.looseObject({}).optional().default({});

type ConfigParseResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: z.ZodError };

function configSchemaFor(type: string | undefined): z.ZodType<Record<string, unknown>> {
  if (type === undefined) return legacyReportConfigSchema;
  const def = (REPORT_GENERATORS as Readonly<Record<string, ReportTypeDef | undefined>>)[type];
  return def?.configSchema ?? legacyReportConfigSchema;
}

/**
 * Validate a config for PERSISTENCE against `type`'s own schema (the legacy
 * shared schema when the type is unknown or absent).
 *
 * Returns only the keys the caller sent. The per-type schemas carry
 * `.default()`s for GENERATION; storing them would freeze today's defaults into
 * the row, so a later default change would never reach a report whose owner
 * never chose the value. This is what the deleted default-free `*ConfigFields`
 * twins used to guarantee. Values the caller DID send come back parsed (e.g.
 * a legacy numeric `schedule.date` coerced to a string). Every per-type schema
 * is loose, so no key the caller sent is dropped.
 *
 * Exported for `PUT /reports/:id`, whose body carries no `type` — the route
 * validates against the STORED row's type (#3198 W02, ruling P15).
 */
export function parseStoredReportConfig(
  type: string | undefined,
  config: Record<string, unknown>,
): ConfigParseResult {
  const parsed = configSchemaFor(type).safeParse(config);
  if (!parsed.success) return { success: false, error: parsed.error };
  // `type` is never a config field: the row's own `type` column is the only
  // type (#3198 W02 Task 13). A client-sent `config.type` is dropped rather
  // than persisted, so no stored config can later masquerade as a selector.
  const data = Object.fromEntries(
    Object.entries(parsed.data).filter(
      ([key]) => key !== 'type' && Object.prototype.hasOwnProperty.call(config, key),
    ),
  );
  return { success: true, data };
}

function forwardIssues(ctx: z.RefinementCtx, error: z.ZodError, prefix: PropertyKey[]): void {
  for (const issue of error.issues) {
    ctx.addIssue({ ...issue, path: [...prefix, ...issue.path] } as Parameters<z.RefinementCtx['addIssue']>[0]);
  }
}

/** The update body has no `type`, so the schema layer checks only the shared
 *  builder keys; the route re-parses against the stored row's type. */
const typeAgnosticStoredConfigSchema = z.looseObject({}).transform((value, ctx) => {
  const result = parseStoredReportConfig(undefined, value);
  if (!result.success) {
    forwardIssues(ctx, result.error, []);
    return z.NEVER;
  }
  return result.data;
});

export const listReportsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().guid().optional(),
  type: reportTypeSchema.optional(),
  schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).optional()
});

const createReportFields = {
  name: z.string().min(1).max(255),
  type: reportTypeSchema.refine(notInternalReportType, INTERNAL_REPORT_TYPE_MESSAGE),
  config: unparsedConfigSchema,
  schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).default('one_time'),
  format: z.enum(['csv', 'pdf', 'excel']).default('csv')
};

export const createReportSchema = z
  .preprocess(
    withDefaultOwnerScope,
    z.discriminatedUnion('ownerScope', [
      z.object({ ...organizationOwnerFields, ...createReportFields }),
      z.object({ ...partnerOwnerFields, ...createReportFields }),
    ]),
  )
  .transform((body, ctx) => {
    // Validated against the body's own `type` (#3198 W02, ruling P15) — never
    // copied INTO the config, so no `type` key is persisted.
    const result = parseStoredReportConfig(body.type, body.config);
    if (!result.success) {
      forwardIssues(ctx, result.error, ['config']);
      return z.NEVER;
    }
    return { ...body, config: result.data };
  });

/**
 * Not derived from `createReportSchema` (it never carried `type`), so the
 * create-only ownership fields are refused explicitly rather than stripped:
 *  - `ownerScope` is create-only — any value is a 400 (#3198 W01). Silently
 *    stripping it would answer 200 to a caller who believes they re-homed the
 *    report.
 *  - `orgId` has always been accepted and ignored (the web builder sends it on
 *    every save); it stays accepted for an org-owned row and the handler
 *    refuses it on a partner-owned one (`report_ownership_immutable`).
 */
export const updateReportSchema = z.object({
  ownerScope: z.never().optional(),
  orgId: z.unknown().optional(),
  name: z.string().min(1).max(255).optional(),
  // Shared builder keys only; `PUT /reports/:id` re-validates against the
  // stored row's type (#3198 W02, ruling P15).
  config: typeAgnosticStoredConfigSchema.optional(),
  schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).optional(),
  format: z.enum(['csv', 'pdf', 'excel']).optional()
});

const generateReportFields = {
  type: reportTypeSchema.refine(notInternalReportType, INTERNAL_REPORT_TYPE_MESSAGE),
  config: unparsedConfigSchema,
  format: z.enum(['csv', 'pdf', 'excel']).default('csv'),
};

/**
 * Ad-hoc generation. `config` is parsed with the TYPE's own schema, defaults
 * included (nothing is persisted here; the generator would apply them anyway).
 * The discriminator is unambiguous — `type` is required and already narrowed —
 * so there is no fallback branch. Loose like every per-type schema: the old
 * strict `z.object` here silently stripped every business option.
 */
export const generateReportSchema = z
  .preprocess(
    withDefaultOwnerScope,
    z.discriminatedUnion('ownerScope', [
      z.object({ ...organizationOwnerFields, ...generateReportFields }),
      z.object({ ...partnerOwnerFields, ...generateReportFields }),
    ]),
  )
  .transform((body, ctx) => {
    const parsed = reportTypeDef(body.type).configSchema.safeParse(body.config);
    if (!parsed.success) {
      forwardIssues(ctx, parsed.error, ['config']);
      return z.NEVER;
    }
    return { ...body, config: parsed.data };
  });

export const listRunsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  reportId: z.string().guid().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']).optional()
});

export const downloadQuerySchema = z.object({
  format: z.enum(['csv', 'pdf', 'excel', 'json']).optional()
});

export const dataQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  siteId: z.string().guid().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional()
});

export const reportRecipientParamSchema = z.object({
  id: z.string().guid(),
  contactId: z.string().guid().optional(),
});

export const addReportRecipientSchema = z.object({
  contactId: z.string().guid(),
});

export const convertReportRecipientSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().trim().min(1).max(255).optional(),
});
