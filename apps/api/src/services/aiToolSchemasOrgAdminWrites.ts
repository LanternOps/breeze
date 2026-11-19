/**
 * Input schemas for the W18 PR B org-admin writers (full-control W18, #6789):
 * `manage_org_portal_settings` and `manage_report_recipients`. Each is one flat
 * `.strict()` object; the handler re-validates the action's own fields. The
 * portal schema is derived from the REST validator (`.extend().omit()`), so it
 * cannot disagree with the route; the recipient fields are copied (see below)
 * and pinned to the REST validators by a parity test. No `z.undefined()`
 * anywhere: it empties the model's tool list.
 */
import { z } from 'zod';
import { PORTAL_CHROME_ACCENT_KEYS, updatePortalSettingsSchema } from '@breeze/shared';
import { PORTAL_TOOL_SENSITIVE_KEYS, PORTAL_SENSITIVE_PARENTS } from './portal/portalSensitiveParents';

const uuid = z.string().guid();

export const ORG_PORTAL_SETTINGS_ACTIONS = ['get', 'update', 'set_sensitive_access'] as const;
export const REPORT_RECIPIENT_ACTIONS = ['list', 'add', 'remove', 'convert'] as const;

/**
 * The PATCH schema (`patchPortalSettingsSchema`: the shared validator plus
 * chromeAccent) minus what the supervised `update` may never write: customCss
 * (served verbatim to customer browsers, Decision 3) and every sensitive and
 * permission flag (the four-eyes `set_sensitive_access`). The two parents stay:
 * `update` refuses them only when they would activate a dormant child. The mask
 * is spelled out so zod can type it; aiToolsOrgPortalSettings.test.ts checks it
 * against PORTAL_SENSITIVE_FLAG_KEYS / PORTAL_PERMISSION_FLAG_KEYS, so a flag
 * added to either list fails that test until it is excluded here (`satisfies`
 * only checks the keys named are valid, not that none is missing).
 */
const UPDATE_EXCLUDED = {
  customCss: true,
  enableNetworkAlerts: true,
  enableHourBlock: true,
  enablePatchDetail: true,
  enableVulnerabilityDetail: true,
  enablePhysicalPlacement: true,
  enableTrustPageEditing: true,
} as const satisfies Partial<Record<Exclude<(typeof PORTAL_TOOL_SENSITIVE_KEYS)[number], keyof typeof PORTAL_SENSITIVE_PARENTS> | 'customCss', true>>;

export const portalSettingsToolUpdateSchema = updatePortalSettingsSchema
  .extend({ chromeAccent: z.enum(PORTAL_CHROME_ACCENT_KEYS).nullable().optional() })
  .omit(UPDATE_EXCLUDED)
  .strict();

/** `set_sensitive_access` flags: the sensitive, permission and parent keys only, each a boolean. */
export const portalSensitiveFlagsSchema = z.object(
  Object.fromEntries(PORTAL_TOOL_SENSITIVE_KEYS.map((key) => [key, z.boolean().optional()])) as Record<
    (typeof PORTAL_TOOL_SENSITIVE_KEYS)[number],
    z.ZodOptional<z.ZodBoolean>
  >,
).strict();

export const orgAdminWriteToolSchemas = {
  manage_org_portal_settings: z.object({
    action: z.enum(ORG_PORTAL_SETTINGS_ACTIONS),
    orgId: uuid.describe('Organization UUID'),
    settings: portalSettingsToolUpdateSchema.optional()
      .describe('update: the portal toggles, support contact, welcome and footer text, logo and colours to change'),
    flags: portalSensitiveFlagsSchema.optional()
      .describe('set_sensitive_access: sensitive portal flags to turn on (true) or off (false)'),
  }).strict(),
  manage_report_recipients: z.object({
    action: z.enum(REPORT_RECIPIENT_ACTIONS),
    reportId: uuid.describe('Report definition UUID'),
    // Field shapes = routes/reports/schemas.ts addReportRecipientSchema / convertReportRecipientSchema (copied, not
    // imported, to keep the report registry out of this module's graph; parity pinned in aiToolsReportRecipients.test.ts).
    contactId: uuid.optional().describe('add, remove: the organization contact UUID (list_org_contacts)'),
    mode: z.enum(['add', 'remove']).optional()
      .describe("add on a series report: 'remove' excludes a contact the series rule would include"),
    email: z.string().email().max(320).optional()
      .describe("convert: an address already in the report's email recipients"),
    name: z.string().trim().min(1).max(255).optional().describe('convert: contact name when a new contact is created'),
  }).strict(),
} as const;
