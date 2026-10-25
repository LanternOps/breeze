import { z } from 'zod';
import { SourceShapeError } from '../../sourceFetch';

/**
 * The Zammad 7.2.x JSON the module reads: shapes from the 7.2.2 source,
 * validated later against a live 7.2.0 (#8313 W5; spec 2026-10-19 §3, the
 * research notes' §3–§8). Every schema is loose: it names the fields the
 * module uses and keeps the rest (custom Object Manager attributes are extra
 * top-level ticket keys, Z17; newer article keys such as `ai_stored_results`
 * are ignored). Ids are numbers; times are ISO 8601 UTC strings with
 * milliseconds.
 */

const id = z.number().int().positive();
const text = z.string().nullable().optional();
const time = z.string().min(1);
const optionalTime = time.nullable().optional();
const prefs = z.record(z.string(), z.unknown()).nullable().optional();

/** A ticket row: the plain column attributes of `GET /tickets` and `GET /tickets/:id` (Z2). */
export const zammadTicketSchema = z.looseObject({
  id,
  number: z.union([z.string().min(1), z.number()]),
  title: text,
  group_id: id,
  priority_id: id,
  state_id: id,
  organization_id: id.nullable().optional(),
  // NOT NULL in 7.2.2; 1 is the unassigned system user (Z15).
  owner_id: id.nullable().optional(),
  customer_id: id,
  created_at: time,
  updated_at: time,
  close_at: optionalTime,
  last_close_at: optionalTime,
  pending_time: optionalTime,
  create_article_type_id: id.nullable().optional(),
  article_count: z.number().int().nullable().optional(),
  type: text,
  // decimal(6,2) serialized as a string ("15.0"); a number is accepted too.
  time_unit: z.union([z.string(), z.number()]).nullable().optional(),
});
export type ZammadTicket = z.infer<typeof zammadTicketSchema>;

/** `GET /tickets/:id?expand=true`: adds the article ids (the >500-article fallback, §11). */
export const zammadExpandedTicketSchema = zammadTicketSchema.extend({ article_ids: z.array(id) });

/** An attachment as `by_ticket` lists it (`attributes_for_display`): `size` is a string (Z8). */
export const zammadAttachmentSchema = z.looseObject({
  id,
  filename: text,
  size: z.union([z.string(), z.number()]).nullable().optional(),
  preferences: prefs,
});
export type ZammadAttachment = z.infer<typeof zammadAttachmentSchema>;

/** An article in the `attributes_with_association_names` form of `by_ticket` and `show` (Z5). */
export const zammadArticleSchema = z.looseObject({
  id,
  ticket_id: id,
  type_id: id.nullable().optional(),
  sender_id: id.nullable().optional(),
  type: text,
  sender: text,
  from: text,
  to: text,
  cc: text,
  content_type: text,
  body: text,
  internal: z.boolean().nullable().optional(),
  preferences: prefs,
  created_by_id: id.nullable().optional(),
  origin_by_id: id.nullable().optional(),
  created_at: time,
  attachments: z.array(zammadAttachmentSchema).nullable().optional(),
  // A later release moves inline images here (Z6); 7.2.2 never sends it.
  inline_attachments: z.array(z.unknown()).nullable().optional(),
  body_rendering_error: z.boolean().nullable().optional(),
});
export type ZammadArticle = z.infer<typeof zammadArticleSchema>;

/** A user of `GET /users` (Z15): email is not unique and may be empty; inactive users included. */
export const zammadUserSchema = z.looseObject({
  id,
  login: text,
  firstname: text,
  lastname: text,
  email: text,
  active: z.boolean().nullable().optional(),
  role_ids: z.array(id).nullable().optional(),
  // { "<group id>": ["read" | "full" | ...] }
  group_ids: z.record(z.string(), z.array(z.string())).nullable().optional(),
});
export type ZammadUser = z.infer<typeof zammadUserSchema>;

export const zammadMeSchema = zammadUserSchema.extend({ roles: z.array(z.string()).nullable().optional() });

export const zammadOrganizationSchema = z.looseObject({ id, name: z.string(), active: z.boolean().nullable().optional() });
export const zammadGroupSchema = z.looseObject({ id, name: z.string(), active: z.boolean().nullable().optional() });
export const zammadPrioritySchema = z.looseObject({ id, name: z.string(), active: z.boolean().nullable().optional() });

/**
 * `GET /ticket_states?expand=true`: `state_type` is the type's name (there is
 * no state type route; a live 7.2.0 answers none for `ticket_state_types`).
 * `next_state_id` is where a `pending action` state goes when its time comes:
 * the seeded `pending close` goes to `closed`; a custom one may go nowhere.
 */
export const zammadStateSchema = z.looseObject({
  id,
  name: z.string(),
  state_type_id: id,
  state_type: text,
  next_state_id: id.nullable().optional(),
  active: z.boolean().nullable().optional(),
});

/** `GET /version` (`{ version: "7.2.0" }`); its policy needs the exact `admin` permission. */
export const zammadVersionSchema = z.looseObject({ version: z.string().min(1).max(100) });

/** `GET /roles?expand=true`: permission names per role, and the role's group access. */
export const zammadRoleSchema = z.looseObject({
  id,
  name: z.string(),
  active: z.boolean().nullable().optional(),
  permissions: z.array(z.string()).nullable().optional(),
  group_ids: z.record(z.string(), z.array(z.string())).nullable().optional(),
});

export const zammadTagsSchema = z.looseObject({ tags: z.array(z.string()).nullable().optional() });

/** `GET /links?link_object=Ticket&link_object_value=:id` (Z9). */
export const zammadLinksSchema = z.looseObject({
  links: z.array(z.looseObject({
    link_type: z.string(),
    link_object: z.string(),
    link_object_value: z.union([z.number(), z.string()]),
  })),
  assets: z.looseObject({
    Ticket: z.record(z.string(), z.looseObject({ number: z.union([z.string(), z.number()]).nullable().optional(), created_at: optionalTime })).optional(),
  }).nullable().optional(),
});

/** `GET /object_manager_attributes` (needs admin.object): the ticket attribute definitions (Z17). */
export const zammadObjectAttributeSchema = z.looseObject({
  name: z.string(),
  display: text,
  object: text,
  active: z.boolean().nullable().optional(),
  editable: z.boolean().nullable().optional(),
});

/** The seeded state types (Z12), by `state_type_id`, when `state_type` is not named. */
export const ZAMMAD_STATE_TYPE_BY_ID: Readonly<Record<number, string>> = {
  1: 'new', 2: 'open', 3: 'pending reminder', 4: 'pending action', 5: 'closed', 6: 'merged', 7: 'removed',
};

/** The seeded article types and senders (Z14), for an article that does not name them. */
export const ZAMMAD_ARTICLE_TYPE_BY_ID: Readonly<Record<number, string>> = {
  1: 'email', 2: 'sms', 3: 'chat', 4: 'fax', 5: 'phone', 6: 'twitter status', 7: 'twitter direct-message',
  8: 'facebook feed post', 9: 'facebook feed comment', 10: 'note', 11: 'web', 12: 'telegram personal-message',
  13: 'facebook direct-message', 14: 'whatsapp message',
};
export const ZAMMAD_SENDER_BY_ID: Readonly<Record<number, string>> = { 1: 'Agent', 2: 'Customer', 3: 'System' };

/**
 * A state with its type, as the conversion maps it (§6.3), and the type of
 * its next state (null when it has none).
 */
export type ZammadStateInfo = { id: number; name: string; type: string; nextStateType?: string | null };

/** A user reduced to what a conversion names: never the rest of the profile. */
export type ZammadPerson = {
  id: number;
  login: string | null;
  firstname: string | null;
  lastname: string | null;
  email: string | null;
  active: boolean;
};

export function personOf(user: ZammadUser): ZammadPerson {
  return {
    id: user.id,
    login: user.login ?? null,
    firstname: user.firstname ?? null,
    lastname: user.lastname ?? null,
    email: user.email ?? null,
    active: user.active !== false,
  };
}

/**
 * Everything the pure conversion of one ticket reads (`LoadedTicket.data`).
 * No file bytes: attachments are listed, never downloaded, at load.
 */
export type ZammadLoadedData = {
  /** The source's base URL: the ticket's `sourceUrl`, and absolute inline-image URLs. */
  baseUrl: string;
  /** The header, from the list row (or the probe): plain attributes only. */
  ticket: ZammadTicket;
  /** In `by_ticket` order (`created_at, id`), internal and System ones included. */
  articles: ZammadArticle[];
  tags: string[];
  state: ZammadStateInfo;
  priorityName: string | null;
  /** Merged tickets only: the final survivor (Z9); null ids when the source shows none. */
  merge: { survivorId: number | null; survivorNumber: string | null; survivorCreatedAt: string | null } | null;
  /** The people the ticket names (owner, customer, authors) by id; null for one the source no longer has. */
  people: Record<string, ZammadPerson | null>;
  /** Directory rows skipped as unreadable since the last load reported them, by list (counted once). */
  invalidRows?: Record<string, number>;
};

/**
 * A Zammad answer that is not the 7.x shape: a malformed record, or a release
 * the module does not know. Not an outage (a SourceShapeError): confined to
 * one ticket it fails that ticket permanently (`source_shape_invalid`); on a
 * list page that cannot be split per row it stops the run.
 */
export class ZammadShapeError extends SourceShapeError {
  constructor(what: string) {
    super(`Zammad answered ${what} with an unexpected shape`);
    this.name = 'ZammadShapeError';
  }
}
