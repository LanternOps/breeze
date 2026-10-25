import type { LoadedTicket, SourceHandle, SourceRow } from '../../moduleContract';
import { SourceAuthError, SourceHttpError, SourceResponseTooLargeError } from '../../sourceFetch';
import {
  articlesByTicket,
  getArticle,
  getTicket,
  getTicketArticleIds,
  listTicketsPage,
  ticketLinks,
  ticketTags,
  ZAMMAD_TICKET_PAGE_SIZE,
} from './api';
import { zammadPeople, zammadPriorityName, zammadState } from './directory';
import { usableEmail } from './mapping';
import {
  ZammadShapeError,
  zammadTicketSchema,
  type ZammadArticle,
  type ZammadLoadedData,
  type ZammadTicket,
} from './shapes';

/**
 * Reading a Zammad 7.2.x source (#8313 W5; spec 2026-10-19 §6.2).
 *
 * - **scan** pages `GET /tickets?page=N&per_page=100`, ordered `id ASC`, with
 *   no state filter (Z2). The cursor is the page number and the last id seen:
 *   offset paging shifts when a ticket on an earlier page disappears (one row
 *   is then skipped this pass, and the deletions probe finds it `present`) or
 *   reappears (a row is listed twice, and the id filter drops the repeat). A
 *   page shorter than 100 is the last. The header comes from the list row, so
 *   an unchanged ticket costs no other request.
 * - **load** reads the articles with `by_ticket` (unpaginated; inline
 *   attachments included, Z5), never `GET /tickets/:id?all=true`, which omits
 *   them and runs Core Workflow. A ticket whose `article_count` passes 500,
 *   or whose `by_ticket` answer passes the JSON cap, is read article by article
 *   from its `article_ids` (§11). Then its tags (Z18), the final survivor of a
 *   merged ticket from its `parent` link (Z9), and the people it names.
 */

export const ZAMMAD_BIG_TICKET_ARTICLES = 500;
/** Full pages that bring no new id before the scan treats the list as ended (a server ignoring `page`). */
const STALE_PAGE_LIMIT = 3;

export type ZammadCursor = { page: number; lastId: number; stale?: number };

function cursorOf(raw: unknown): ZammadCursor {
  const c = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const int = (v: unknown, min: number) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= min ? v : min);
  return { page: int(c.page, 1), lastId: int(c.lastId, 0), stale: int(c.stale, 0) };
}

/** The ledger row of one ticket: key = id, version = updated_at (compared for equality only, §5.2). */
export function zammadRow(ticket: ZammadTicket): SourceRow {
  return {
    key: String(ticket.id),
    version: ticket.updated_at,
    orgKey: ticket.organization_id == null ? null : String(ticket.organization_id),
    number: String(ticket.number),
    summary: ticket,
  };
}

export async function scanZammad(
  src: SourceHandle<unknown>,
  rawCursor: ZammadCursor | null,
): Promise<{ rows: SourceRow[]; next: ZammadCursor | null }> {
  const cursor = cursorOf(rawCursor);
  const { body } = await listTicketsPage(src, cursor.page);
  const fresh = body.filter((t) => t.id > cursor.lastId).sort((a, b) => a.id - b.id);
  const lastId = fresh.reduce((max, t) => Math.max(max, t.id), cursor.lastId);
  const rows = fresh.map(zammadRow);
  if (body.length < ZAMMAD_TICKET_PAGE_SIZE) return { rows, next: null };
  const stale = fresh.length === 0 ? (cursor.stale ?? 0) + 1 : 0;
  if (stale >= STALE_PAGE_LIMIT) return { rows, next: null };
  return { rows, next: { page: cursor.page + 1, lastId, ...(stale > 0 ? { stale } : {}) } };
}

// ------------------------------------------------------------ attachments

/**
 * Where each file of a loaded ticket lives: the article's **current** ticket
 * and the article (§6.2 files), which the attachment route needs and an
 * attachment source id (`attachment:<store id>`) does not carry. Kept per
 * source handle (one slice), for the last few tickets loaded with it: a file
 * is fetched right after its ticket's load, by the same handle.
 */
type FileLocation = { ticketId: number; articleId: number };
const LOCATIONS = new WeakMap<object, Map<string, Map<number, FileLocation>>>();
const TICKETS_REMEMBERED = 8;

export function rememberFileLocations(src: SourceHandle<unknown>, ticketKey: string, articles: readonly ZammadArticle[]): void {
  let byTicket = LOCATIONS.get(src);
  if (!byTicket) {
    byTicket = new Map();
    LOCATIONS.set(src, byTicket);
  }
  const files = new Map<number, FileLocation>();
  for (const article of articles) {
    for (const file of article.attachments ?? []) files.set(file.id, { ticketId: article.ticket_id, articleId: article.id });
  }
  byTicket.delete(ticketKey);
  byTicket.set(ticketKey, files);
  while (byTicket.size > TICKETS_REMEMBERED) byTicket.delete(byTicket.keys().next().value!);
}

export function rememberedFileLocation(src: SourceHandle<unknown>, ticketKey: string, storeId: number): FileLocation | null {
  return LOCATIONS.get(src)?.get(ticketKey)?.get(storeId) ?? null;
}

// ------------------------------------------------------------------- load

/** By the article ids of `GET /tickets/:id?expand=true`, in `by_ticket` order. */
async function articlesOneByOne(src: SourceHandle<unknown>, ticketId: number): Promise<ZammadArticle[]> {
  const ids = await getTicketArticleIds(src, ticketId);
  const articles = await Promise.all(ids.map((id) => getArticle(src, id)));
  return articles.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
}

export async function zammadArticles(src: SourceHandle<unknown>, ticket: ZammadTicket): Promise<ZammadArticle[]> {
  if ((ticket.article_count ?? 0) > ZAMMAD_BIG_TICKET_ARTICLES) return articlesOneByOne(src, ticket.id);
  try {
    return await articlesByTicket(src, ticket.id);
  } catch (error) {
    if (error instanceof SourceResponseTooLargeError) return articlesOneByOne(src, ticket.id);
    throw error;
  }
}

/** The final survivor of a merged ticket: its `parent` link, re-pointed along a chain (Z9). */
async function survivorOf(src: SourceHandle<unknown>, ticketId: number): Promise<ZammadLoadedData['merge']> {
  const links = await ticketLinks(src, ticketId);
  const parent = links.links.find((l) => l.link_type === 'parent' && l.link_object === 'Ticket');
  const survivorId = parent ? Number(parent.link_object_value) : NaN;
  if (!Number.isSafeInteger(survivorId) || survivorId <= 0) return { survivorId: null, survivorNumber: null, survivorCreatedAt: null };
  const asset = links.assets?.Ticket?.[String(survivorId)];
  if (asset?.number != null) {
    return { survivorId, survivorNumber: String(asset.number), survivorCreatedAt: asset.created_at ?? null };
  }
  // The assets did not carry it: the survivor itself, unless the token cannot see it.
  try {
    const survivor = await getTicket(src, survivorId);
    return { survivorId, survivorNumber: String(survivor.number), survivorCreatedAt: survivor.created_at };
  } catch (error) {
    if (error instanceof SourceHttpError && !(error instanceof SourceAuthError) && [403, 404].includes(error.status)) {
      return { survivorId, survivorNumber: null, survivorCreatedAt: null };
    }
    throw error;
  }
}

export async function loadZammad(src: SourceHandle<unknown>, row: SourceRow): Promise<LoadedTicket> {
  const parsed = zammadTicketSchema.safeParse(row.summary);
  if (!parsed.success || String(parsed.data.id) !== row.key) throw new ZammadShapeError('the ticket list row');
  const ticket = parsed.data;
  const state = await zammadState(src, ticket.state_id);
  const [articles, tags] = await Promise.all([zammadArticles(src, ticket), ticketTags(src, ticket.id)]);
  const merge = state?.type === 'merged' ? await survivorOf(src, ticket.id) : null;
  const priorityName = await zammadPriorityName(src, ticket.priority_id);

  const ownerId = ticket.owner_id ?? 1;
  const ids = new Set<number>([ownerId, ticket.customer_id]);
  for (const a of articles) {
    if (a.origin_by_id) ids.add(a.origin_by_id);
    if (a.created_by_id) ids.add(a.created_by_id);
  }
  const people = await zammadPeople(src, ids);
  rememberFileLocations(src, row.key, articles);

  const data: ZammadLoadedData = {
    baseUrl: src.baseUrl,
    ticket,
    articles,
    tags,
    // A state the source no longer lists: the conversion skips the ticket as unsupported.
    state: state ?? { id: ticket.state_id, name: '', type: 'unknown' },
    priorityName,
    merge,
    people: Object.fromEntries([...people].map(([id, person]) => [String(id), person])),
  };
  const ownerEmail = ownerId === 1 ? null : usableEmail(people.get(ownerId)?.email);
  const customerEmail = usableEmail(people.get(ticket.customer_id)?.email);
  return {
    row,
    data,
    needs: {
      userEmails: ownerEmail ? [ownerEmail] : [],
      contactEmails: customerEmail ? [customerEmail] : [],
    },
  };
}
