/**
 * A fake Zammad 7.2.x for tests (#8313 W5; spec 2026-10-19 §6.8, §8 W5
 * row). It serves the synthesized fixture sets of `__fixtures__/` (see its
 * README: shapes from the 7.2.2 source, validated later against a live
 * 7.2.0; not captured from a live instance) the way 7.2.2 answers them:
 * token auth, page clamps, `id ASC` ticket pages, 404 for a deleted ticket
 * and 403 for a hidden one, the attachment route's ticket/article check,
 * original bytes without `view` and a resized copy with it.
 *
 * Two transports over one router: `fetchImpl` answers in process (unit
 * tests), and `listen()` runs a node `http` server on 127.0.0.1 (the
 * end-to-end test) with `loopbackFetch` as the source client's transport.
 * The client still builds every URL under the source's https base URL; only
 * the socket goes to the loopback server, the same seam W4's tests use
 * (`SourceClientOptions.fetchImpl`). `.fixtures.ts`: test code only, never
 * part of the runtime build (tsconfig.src.json excludes it).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResponseTooLargeError, type SafeFetchInit } from '../../../urlSafety';
import type { SourceHandle } from '../../moduleContract';
import { createSourceClient } from '../../sourceFetch';
import { buildSourceHandle } from '../../sourceHandle';

const FIXTURES_DIR = fileURLToPath(new URL('./__fixtures__/', import.meta.url));

export type FixtureSetName = 'base' | 'delta';

type Json = unknown;
type Row = Record<string, unknown> & { id: number };

/** One fixture set as plain data; tests may change it before serving. */
export type ZammadFixtureData = {
  /** `GET /version`; null answers 403, as for a token without `admin`. */
  version: Json | null;
  me: Json;
  roles: Row[];
  users: Row[];
  organizations: Row[];
  groups: Row[];
  states: Row[];
  priorities: Row[];
  /** The 403 body of the object manager index (the token has no admin.object). */
  objectAttributesForbidden: Json;
  tickets: Row[];
  /** `?expand=true` answers that differ from the derived one (the ticket plus its `article_ids`). */
  ticketsExpand: Map<number, Row>;
  byTicket: Map<number, Row[]>;
  tags: Map<number, string[]>;
  links: Map<number, Json>;
  files: Map<number, Buffer>;
  hidden: Set<number>;
};

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function filesIn(dir: string): string[] {
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

/** The fixture files of a set, base first, the delta's overlay on top. */
function fixtureFiles(set: FixtureSetName): Map<string, string> {
  const out = new Map<string, string>();
  const sets: FixtureSetName[] = set === 'base' ? ['base'] : ['base', 'delta'];
  for (const name of sets) {
    const root = join(FIXTURES_DIR, name);
    for (const file of filesIn(root)) out.set(file, join(root, file));
    for (const sub of ['by_ticket', 'links', 'tickets-expand']) {
      for (const file of filesIn(join(root, sub))) out.set(`${sub}/${file}`, join(root, sub, file));
    }
  }
  return out;
}

export function loadZammadFixtures(set: FixtureSetName = 'base'): ZammadFixtureData {
  const files = fixtureFiles(set);
  const get = (name: string): Json => {
    const path = files.get(name);
    if (!path) throw new Error(`Zammad fixture ${set}/${name} is missing`);
    return readJson(path);
  };
  const byPrefix = <T>(prefix: string): Map<number, T> => {
    const out = new Map<number, T>();
    for (const [name, path] of files) {
      if (name.startsWith(`${prefix}/`)) out.set(Number(name.slice(prefix.length + 1, -'.json'.length)), readJson(path) as T);
    }
    return out;
  };
  const tags = get('tags.json') as Record<string, string[]>;
  const fileBytes = get('files.json') as Record<string, { base64: string }>;
  return {
    version: get('version.json'),
    me: get('users-me.json'),
    roles: get('roles.json') as Row[],
    users: get('users.json') as Row[],
    organizations: get('organizations.json') as Row[],
    groups: get('groups.json') as Row[],
    states: get('ticket_states.json') as Row[],
    priorities: get('ticket_priorities.json') as Row[],
    objectAttributesForbidden: get('object_manager_attributes.403.json'),
    tickets: get('tickets.json') as Row[],
    ticketsExpand: byPrefix<Row>('tickets-expand'),
    byTicket: byPrefix<Row[]>('by_ticket'),
    tags: new Map(Object.entries(tags).map(([k, v]) => [Number(k), v])),
    links: byPrefix<Json>('links'),
    files: new Map(Object.entries(fileBytes).map(([k, v]) => [Number(k), Buffer.from(v.base64, 'base64')])),
    hidden: new Set(get('hidden.json') as number[]),
  };
}

export type FakeZammadRequest = { method: string; path: string; query: Record<string, string>; authorization: string | null };
export type FakeZammadResponse = { status: number; headers: Record<string, string>; body: Buffer };

/** A canned failure for the next requests whose path starts with `pathPrefix`. */
export type FakeZammadFailure = { pathPrefix: string; status: number; headers?: Record<string, string>; times?: number };

export type FakeZammadOptions = {
  token?: string;
  /** The server's clock, sent as the `Date` header. Default: now. */
  now?: () => Date;
};

export const FAKE_ZAMMAD_TOKEN = 'zammad-fixture-token';
export const FAKE_ZAMMAD_BASE_URL = 'https://zammad.example.test';

/** The marker a `view=` download answers with: a resized copy is never the original. */
export const RESIZED_COPY = Buffer.from('resized-copy-not-the-original');

function jsonResponse(status: number, body: Json, now: Date): FakeZammadResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', date: now.toUTCString() },
    body: Buffer.from(JSON.stringify(body)),
  };
}

function page<T>(rows: readonly T[], query: Record<string, string>, defaultSize: number, maxSize: number): T[] {
  const pageNo = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const asked = Number.parseInt(query.per_page ?? query.limit ?? String(defaultSize), 10) || defaultSize;
  const size = Math.min(Math.max(1, asked), maxSize);
  return rows.slice((pageNo - 1) * size, pageNo * size);
}

export class FakeZammad {
  data: ZammadFixtureData;
  readonly requests: FakeZammadRequest[] = [];
  private readonly failures: FakeZammadFailure[] = [];
  private readonly token: string;
  private readonly now: () => Date;

  constructor(data: ZammadFixtureData = loadZammadFixtures('base'), options: FakeZammadOptions = {}) {
    this.data = data;
    this.token = options.token ?? FAKE_ZAMMAD_TOKEN;
    this.now = options.now ?? (() => new Date());
  }

  /** Serves another set (the delta), keeping the request log. */
  use(set: FixtureSetName | ZammadFixtureData): void {
    this.data = typeof set === 'string' ? loadZammadFixtures(set) : set;
  }

  failNext(failure: FakeZammadFailure): void {
    this.failures.push({ times: 1, ...failure });
  }

  /** Paths requested, in order, with their query (`/api/v1/tickets?page=1&per_page=100`). */
  requestedPaths(): string[] {
    return this.requests.map((r) => {
      const q = new URLSearchParams(r.query).toString();
      return q ? `${r.path}?${q}` : r.path;
    });
  }

  handle(method: string, url: URL, authorization: string | null): FakeZammadResponse {
    const query = Object.fromEntries(url.searchParams.entries());
    this.requests.push({ method, path: url.pathname, query, authorization });
    const now = this.now();
    const failure = this.failures.find((f) => url.pathname.startsWith(f.pathPrefix) && (f.times ?? 1) > 0);
    if (failure) {
      failure.times = (failure.times ?? 1) - 1;
      const out = jsonResponse(failure.status, { error: `fake failure ${failure.status}` }, now);
      return { ...out, headers: { ...out.headers, ...(failure.headers ?? {}) } };
    }
    if (method !== 'GET') return jsonResponse(405, { error: 'Only GET is served' }, now);
    if (authorization !== `Token token=${this.token}`) {
      return jsonResponse(401, { error: 'authentication failed', error_human: 'Authentication failed.' }, now);
    }
    const d = this.data;
    // Zammad may live under a path prefix of the base URL (`https://host/zammad`).
    const segments = url.pathname.replace(/^(?:\/[^/]+)*?\/api\/v1\//, '').split('/').map(decodeURIComponent);
    const notFound = (what: string) => jsonResponse(404, { error: `Couldn't find ${what}`, error_human: `Couldn't find ${what}` }, now);
    const forbidden = () => jsonResponse(403, { error: 'Not authorized', error_human: 'Not authorized' }, now);
    const ticketGate = (id: number): FakeZammadResponse | null => {
      if (d.hidden.has(id)) return forbidden();
      if (!d.tickets.some((t) => t.id === id)) return notFound(`Ticket with 'id'=${id}`);
      return null;
    };
    const [head, second, third] = segments;
    const id = (value: string | undefined) => (value && /^\d+$/.test(value) ? Number(value) : NaN);

    switch (head) {
      case 'version':
        // version_controller_policy: default_permit!('admin').
        return d.version === null ? forbidden() : jsonResponse(200, d.version, now);
      case 'users':
        if (second === 'me') return jsonResponse(200, d.me, now);
        if (second === undefined) return jsonResponse(200, page(d.users, query, 100, 1000), now);
        return jsonResponse(...this.one(d.users, id(second), 'User'), now);
      case 'roles':
        return jsonResponse(200, page(d.roles, query, 500, 1000), now);
      case 'organizations':
        return jsonResponse(200, page(d.organizations, query, 500, 1000), now);
      case 'groups':
        return jsonResponse(200, page(d.groups, query, 500, 1000), now);
      case 'ticket_states':
        return jsonResponse(200, page(d.states, query, 500, 1000), now);
      case 'ticket_priorities':
        return jsonResponse(200, page(d.priorities, query, 500, 1000), now);
      case 'object_manager_attributes':
        return jsonResponse(403, d.objectAttributesForbidden, now);
      case 'tickets': {
        if (second === undefined) return jsonResponse(200, page([...d.tickets].sort((a, b) => a.id - b.id), query, 100, 100), now);
        const tid = id(second);
        const gate = ticketGate(tid);
        if (gate) return gate;
        if (query.expand === 'true') {
          // `article_ids`: every article of the ticket, System ones included.
          const expanded = d.ticketsExpand.get(tid)
            ?? { ...d.tickets.find((t) => t.id === tid), article_ids: (d.byTicket.get(tid) ?? []).map((a) => a.id) };
          return jsonResponse(200, expanded, now);
        }
        return jsonResponse(200, d.tickets.find((t) => t.id === tid), now);
      }
      case 'ticket_articles': {
        if (second === 'by_ticket') {
          const tid = id(third);
          const gate = ticketGate(tid);
          if (gate) return gate;
          return jsonResponse(200, d.byTicket.get(tid) ?? [], now);
        }
        const aid = id(second);
        for (const [tid, articles] of d.byTicket) {
          const article = articles.find((a) => a.id === aid);
          if (!article) continue;
          const gate = ticketGate(tid);
          return gate ?? jsonResponse(200, article, now);
        }
        return notFound(`Ticket::Article with 'id'=${second}`);
      }
      case 'tags': {
        const tid = id(query.o_id);
        const gate = ticketGate(tid);
        if (gate) return gate;
        return jsonResponse(200, { tags: d.tags.get(tid) ?? [] }, now);
      }
      case 'links': {
        const tid = id(query.link_object_value);
        // links_controller_policy: a ticket the caller cannot read, or none, is 403.
        if (d.hidden.has(tid) || !d.tickets.some((t) => t.id === tid)) return forbidden();
        return jsonResponse(200, d.links.get(tid) ?? { links: [], assets: {} }, now);
      }
      case 'ticket_attachment':
        return this.attachment(segments, query, now);
      default:
        return notFound(url.pathname);
    }
  }

  private one(rows: Row[], wanted: number, what: string): [number, Json] {
    const row = rows.find((r) => r.id === wanted);
    return row ? [200, row] : [404, { error: `Couldn't find ${what} with 'id'=${wanted}` }];
  }

  /** ticket_articles_controller#attachment: the article belongs to the ticket, or the ticket is merged (Z8). */
  private attachment(segments: string[], query: Record<string, string>, now: Date): FakeZammadResponse {
    const [, t, a, s] = segments.map((v) => (v && /^\d+$/.test(v) ? Number(v) : NaN));
    const d = this.data;
    if (d.hidden.has(t!)) return jsonResponse(403, { error: 'Not authorized' }, now);
    const ticket = d.tickets.find((row) => row.id === t);
    if (!ticket) return jsonResponse(404, { error: `Couldn't find Ticket with 'id'=${t}` }, now);
    const merged = d.states.find((row) => row.id === ticket.state_id)?.state_type === 'merged';
    let article: Row | undefined;
    for (const [tid, articles] of d.byTicket) {
      const found = articles.find((row) => row.id === a);
      if (found && (tid === t || merged)) article = found;
    }
    if (!article) return jsonResponse(403, { error: 'Not authorized' }, now);
    const meta = (article.attachments as Array<{ id: number; preferences?: Record<string, unknown> }>).find((row) => row.id === s);
    const bytes = d.files.get(s!);
    if (!meta || !bytes) return jsonResponse(404, { error: `Couldn't find Store with 'id'=${s}` }, now);
    const type = String(meta.preferences?.['Content-Type'] ?? meta.preferences?.['Mime-Type'] ?? 'application/octet-stream');
    return {
      status: 200,
      headers: { 'content-type': type, date: now.toUTCString() },
      body: query.view ? RESIZED_COPY : bytes,
    };
  }

  /** The in-process transport: a `safeFetch` stand-in that honours `maxBytes`. */
  fetchImpl = async (url: string, init: SafeFetchInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers as HeadersInit | undefined);
    const out = this.handle(init.method ?? 'GET', new URL(url), headers.get('authorization'));
    if (init.maxBytes !== undefined && out.body.byteLength > init.maxBytes) throw new ResponseTooLargeError(init.maxBytes);
    return new Response(new Uint8Array(out.body), { status: out.status, headers: out.headers });
  };

  /** Runs the router as a node `http` server on 127.0.0.1 (an ephemeral port). */
  async listen(): Promise<{ port: number; origin: string; close: () => Promise<void> }> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : null;
      const out = this.handle(req.method ?? 'GET', url, auth);
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      port,
      origin: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    };
  }
}

/**
 * The source client's transport to a loopback server: the request URL (under
 * the source's https base) is sent to `origin` with the same path, query and
 * headers, and the answer is bounded by `maxBytes` as `safeFetch` bounds it.
 */
export function loopbackFetch(origin: string) {
  return async (url: string, init: SafeFetchInit = {}): Promise<Response> => {
    const target = new URL(url);
    const local = new URL(`${target.pathname}${target.search}`, origin);
    const response = await fetch(local, { method: init.method ?? 'GET', headers: init.headers as HeadersInit | undefined });
    const body = new Uint8Array(await response.arrayBuffer());
    if (init.maxBytes !== undefined && body.byteLength > init.maxBytes) throw new ResponseTooLargeError(init.maxBytes);
    return new Response(body, { status: response.status, headers: response.headers });
  };
}

/**
 * A source handle on the fake (in process): the real client, its URL rules,
 * retries and `Retry-After` handling, with no waiting between retries.
 */
export function zammadTestHandle(
  fake: FakeZammad,
  input: { sourceId?: string; options?: Record<string, unknown>; token?: string; baseUrl?: string } = {},
): SourceHandle<unknown> {
  const baseUrl = input.baseUrl ?? FAKE_ZAMMAD_BASE_URL;
  const http = createSourceClient(baseUrl, {
    timeoutMs: 5_000,
    concurrency: 2,
    fetchImpl: fake.fetchImpl as never,
    sleep: async () => undefined,
  });
  return buildSourceHandle({
    sourceId: input.sourceId ?? `zammad-test-${Math.random().toString(36).slice(2)}`,
    baseUrl,
    credentials: { token: input.token ?? FAKE_ZAMMAD_TOKEN },
    // The module reads its options from the conversion context, not the handle.
    options: input.options ?? {},
    http,
  });
}
