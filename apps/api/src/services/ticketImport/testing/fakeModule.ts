import { z } from 'zod';
import type { ImportedAttachment, ImportedComment, ImportedTicket } from '../importedTicket';
import type {
  ConnectReport,
  ImportedLink,
  LoadedTicket,
  ProbeResult,
  ReportNote,
  SourceHandle,
  SourceRow,
  TicketImportModule,
} from '../moduleContract';
import { SourceHttpError, SourceResponseTooLargeError } from '../sourceFetch';

/**
 * A fake import module for tests (#8313 W4; spec 2026-10-19 §8 W4 row). It
 * reads an in-memory source keyed by the source's base URL, so a test that
 * creates a real source row (any https URL) drives the real framework, the
 * real ledger and the real writer against a source it controls: pages,
 * versions, deletions, hidden tickets, files and failures. Production code
 * never imports it; tests register it with `registerTicketImportModule`.
 *
 * Id grammar: the ticket key is the ticket's key; `article:<id>` a source
 * article (`isSourceArticleId`); `note:<key>:<n>` a composed note;
 * `file:<id>` a file.
 */

export type FakeFile = { id: string; filename: string; bytes?: Uint8Array; declaredBytes?: number };

export type FakeComment = { id: string; at: Date; content: string; isPublic?: boolean; files?: FakeFile[] };

export type FakeTicket = {
  key: string;
  version: string;
  orgKey: string | null;
  number?: string;
  subject?: string;
  createdAt: Date;
  updatedAt?: Date;
  status?: ImportedTicket['finalStatus'];
  comments?: FakeComment[];
  ownerEmail?: string;
  requesterEmail?: string;
  links?: Array<Omit<ImportedLink, 'sourceKey'>>;
  notes?: ReportNote[];
  /** The conversion skips it as `unsupported`. */
  unsupported?: boolean;
  /** Produces a ticket the writer's schema refuses (an empty subject). */
  invalid?: boolean;
  /** A module bug: the converted ticket names another source id. */
  wrongSourceId?: boolean;
};

export type FakeSource = {
  tickets: FakeTicket[];
  pageSize: number;
  /** Probe answers for tickets the list no longer shows. */
  deleted: Set<string>;
  hidden: Set<string>;
  /** Keys left out of the list but still `present` on probe (an offset shift). */
  shifted: Set<string>;
  /** Queued failures, thrown once each, in order. */
  failures: { connect: unknown[]; scan: unknown[]; load: Map<string, unknown[]>; file: Map<string, unknown[]>; probe: Map<string, unknown[]> };
  calls: { connect: number; scan: number; load: string[]; probe: string[]; files: string[] };
  clockSkewMs: number | null;
};

const SOURCES = new Map<string, FakeSource>();

/** Creates (or replaces) the fake source behind `baseUrl` (normalized: no trailing slash). */
export function fakeSource(baseUrl: string, init: Partial<Pick<FakeSource, 'tickets' | 'pageSize' | 'clockSkewMs'>> = {}): FakeSource {
  const source: FakeSource = {
    tickets: init.tickets ?? [],
    pageSize: init.pageSize ?? 2,
    deleted: new Set(),
    hidden: new Set(),
    shifted: new Set(),
    failures: { connect: [], scan: [], load: new Map(), file: new Map(), probe: new Map() },
    calls: { connect: 0, scan: 0, load: [], probe: [], files: [] },
    clockSkewMs: init.clockSkewMs ?? 0,
  };
  SOURCES.set(baseUrl.replace(/\/+$/, ''), source);
  return source;
}

export function clearFakeSources(): void {
  SOURCES.clear();
}

function sourceOf(src: SourceHandle<unknown>): FakeSource {
  const source = SOURCES.get(src.baseUrl);
  if (!source) throw new SourceHttpError(404, `No fake source at ${src.baseUrl}`);
  return source;
}

function takeFailure(queue: unknown[] | undefined): void {
  const next = queue?.shift();
  if (next !== undefined) throw next;
}

function rowOf(ticket: FakeTicket): SourceRow {
  return { key: ticket.key, version: ticket.version, orgKey: ticket.orgKey, number: ticket.number ?? null, summary: { key: ticket.key } };
}

function listed(source: FakeSource): FakeTicket[] {
  return source.tickets.filter((t) => !source.deleted.has(t.key) && !source.hidden.has(t.key) && !source.shifted.has(t.key));
}

export const fakeOptionsSchema = z.object({ timeNote: z.boolean().default(false) }).strict();
export type FakeOptions = z.infer<typeof fakeOptionsSchema>;

export const FAKE_MODULE_ID = 'fake';

export const fakeTicketImportModule: TicketImportModule<FakeOptions, number> = {
  id: FAKE_MODULE_ID,
  label: 'Fake (tests)',
  optionsSchema: fakeOptionsSchema,

  async connect(src): Promise<ConnectReport> {
    const source = sourceOf(src);
    source.calls.connect += 1;
    takeFailure(source.failures.connect);
    return { identity: { key: '1', name: 'Import', email: null }, permissions: ['ticket.agent'], warnings: [], clockSkewMs: source.clockSkewMs };
  },

  async catalog(src) {
    const source = sourceOf(src);
    const orgKeys = [...new Set(source.tickets.map((t) => t.orgKey).filter((k): k is string => k !== null))];
    return { orgs: orgKeys.map((key) => ({ key, name: `Org ${key}` })), groups: [], priorities: [], states: [], attributes: [], counts: { tickets: source.tickets.length } };
  },

  async scan(src, cursor) {
    const source = sourceOf(src);
    source.calls.scan += 1;
    takeFailure(source.failures.scan);
    const page = cursor ?? 0;
    const all = listed(source);
    const rows = all.slice(page * source.pageSize, (page + 1) * source.pageSize).map(rowOf);
    return { rows, next: (page + 1) * source.pageSize < all.length ? page + 1 : null };
  },

  async load(src, row): Promise<LoadedTicket> {
    const source = sourceOf(src);
    source.calls.load.push(row.key);
    takeFailure(source.failures.load.get(row.key));
    const ticket = source.tickets.find((t) => t.key === row.key);
    if (!ticket) throw new SourceHttpError(404);
    return {
      row,
      data: ticket,
      needs: {
        userEmails: ticket.ownerEmail ? [ticket.ownerEmail] : [],
        contactEmails: ticket.requesterEmail ? [ticket.requesterEmail] : [],
      },
    };
  },

  convert(loaded, ctx) {
    const t = loaded.data as FakeTicket;
    const notes: ReportNote[] = [...(t.notes ?? [])];
    if (t.unsupported) return { kind: 'skip', code: 'unsupported', notes };
    const owner = t.ownerEmail ? ctx.userIdByEmail.get(t.ownerEmail.toLowerCase()) : undefined;
    if (t.ownerEmail && !owner) notes.push({ kind: 'owner_unmatched', sourceUserKey: t.ownerEmail.toLowerCase() });
    const contactId = t.requesterEmail ? ctx.contactIdByEmail.get(t.requesterEmail.toLowerCase()) : undefined;
    if (!contactId) notes.push({ kind: 'requester_without_contact' });
    const comments: ImportedComment[] = (t.comments ?? []).map((c) => ({
      sourceId: `article:${c.id}`,
      createdAt: c.at,
      isPublic: c.isPublic ?? true,
      author: { kind: 'staff', name: 'Agent' },
      content: c.content,
      ...(c.files?.length
        ? {
          attachments: c.files.map((f): ImportedAttachment => ({
            sourceId: `file:${f.id}`,
            filename: f.filename,
            ...(f.declaredBytes !== undefined ? { declaredBytes: f.declaredBytes } : {}),
            inline: false,
          })),
        }
        : {}),
    }));
    const updatedAt = t.updatedAt ?? t.createdAt;
    const status = t.status ?? 'open';
    const ticket: ImportedTicket = {
      sourceId: t.wrongSourceId ? `${t.key}-other` : t.key,
      ...(t.number ? { sourceNumber: t.number } : {}),
      orgId: ctx.orgId,
      createdAt: t.createdAt,
      updatedAt,
      subject: t.invalid ? '' : t.subject ?? `Ticket ${t.key}`,
      description: '',
      priority: 'normal',
      source: 'manual',
      requester: contactId ? { contactId } : { name: 'Requester', ...(t.requesterEmail ? { email: t.requesterEmail } : {}) },
      ...(owner ? { assigneeUserId: owner } : {}),
      finalStatus: status,
      ...(status === 'closed' ? { closedAt: updatedAt } : {}),
      ...(status === 'resolved' ? { resolvedAt: updatedAt } : {}),
      comments,
    };
    return { kind: 'ticket', ticket, links: (t.links ?? []).map((l) => ({ ...l, sourceKey: t.key })), notes };
  },

  async fetchAttachment(src, ref, maxBytes) {
    const source = sourceOf(src);
    source.calls.files.push(ref.sourceId);
    takeFailure(source.failures.file.get(ref.sourceId));
    const id = ref.sourceId.replace(/^file:/, '');
    const file = source.tickets.flatMap((t) => t.comments ?? []).flatMap((c) => c.files ?? []).find((f) => f.id === id);
    if (!file || !file.bytes) throw new SourceHttpError(404);
    if (file.bytes.byteLength > maxBytes) throw new SourceResponseTooLargeError(maxBytes);
    return file.bytes;
  },

  async probe(src, key): Promise<ProbeResult> {
    const source = sourceOf(src);
    source.calls.probe.push(key);
    takeFailure(source.failures.probe.get(key));
    if (source.deleted.has(key)) return { state: 'deleted' };
    if (source.hidden.has(key)) return { state: 'hidden' };
    const ticket = source.tickets.find((t) => t.key === key);
    if (!ticket) return { state: 'deleted' };
    return { state: 'present', row: rowOf(ticket) };
  },

  isSourceArticleId(id) {
    return id.startsWith('article:');
  },
};
