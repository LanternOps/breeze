/**
 * Save-time refusal of reserved brand names (#10325).
 *
 * The partner name heads every on-device prompt (consent, elevation, restart),
 * and the org name appears on remote prompts. A name that is only a reserved
 * brand ("Microsoft", "Windows Security", "Apple Help Desk") would make those
 * prompts look like they come from the OS vendor. Devices already show the
 * generic "Your IT support team" for such a name (sanitizePromptPartnerName /
 * promptcatalog.SanitizeIdentityName); this refuses it where it is saved, so
 * the partner learns why instead of seeing the generic name.
 */
import { z } from 'zod';
import { isReservedPromptBrandName } from '@breeze/shared/promptCatalog';

export const RESERVED_BRAND_NAME_MESSAGE =
  'This name is reserved: device prompts show it to end users, so it cannot be only a Microsoft, Windows, Apple or Google name such as "Microsoft Support". Include your own company name.';

/** `schema` plus a refusal of reserved brand names, reported on the field. */
export function refuseReservedBrandName<T extends z.ZodType<string>>(schema: T) {
  return schema.refine((name) => !isReservedPromptBrandName(name), { message: RESERVED_BRAND_NAME_MESSAGE });
}
