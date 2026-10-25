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
  type UnreadableTicketRow,
} from './api';
import { takeZammadInvalidRows, zammadPeople, zammadPriorityName, zammadState } from './directory';
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
 * - **load** reads the article ids (`?expand=true`, System articles
 *   included), then the articles with `by_ticket` (unpaginated; inline
 *   attachments included, Z5), never `GET /tickets/:id?all=true`, which omits
 *   them, carries every article as an asset and runs Core Workflow. A ticket
 *   over 500 articles in all, or whose `by_ticket` answer passes the JSON
 *   cap, is read article by article (§11), a few at a time, stopping at the
 *   first failure. Then its tags (Z18), the final survivor of a merged ticket
 *   from its `parent` link (Z9), and the people it names.
 */

export const ZAMMAD_BIG_TICKET_ARTICLES = 500;
/** The failure code of a ticket whose row or answer the module cannot read (runOutcomes' SOURCE_SHAPE_INVALID). */
export const ZAMMAD_SHAPE_FAILURE = 'source_shape_invalid';
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

/**
 * A list row the module can key but not read: its ticket fails on its own
 * (`source_shape_invalid`), never the page, and the next run retries it.
 */
export function unreadableZammadRow(row: UnreadableTicketRow): SourceRow {
  const { raw } = row;
  const org = raw.organization_id;
  const number = raw.number;
  return {
    key: String(row.id),
    version: typeof raw.updated_at === 'string' && raw.updated_at ? raw.updated_at : 'unreadable',
    orgKey: typeof org === 'number' && Number.isSafeInteger(org) && org > 0 ? String(org) : null,
    number: typeof number === 'string' || typeof number === 'number' ? String(number) : null,
    summary: null,
    failure: { code: ZAMMAD_SHAPE_FAILURE },
  };
}

export async function scanZammad(
  src: SourceHandle<unknown>,
  rawCursor: ZammadCursor | null,
): Promise<{ rows: SourceRow[]; next: ZammadCursor | null }> {
  const cursor = cursorOf(rawCursor);
  const page = await listTicketsPage(src, cursor.page);
  const listed = [
    ...page.tickets.map((t) => ({ id: t.id, row: zammadRow(t) })),
    ...page.unreadable.map((u) => ({ id: u.id, row: unreadableZammadRow(u) })),
  ];
  const fresh = listed.filter((t) => t.id > cursor.lastId).sort((a, b) => a.id - b.id);
  const lastId = fresh.reduce((max, t) => Math.max(max, t.id), cursor.lastId);
  const rows = fresh.map((t) => t.row);
  if (page.size < ZAMMAD_TICKET_PAGE_SIZE) return { rows, next: null };
  const stale = fresh.length === 0 ? (cursor.stale ?? 0) + 1 : 0;
  if (stale >= STALE_PAGE_LIMIT) return { rows, next: null };
  return { rows, next: { page: cursor.page + 1, lastId, ...(stale > 0 ? { stale } : {}) } };
}

// ------------------------------------------------------------ attachments

/**
 * Where each file of a loaded ticket lives: the article's **current** ticket
 * and the article (§6.2 files), which the attachment route needs and an
 * attachment source id (`attachment:<id>`) does not carry. The id is the
 * attachment's own (`stores.id`), never `store_file_id`, which Zammad shares
 * between attachments of equal content (Z8).
 *
 * A bounded LRU keyed by source and ticket, so a file is found whichever
 * handle of the source asks (a file is normally fetched right after its
 * ticket's load) and two sources never share an entry. Nothing personal: ids
 * only. A miss re-reads the ticket's articles (`fetchZammadAttachment`).
 */
export type FileLocation = { ticketId: number; articleId: number };
const LOCATIONS = new Map<string, Map<number, FileLocation>>();
export const ZAMMAD_FILE_LOCATION_TICKETS = 64;

function locationKey(src: SourceHandle<unknown>, ticketKey: string): string {
  return `${src.sourceId}\n${src.baseUrl}\n${ticketKey}`;
}

export function rememberFileLocations(src: SourceHandle<unknown>, ticketKey: string, articles: readonly ZammadArticle[]): void {
  const files = new Map<number, FileLocation>();
  for (const article of articles) {
    for (const file of article.attachments ?? []) files.set(file.id, { ticketId: article.ticket_id, articleId: article.id });
  }
  const key = locationKey(src, ticketKey);
  LOCATIONS.delete(key);
  LOCATIONS.set(key, files);
  while (LOCATIONS.size > ZAMMAD_FILE_LOCATION_TICKETS) LOCATIONS.delete(LOCATIONS.keys().next().value!);
}

export function rememberedFileLocation(src: SourceHandle<unknown>, ticketKey: string, storeId: number): FileLocation | null {
  const key = locationKey(src, ticketKey);
  const files = LOCATIONS.get(key);
  if (!files) return null;
  // Most recently used last.
  LOCATIONS.delete(key);
  LOCATIONS.set(key, files);
  return files.get(storeId) ?? null;
}

/** Forgets a source's file locations (its run ended, `dispose`), or all of them (tests). */
export function forgetFileLocations(sourceId?: string): void {
  if (sourceId === undefined) {
    LOCATIONS.clear();
    return;
  }
  for (const key of [...LOCATIONS.keys()]) if (key.startsWith(`${sourceId}\n`)) LOCATIONS.delete(key);
}

// ------------------------------------------------------------------- load

/**
 * Requests in flight for one ticket's per-article read: the source client's
 * own semaphore (TICKET_IMPORT_SOURCE_CONCURRENCY, default 2) still bounds
 * the whole slice; this bounds how many this loop starts at once.
 */
export const ZAMMAD_ARTICLE_READS_IN_FLIGHT = 2;

/**
 * `fn` over `items`, at most `limit` at a time, in order. After the first
 * failure no new call starts; the ones in flight settle, then that first
 * error is thrown. Results keep the items' order.
 */
export async function boundedInOrder<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      const i = next;
      next += 1;
      try {
        out[i] = await fn(items[i]!);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return out;
}

/** Each article on its own (`GET /ticket_articles/:id`), in `by_ticket` order. */
async function articlesOneByOne(src: SourceHandle<unknown>, ids: readonly number[]): Promise<ZammadArticle[]> {
  const articles = await boundedInOrder(ids, ZAMMAD_ARTICLE_READS_IN_FLIGHT, (id) => getArticle(src, id));
  return articles.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
}

let bigTicketArticles = ZAMMAD_BIG_TICKET_ARTICLES;

/** Tests only: the article count above which a ticket is read article by article. */
export const __zammadReadingTestHooks = {
  setBigTicketArticles(n: number | null): void {
    bigTicketArticles = n ?? ZAMMAD_BIG_TICKET_ARTICLES;
  },
};

/**
 * A ticket's articles. The path is decided from the TOTAL article count,
 * System articles included: `article_count` counts non-System articles only
 * (Z5), so a ticket full of trigger notes would otherwise be read whole with
 * `by_ticket` first. `GET /tickets/:id?expand=true` gives every article id in
 * a small answer. (Not `?all=true`: its assets carry every visible article,
 * so it would itself be the large read this avoids.) Over 500, or when
 * `by_ticket` passes the JSON cap, each article is read on its own (§11).
 */
export async function zammadArticles(src: SourceHandle<unknown>, ticketId: number): Promise<ZammadArticle[]> {
  const ids = await getTicketArticleIds(src, ticketId);
  if (ids.length > bigTicketArticles) return articlesOneByOne(src, ids);
  try {
    return await articlesByTicket(src, ticketId);
  } catch (error) {
    if (error instanceof SourceResponseTooLargeError) return articlesOneByOne(src, ids);
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
  const [articles, tags] = await Promise.all([zammadArticles(src, ticket.id), ticketTags(src, ticket.id)]);
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
    invalidRows: takeZammadInvalidRows(src),
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
