/**
 * Wisp W08 (feature #9906; w00 A35) — request bodies for entity links and the
 * partner enable switch. Types live in `types/wisp.ts`.
 *
 * Ids are `z.guid()` (any 8-4-4-4-12 hex): entity ids come from eleven tables,
 * some seeded with non-RFC-variant uuids, and the DB is the authority on
 * existence. `orgId` is a lookup hint only — the API reads the org from the
 * entity and a mismatch is `not_found`.
 */
import { z } from 'zod';
import { WISP_ENTITY_KINDS, WISP_LINK_LABEL_MAX } from '../types/wisp';
import { WISP_TIMELINE_DEFAULT_LIMIT, WISP_TIMELINE_MAX_LIMIT } from '../types/wispTimeline';

export const wispEntityKindSchema = z.enum(WISP_ENTITY_KINDS);

/** `POST /wisp/thread/:id/links` body and the `link_entity` chat tool input. */
export const linkEntitySchema = z
  .object({
    kind: wispEntityKindSchema,
    id: z.guid(),
    orgId: z.guid().nullable().optional(),
    label: z.string().max(WISP_LINK_LABEL_MAX).optional(),
  })
  .strict();
export type LinkEntityInput = z.infer<typeof linkEntitySchema>;

/** `list_links` chat tool input (no members). */
export const listLinksToolSchema = z.object({}).strict();
export type ListLinksToolInput = z.infer<typeof listLinksToolSchema>;

export const threadLinkParamsSchema = z.object({ id: z.guid(), linkId: z.guid() });

/** `PUT /wisp/partner-settings` body. Not `partnerSettingsSchema`: that name is the `partners.settings` jsonb contract in apps/api/src/routes/orgs.ts. */
export const wispPartnerSettingsSchema = z.object({ enabled: z.boolean() }).strict();
export type WispPartnerSettingsInput = z.infer<typeof wispPartnerSettingsSchema>;

/** `GET /wisp/home?grantId=` (omitted = the caller's single active grant). */
export const wispHomeQuerySchema = z.object({ grantId: z.guid().optional() });

/** `GET /wisp/thread/:id/timeline` query: keyset cursor, page size, optional session to leave out. */
export const wispTimelineQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(WISP_TIMELINE_MAX_LIMIT).default(WISP_TIMELINE_DEFAULT_LIMIT),
  excludeSessionId: z.guid().optional(),
});
export type WispTimelineQuery = z.infer<typeof wispTimelineQuerySchema>;
