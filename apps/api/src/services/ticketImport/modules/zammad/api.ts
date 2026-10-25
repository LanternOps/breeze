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
} from './shapes';

/**
 * The Zammad 7.2.2 REST calls of the module (#8313 W5; spec 2026-10-19
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

/** Every row of a paged index, page by page until a short page (Z15, Z18). */
async function allPages<S extends z.ZodType>(
  src: SourceHandle<unknown>,
  path: ReadonlyArray<string | number>,
  row: S,
  query: Query = {},
): Promise<Array<z.infer<S>>> {
  const out: Array<z.infer<S>> = [];
  let previousFirst: unknown;
  for (let page = 1; page <= MAX_INDEX_PAGES; page += 1) {
    const { body } = await zammadGet(src, path, z.array(row), { ...query, page, per_page: ZAMMAD_INDEX_PAGE_SIZE });
    const first = (body[0] as { id?: unknown } | undefined)?.id;
    // A server that ignores `page` would answer the same page forever.
    if (page > 1 && first !== undefined && first === previousFirst) throw new ZammadShapeError(`GET /api/v1/${String(path[0])} (repeated page)`);
    previousFirst = first;
    out.push(...body);
    if (body.length < ZAMMAD_INDEX_PAGE_SIZE) return out;
  }
  throw new ZammadShapeError(`GET /api/v1/${String(path[0])} (too many pages)`);
}

/** One ticket, to prove the token reads tickets at all (§6.1 preflight). */
export function firstTicket(src: SourceHandle<unknown>) {
  return zammadGet(src, ['tickets'], z.array(zammadTicketSchema), { page: 1, per_page: 1 });
}

export function listTicketsPage(src: SourceHandle<unknown>, page: number) {
  return zammadGet(src, ['tickets'], z.array(zammadTicketSchema), { page, per_page: ZAMMAD_TICKET_PAGE_SIZE });
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
  return (await zammadGet(src, ['object_manager_attributes'], z.array(zammadObjectAttributeSchema))).body;
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
