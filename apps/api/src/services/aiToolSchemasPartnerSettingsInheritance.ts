import { z } from 'zod';
import { CATALOG_BY_ID, CATALOG_TAB_KEYS } from '@breeze/shared';

/**
 * `get_partner_settings_inheritance` (#9763): the query schemas of
 * GET /orgs/partners/me/settings-inheritance (`tab`) and its `/orgs`
 * drill-down (`field`, `bucket`, `cursor`, `limit`), flattened into one input.
 * Exactly one of `tab` / `field`; the drill-down arguments only with `field`.
 * The bucket list and page cap mirror `partnerSettingsInheritance/bindings`
 * BUCKETS and `drilldown` DRILLDOWN_MAX_LIMIT (pinned equal by the tool's test).
 */
export const PARTNER_SETTINGS_INHERITANCE_BUCKETS = ['ownValue', 'overrides', 'shadowed', 'clamped'] as const;
export const PARTNER_SETTINGS_INHERITANCE_MAX_LIMIT = 50;
export const partnerSettingsInheritanceInputSchema = z
  .object({
    tab: z.enum(CATALOG_TAB_KEYS).optional(),
    field: z
      .string()
      .max(128)
      .refine((value) => Object.hasOwn(CATALOG_BY_ID, value), { message: 'Unknown setting' })
      .optional(),
    bucket: z.enum(PARTNER_SETTINGS_INHERITANCE_BUCKETS).optional(),
    cursor: z.string().max(2048).regex(/^[A-Za-z0-9_-]+$/, 'Invalid cursor').optional(),
    limit: z.number().int().min(1).max(PARTNER_SETTINGS_INHERITANCE_MAX_LIMIT).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if ((input.tab === undefined) === (input.field === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Pass exactly one of tab (per-setting counts) or field (the organizations behind one count)' });
      return;
    }
    if (input.tab !== undefined && (input.bucket !== undefined || input.cursor !== undefined || input.limit !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'bucket, cursor and limit apply only with field' });
    }
  });

