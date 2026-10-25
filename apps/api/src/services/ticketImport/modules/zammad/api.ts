import { z } from 'zod';
import type { SourceHandle } from '../../moduleContract';
import { SourceAuthError, type SourceRequest } from '../../sourceFetch';
import {
  ZammadShapeError,
  zammadArticleSchema,
  zammadExpandedTicketSchema,
  zammadGroupSchema,
  zammadLinksSchema,
  zammadMeSchema,
  zammadObjectAttributeSchema,
  zammadOrganizationSchema,
  zammadPrioritySchema,
  zammadRoleSchema,
  zammadStateSchema,
  zammadTagsSchema,
  zammadTicketSchema,
  zammadUserSchema,
  zammadVersionSchema,
  type ZammadTicket,
} from './shapes';

/**
 * The Zammad 7.2.x REST calls of the module (shapes from 7.2.2; #8313 W5; spec 2026-10-19
 * §6.1, §6.2), over the framework's SSRF-safe client (sourceFetch.ts): every
 * request is the stored base URL plus `/api/v1/` and fixed segments or
 * numeric ids, never a URL from a response (§5.6). Auth is
 * `Authorization: Token token=<token>` (Z11). Retries, backoff and
 * `Retry-After` are the client's; every answer is checked against its 7.2.2
 * shape (shapes.ts).
 */

/** `GET /tickets` pages: capped at 100 server-side (Z2). A shorter page is the last. */
export const ZAMMAD_TICKET_PAGE_SIZE = 100;
/** `GET /users` and the generic indexes (orgs, groups, states, priorities, roles): max 1000 (Z15, Z18). */
export const ZAMMAD_INDEX_PAGE_SIZE = 1000;
/** A bound on any paged directory read: 1,000 pages of 1,000. */
const MAX_INDEX_PAGES = 1000;

/** The credential's single value: a Zammad access token (printable ASCII, no spaces). */
export function zammadAuthHeaders(src: SourceHandle<unknown>): Record<string, string> {
  const token = src.credentials.token;
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) throw new SourceAuthError(401);
  return { authorization: `Token token=${token}` };
}

type Query = SourceRequest['query'];

export async function zammadGet<S extends z.ZodType>(
  src: SourceHandle<unknown>,
  path: ReadonlyArray<string | number>,
  schema: S,
  query?: Query,
): Promise<{ body: z.infer<S>; headers: Headers }> {
  const res = await src.http.json({ path: ['api', 'v1', ...path], ...(query ? { query } : {}), headers: zammadAuthHeaders(src) });
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) throw new ZammadShapeError(`GET /api/v1/${String(path[0])}`);
  return { body: parsed.data, headers: res.headers };
}

/** A list answer: an array, or the page is unreadable as a whole. */
async function zammadArray(src: SourceHandle<unknown>, path: ReadonlyArray<string | number>, query?: Query): Promise<{ items: unknown[]; headers: Headers }> {
  const { body, headers } = await zammadGet(src, path, z.array(z.unknown()), query);
  return { items: body, headers };
}

/** Rows read one by one: a malformed row is skipped and counted, never the page. */
export type ZammadRows<T> = { rows: T[]; invalid: number };

function rowsOf<S extends z.ZodType>(items: readonly unknown[], schema: S): ZammadRows<z.infer<S>> {
  const rows: Array<z.infer<S>> = [];
  let invalid = 0;
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) rows.push(parsed.data);
    else invalid += 1;
  }
  return { rows, invalid };
}

function positiveId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Every row of a paged index, page by page until a short page (Z15, Z18), each row checked on its own. */
async function allPages<S extends z.ZodType>(
  src: SourceHandle<unknown>,
  path: ReadonlyArray<string | number>,
  row: S,
  query: Query = {},
): Promise<ZammadRows<z.infer<S>>> {
  const out: ZammadRows<z.infer<S>> = { rows: [], invalid: 0 };
  let previousFirst: unknown;
  for (let page = 1; page <= MAX_INDEX_PAGES; page += 1) {
    const { items } = await zammadArray(src, path, { ...query, page, per_page: ZAMMAD_INDEX_PAGE_SIZE });
    const first = (items[0] as { id?: unknown } | undefined)?.id;
    // A server that ignores `page` would answer the same page forever.
    if (page > 1 && first !== undefined && first === previousFirst) throw new ZammadShapeError(`GET /api/v1/${String(path[0])} (repeated page)`);
    previousFirst = first;
    const parsed = rowsOf(items, row);
    out.rows.push(...parsed.rows);
    out.invalid += parsed.invalid;
    if (items.length < ZAMMAD_INDEX_PAGE_SIZE) return out;
  }
  throw new ZammadShapeError(`GET /api/v1/${String(path[0])} (too many pages)`);
}

/** One ticket, to prove the token reads tickets at all (§6.1 preflight). */
export async function firstTicket(src: SourceHandle<unknown>): Promise<{ count: number; headers: Headers }> {
  const { items, headers } = await zammadArray(src, ['tickets'], { page: 1, per_page: 1 });
  return { count: items.length, headers };
}

/** A ticket list row the module can key (`id`) but not read: its ticket fails on its own. */
export type UnreadableTicketRow = { id: number; raw: Record<string, unknown> };

/**
 * One page of the ticket list, each row checked on its own. A row with an id
 * that is otherwise malformed is returned as unreadable (its ticket fails,
 * not the page); a row without an id cannot be keyed, so the page fails.
 */
export async function listTicketsPage(src: SourceHandle<unknown>, page: number): Promise<{
  size: number;
  tickets: ZammadTicket[];
  unreadable: UnreadableTicketRow[];
}> {
  const { items } = await zammadArray(src, ['tickets'], { page, per_page: ZAMMAD_TICKET_PAGE_SIZE });
  const tickets: ZammadTicket[] = [];
  const unreadable: UnreadableTicketRow[] = [];
  for (const item of items) {
    const parsed = zammadTicketSchema.safeParse(item);
    if (parsed.success) {
      tickets.push(parsed.data);
      continue;
    }
    const id = item && typeof item === 'object' ? positiveId((item as { id?: unknown }).id) : null;
    if (id === null) throw new ZammadShapeError('GET /api/v1/tickets (a row without an id)');
    unreadable.push({ id, raw: item as Record<string, unknown> });
  }
  return { size: items.length, tickets, unreadable };
}

export async function getTicket(src: SourceHandle<unknown>, ticketId: number) {
  return (await zammadGet(src, ['tickets', ticketId], zammadTicketSchema)).body;
}

/** The ticket with `article_ids`, for a ticket too large for `by_ticket` (§6.2, §11). */
export async function getTicketArticleIds(src: SourceHandle<unknown>, ticketId: number): Promise<number[]> {
  return (await zammadGet(src, ['tickets', ticketId], zammadExpandedTicketSchema, { expand: true })).body.article_ids;
}

/** Unpaginated, ordered `created_at, id`, internal and inline attachments included (Z5). */
export async function articlesByTicket(src: SourceHandle<unknown>, ticketId: number) {
  return (await zammadGet(src, ['ticket_articles', 'by_ticket', ticketId], z.array(zammadArticleSchema))).body;
}

export async function getArticle(src: SourceHandle<unknown>, articleId: number) {
  return (await zammadGet(src, ['ticket_articles', articleId], zammadArticleSchema)).body;
}

/** Tags are not in the ticket JSON (Z18). */
export async function ticketTags(src: SourceHandle<unknown>, ticketId: number): Promise<string[]> {
  const { body } = await zammadGet(src, ['tags'], zammadTagsSchema, { object: 'Ticket', o_id: ticketId });
  return body.tags ?? [];
}

export async function ticketLinks(src: SourceHandle<unknown>, ticketId: number) {
  return (await zammadGet(src, ['links'], zammadLinksSchema, { link_object: 'Ticket', link_object_value: ticketId })).body;
}

export function listUsers(src: SourceHandle<unknown>) {
  return allPages(src, ['users'], zammadUserSchema);
}

export async function getUser(src: SourceHandle<unknown>, userId: number) {
  return (await zammadGet(src, ['users', userId], zammadUserSchema)).body;
}

/** The token's user (`/users/me`; documented, unverified in the 7.2.2 source, §11). */
export function getMe(src: SourceHandle<unknown>) {
  return zammadGet(src, ['users', 'me'], zammadMeSchema, { expand: true });
}

/** The instance's version. Its policy is `default_permit!('admin')`: a `ticket.agent` token gets 403. */
export async function getVersion(src: SourceHandle<unknown>): Promise<string> {
  return (await zammadGet(src, ['version'], zammadVersionSchema)).body.version;
}

export function listRoles(src: SourceHandle<unknown>) {
  return allPages(src, ['roles'], zammadRoleSchema, { expand: true });
}

export function listOrganizations(src: SourceHandle<unknown>) {
  return allPages(src, ['organizations'], zammadOrganizationSchema);
}

/** Inactive groups included (Z18). */
export function listGroups(src: SourceHandle<unknown>) {
  return allPages(src, ['groups'], zammadGroupSchema);
}

export function listStates(src: SourceHandle<unknown>) {
  return allPages(src, ['ticket_states'], zammadStateSchema, { expand: true });
}

export function listPriorities(src: SourceHandle<unknown>) {
  return allPages(src, ['ticket_priorities'], zammadPrioritySchema);
}

/** Needs admin.object (Z17); the caller treats a 403 as "not available". */
export async function listObjectAttributes(src: SourceHandle<unknown>) {
  return rowsOf((await zammadArray(src, ['object_manager_attributes'])).items, zammadObjectAttributeSchema);
}

/** One file's original bytes: no `view` (Z6), at most `maxBytes`. */
export function downloadAttachment(
  src: SourceHandle<unknown>,
  location: { ticketId: number; articleId: number; storeId: number },
  maxBytes: number,
): Promise<Uint8Array> {
  return src.http.bytes({
    path: ['api', 'v1', 'ticket_attachment', location.ticketId, location.articleId, location.storeId],
    headers: { ...zammadAuthHeaders(src), accept: '*/*' },
    maxBytes,
  });
}
