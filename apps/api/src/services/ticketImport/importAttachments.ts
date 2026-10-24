import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TICKET_ATTACHMENT_LIMITS } from '@breeze/shared';
import { db } from '../../db';
import { ticketAttachments } from '../../db/schema';
import { sanitizeAttachmentFilename } from '../attachmentFilename';
import { sniffAttachmentMime } from '../attachmentSniff';
import { objectKeyFor } from '../ticketAttachmentStorage';
import { assertTicketNotMerged } from '../ticketMerge/errors';
import { lockTicketForWrite } from '../ticketRowLock';
import type { ImportedAttachmentClaim } from '../ticketService';

/**
 * Attachments in import mode (#8313 W1; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §4): the rules that decide what an imported file becomes, and the two
 * statements the import writer (importWriter.ts) runs on `ticket_attachments`
 * before `addTicketComment` claims the files:
 *
 *   - `reserveImportAttachments`: the reservation, a pending row per file
 *     written BEFORE its bytes, so the pending reaper cleans up after a crash
 *     (§4.3 step 1);
 *   - `deleteSkippedReservations`: the pending rows of files that turned out
 *     to be permanently skipped, deleted in the chunk transaction (step 3).
 *
 * Both run only inside importTicket's window transactions. They take no write
 * mode and produce no side effect: no event, no outbox row, no audit row
 * (ticketService.sideEffects.test.ts scans this file for it).
 */

/** The live cap, kept for imports (§4.1); the size CHECK mirrors it. */
export const IMPORT_ATTACHMENT_MAX_BYTES = TICKET_ATTACHMENT_LIMITS.maxBytes;

/** Files per reservation transaction (§4.3 step 1): each costs one unit, so a transaction stays within the 600/h floor. */
export const IMPORT_RESERVATION_BATCH = 100;

/** Stored type of every file the sniff does not allowlist (§4.4): served download-only, with nosniff. */
export const IMPORTED_OCTET_STREAM = 'application/octet-stream';

/**
 * A reservation's metadata until the claim replaces it (§4.3): the generic
 * type and a zero digest. A pending row with no uploader is served to no one
 * (the content route answers a pending row to its uploader only), so this is
 * never seen; the claim in addTicketComment always overwrites it.
 */
export const PROVISIONAL_CONTENT_TYPE = IMPORTED_OCTET_STREAM;
export const PROVISIONAL_SHA256 = '0'.repeat(64);

/** The declared size clamped into the size CHECK's 1..10,485,760; 1 when the source declared none. */
export function provisionalByteSize(declaredBytes: number | undefined): number {
  if (declaredBytes === undefined || !Number.isFinite(declaredBytes)) return 1;
  return Math.min(IMPORT_ATTACHMENT_MAX_BYTES, Math.max(1, Math.floor(declaredBytes)));
}

/**
 * Why a file was not imported with its comment. The four of §4.4 are
 * permanent (a later pass skips the file again) and are named in the
 * comment's note. `present_elsewhere`: this principal's resume key for the
 * file is already held, by an attached file or by a row the window cannot
 * see (a source merge moved the article, or its ticket moved out of the
 * window's orgs); the file is in Breeze, so it is not in the note, but it is
 * reported, so written + skipped always equals the source's file count.
 */
export type ImportAttachmentSkipReason = 'too_large' | 'empty' | 'blocked_type' | 'not_found' | 'present_elsewhere';

/** The skip reasons the comment's note names: the file is not in Breeze. */
type NotedSkipReason = Exclude<ImportAttachmentSkipReason, 'present_elsewhere'>;

/** A skipped file, as the result and the run report list it. */
export type ImportAttachmentSkip = { sourceId: string; reason: ImportAttachmentSkipReason };

/**
 * The executable denylist (decision 1, §4.4), by final extension. A file
 * whose final extension is one of these is skipped as `blocked_type` before
 * it is reserved. importAttachments.test.ts pins every entry.
 *
 * The first four rows are the spec's: Windows, script and installer types,
 * Java archives, shortcuts, registry and setup files, shell scripts, macOS
 * bundles and installers, and macro-enabled OOXML documents. The last three
 * go beyond it (W1 review): Excel macro and add-in carriers (`xlsb` holds
 * VBA, `xla`/`xlm` Excel 4 macros, `xll` is a DLL); other types Windows
 * executes or hands to a handler that runs code (`chm`, `msc`, `url`,
 * ClickOnce `application`/`appref-ms`, script components `ws`/`wsc`/`vb`,
 * `gadget`, `website`, `settingcontent-ms`, `diagcab`, and the search and
 * library shortcuts `library-ms`/`search-ms`/`searchconnector-ms`); and disk
 * images, which carry files past mark-of-the-web (`iso`, `img`, `vhd`,
 * `vhdx`). `mht`/`mhtml` are not on it: archived pages a browser renders,
 * not an execution or MOTW-bypass carrier on their own.
 *
 * Residual risk: legacy OLE Office files (`doc`, `xls`, `ppt`) can carry VBA
 * too, but they are most of a mail history and the VBA cannot be detected
 * without parsing OLE; they are imported, download-only. Archives are not
 * opened either: an executable inside a ZIP is imported as a ZIP (§4.1).
 */
export const EXECUTABLE_EXTENSIONS: readonly string[] = Object.freeze([
  'exe', 'dll', 'com', 'scr', 'pif', 'cpl', 'msi', 'msp', 'msix', 'appx',
  'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
  'jar', 'lnk', 'reg', 'scf', 'inf', 'sh', 'app', 'dmg', 'pkg',
  'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm',
  'xlsb', 'xla', 'xlm', 'xll',
  'chm', 'msc', 'url', 'application', 'appref-ms', 'ws', 'wsc', 'vb', 'gadget', 'website',
  'settingcontent-ms', 'diagcab', 'library-ms', 'search-ms', 'searchconnector-ms',
  'iso', 'img', 'vhd', 'vhdx',
]);

/**
 * The executable denylist by first bytes (§4.4), whatever the name: PE (`MZ`),
 * ELF, and Mach-O in both byte orders, 32 and 64 bit, plus the universal
 * ("fat") header. `CAFEBABE` is also a Java class file's magic; a bare class
 * file is skipped with it, which is the side the denylist errs on.
 * importAttachments.test.ts pins every entry.
 */
export const EXECUTABLE_HEADERS: ReadonlyArray<{ name: string; magic: readonly number[] }> = Object.freeze([
  { name: 'PE (MZ)', magic: [0x4d, 0x5a] },
  { name: 'ELF', magic: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'Mach-O 32-bit, big-endian', magic: [0xfe, 0xed, 0xfa, 0xce] },
  { name: 'Mach-O 64-bit, big-endian', magic: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: 'Mach-O 32-bit, little-endian', magic: [0xce, 0xfa, 0xed, 0xfe] },
  { name: 'Mach-O 64-bit, little-endian', magic: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'Mach-O universal', magic: [0xca, 0xfe, 0xba, 0xbe] },
  { name: 'Mach-O universal, little-endian', magic: [0xbe, 0xba, 0xfe, 0xca] },
  { name: 'Mach-O universal 64-bit', magic: [0xca, 0xfe, 0xba, 0xbf] },
]);

const EXECUTABLE_EXTENSION_SET = new Set(EXECUTABLE_EXTENSIONS);

/**
 * The name an imported file is stored under: the live upload route's
 * sanitizer (basename only; no control characters, quotes or backslashes;
 * at most 255 characters; `attachment` when nothing is left). The
 * extension is kept (§4.4).
 */
export function importedAttachmentFilename(raw: string): string {
  return sanitizeAttachmentFilename(raw);
}

/**
 * A filename's final extension, lower-cased, after trailing dots and spaces
 * are trimmed (Windows ignores them, so `setup.EXE.` runs as `setup.EXE`).
 * Null for a name with no dot.
 */
export function finalExtension(filename: string): string | null {
  const trimmed = filename.replace(/[. ]+$/u, '');
  const dot = trimmed.lastIndexOf('.');
  if (dot < 0) return null;
  return trimmed.slice(dot + 1).toLowerCase();
}

/** The extension half of the denylist: `invoice.pdf.exe` and `setup.EXE.` both match. */
export function isBlockedFilename(filename: string): boolean {
  const ext = finalExtension(filename);
  return ext !== null && EXECUTABLE_EXTENSION_SET.has(ext);
}

/** The header half of the denylist. */
export function hasExecutableHeader(buf: Uint8Array): boolean {
  return EXECUTABLE_HEADERS.some(({ magic }) => buf.length >= magic.length && magic.every((byte, i) => buf[i] === byte));
}

/**
 * The one sniff of an imported file's bytes (§4.4), run where the live route
 * runs its own (F6): an executable header blocks it; a JPEG, PNG, WebP or PDF
 * keeps its sniffed type; anything else is stored as
 * `application/octet-stream`, so the routes serve it as `attachment` with
 * nosniff. The source's declared type is never consulted.
 */
export function sniffImportedAttachment(buf: Buffer): { blocked: true } | { blocked: false; contentType: string } {
  if (hasExecutableHeader(buf)) return { blocked: true };
  return { blocked: false, contentType: sniffAttachmentMime(buf) ?? IMPORTED_OCTET_STREAM };
}

/**
 * A skip decided before the file is reserved, from what the source declares:
 * a declared size over the cap or zero, or a denylisted name. Null when the
 * file is to be reserved and fetched.
 */
export function reservationSkip(declaredBytes: number | undefined, filename: string): ImportAttachmentSkipReason | null {
  if (isBlockedFilename(filename)) return 'blocked_type';
  if (declaredBytes !== undefined && declaredBytes > IMPORT_ATTACHMENT_MAX_BYTES) return 'too_large';
  if (declaredBytes === 0) return 'empty';
  return null;
}

/** Fetched bytes the cap and the CHECK refuse (§4.4), or null. */
export function fetchedBytesSkip(byteLength: number): ImportAttachmentSkipReason | null {
  if (byteLength > IMPORT_ATTACHMENT_MAX_BYTES) return 'too_large';
  if (byteLength === 0) return 'empty';
  return null;
}

const MAX_NAMED_IN_NOTE = 10;

const SKIP_TEXT: Record<NotedSkipReason, string> = {
  too_large: `over the ${Math.round(IMPORT_ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB limit`,
  empty: 'empty file',
  blocked_type: 'blocked file type',
  not_found: 'not found in the source',
};

const NOTE_PREFIX = '[Attachments not imported: ';

/**
 * One line naming each file of a comment that was not imported and why, in
 * the inbound-email note's shape (F8), or null when none was skipped:
 * `[Attachments not imported: a.zip (over the 10 MB limit); b.exe (blocked
 * file type)]`, at most ten names and then `; and N more`. A file present
 * elsewhere in Breeze is not named.
 */
export function attachmentSkipNote(skips: ReadonlyArray<{ filename: string; reason: ImportAttachmentSkipReason }>): string | null {
  const noted = skips.filter((s): s is { filename: string; reason: NotedSkipReason } => s.reason !== 'present_elsewhere');
  if (noted.length === 0) return null;
  const named = noted.slice(0, MAX_NAMED_IN_NOTE).map((s) => `${s.filename} (${SKIP_TEXT[s.reason]})`);
  const more = noted.length - named.length;
  return `${NOTE_PREFIX}${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}]`;
}

/** `content` with the skip note appended on its own line (unchanged when nothing was skipped). */
export function withAttachmentSkipNote(
  content: string,
  skips: ReadonlyArray<{ filename: string; reason: ImportAttachmentSkipReason }>,
): string {
  const note = attachmentSkipNote(skips);
  if (!note) return content;
  return content ? `${content}\n\n${note}` : note;
}

/**
 * The note at the end of a stored comment, as a Postgres regular expression
 * (`regexp_replace(content, …, '')`): the resume report compares the stored
 * content without it against the source's (sourceChanges.ts), so a comment
 * whose files were skipped is not reported as changed in the source. A
 * sanitized filename has no line break, so the note is one line.
 */
export const ATTACHMENT_SKIP_NOTE_PG_PATTERN = '(^|\\n\\n)\\[Attachments not imported: [^\\n]*\\]$';

const ATTACHMENT_SKIP_NOTE_JS = new RegExp(ATTACHMENT_SKIP_NOTE_PG_PATTERN);

/**
 * `content` without a trailing skip note: the JS side of the resume report's
 * comparison, the same expression the SQL side applies to the stored
 * content, so a source body that itself ends in such a line compares equal.
 */
export function stripAttachmentSkipNote(content: string): string {
  return content.replace(ATTACHMENT_SKIP_NOTE_JS, '');
}

/**
 * What a file's resume key holds for this principal, as far as the window can
 * see: a reservation (`pending`), a reservation whose bytes are already in
 * object storage (`stored`, see `markReservationStored`), or an attached file.
 */
export type ImportAttachmentState = 'pending' | 'stored' | 'attached';

/**
 * A stored reservation carries its real digest; one not yet stored carries
 * `PROVISIONAL_SHA256`. Built per call, not at module load, so suites that
 * partially mock the schema can import this file.
 */
const storedColumn = () => sql<boolean>`${ticketAttachments.sha256} <> ${PROVISIONAL_SHA256}`;

/**
 * This principal's rows for `sourceIds` that the window can see, by source
 * id: the read before the reservation, so an attached file is neither
 * reserved nor charged again, and only a file with no row is charged its
 * unit. In the window's context, unlocked; the reservation re-checks under
 * the lock.
 */
export async function importAttachmentStates(
  principalId: string,
  sourceIds: readonly string[],
): Promise<Map<string, ImportAttachmentState>> {
  const states = new Map<string, ImportAttachmentState>();
  for (let i = 0; i < sourceIds.length; i += 500) {
    const slice = sourceIds.slice(i, i + 500);
    const rows = await db
      .select({
        sourceId: ticketAttachments.importSourceId,
        attached: sql<boolean>`${ticketAttachments.commentId} IS NOT NULL`,
        stored: storedColumn(),
      })
      .from(ticketAttachments)
      .where(and(eq(ticketAttachments.originPrincipalId, principalId), inArray(ticketAttachments.importSourceId, slice)));
    for (const row of rows) {
      if (row.sourceId) states.set(row.sourceId, row.attached ? 'attached' : row.stored ? 'stored' : 'pending');
    }
  }
  return states;
}

export type ReservationFile = { sourceId: string; filename: string; declaredBytes?: number };

/**
 * A reserved row: `inserted` by this reservation, or an existing pending row
 * it refreshed. `stored` holds the real metadata of a refreshed row whose
 * bytes an earlier pass already stored (`markReservationStored`): the chunk
 * claims it without fetching or charging anything.
 */
export type ReservedRow = { id: string; sourceId: string; inserted: boolean; stored: ImportedAttachmentClaim | null };

/**
 * Reserves `files` on `ticketId` for the window's principal (§4.3 step 1):
 * one pending row each, before any byte is stored. Two statements, so that a
 * resume key held where the window cannot see never reaches an RLS check:
 *
 *   1. `INSERT … ON CONFLICT (origin_principal_id, import_source_id) DO
 *      NOTHING`: a new row gets a fresh id, `storage_backend 's3'` and the key
 *      `ticket-attachments/<id>`, no comment and no uploader, the three import
 *      columns, and provisional metadata (`provisionalByteSize`,
 *      `IMPORTED_OCTET_STREAM`, `PROVISIONAL_SHA256`). Its created_at is now,
 *      never historic, or the reaper (F9) would take it at once. A conflict,
 *      visible or not, inserts nothing and raises nothing.
 *   2. `UPDATE` of this principal's PENDING rows among the rest that the
 *      window can see: each keeps its id and key; its created_at is refreshed
 *      and it is re-pointed to this ticket, its org and this window.
 *
 * A key neither inserted nor refreshed is held by an attached row, or by a
 * row in an org outside the window (a source merge moved its article, or its
 * ticket was moved): the file is present elsewhere, and is not returned.
 * (An `ON CONFLICT DO UPDATE` here raised 42501 on such a row: Postgres
 * checks the UPDATE policy's USING clause against the conflicting row.)
 *
 * Ticket first (#8972 W0): the caller's transaction already holds the ticket
 * row (lockImportedTicket); the lock here re-takes it, a no-op, and reads the
 * org the rows take. A merged tombstone was skipped by the caller under the
 * same lock; the guard here never fires.
 */
export async function reserveImportAttachments(input: {
  ticketId: string;
  windowId: string;
  principalId: string;
  files: readonly ReservationFile[];
}): Promise<ReservedRow[]> {
  if (input.files.length === 0) return [];
  if (input.files.length > IMPORT_RESERVATION_BATCH) {
    throw new Error(`reserveImportAttachments takes at most ${IMPORT_RESERVATION_BATCH} files per transaction`);
  }
  const locked = await lockTicketForWrite(db, input.ticketId);
  if (!locked) throw new Error(`imported ticket ${input.ticketId} is not visible to its window`);
  assertTicketNotMerged(locked);
  const values = input.files.map((file) => {
    const id = randomUUID();
    return {
      id,
      orgId: locked.orgId,
      ticketId: input.ticketId,
      commentId: null,
      uploadedByUserId: null,
      storageBackend: 's3' as const,
      storageKey: objectKeyFor(id),
      data: null,
      contentType: PROVISIONAL_CONTENT_TYPE,
      byteSize: provisionalByteSize(file.declaredBytes),
      originalFilename: file.filename,
      sha256: PROVISIONAL_SHA256,
      attachedAt: null,
      migrationWindowId: input.windowId,
      originPrincipalId: input.principalId,
      importSourceId: file.sourceId,
    };
  });
  const inserted = await db
    .insert(ticketAttachments)
    .values(values)
    .onConflictDoNothing({
      target: [ticketAttachments.originPrincipalId, ticketAttachments.importSourceId],
      where: sql`${ticketAttachments.importSourceId} IS NOT NULL`,
    })
    .returning({ id: ticketAttachments.id, sourceId: ticketAttachments.importSourceId });
  const insertedIds = new Set(inserted.map((r) => r.sourceId));
  const rest = input.files.map((f) => f.sourceId).filter((id) => !insertedIds.has(id));
  const refreshed = rest.length === 0 ? [] : await db
    .update(ticketAttachments)
    .set({ createdAt: sql`now()`, ticketId: input.ticketId, orgId: locked.orgId, migrationWindowId: input.windowId })
    .where(and(
      eq(ticketAttachments.originPrincipalId, input.principalId),
      inArray(ticketAttachments.importSourceId, rest),
      isNull(ticketAttachments.commentId),
      isNull(ticketAttachments.uploadedByUserId),
    ))
    .returning({
      id: ticketAttachments.id,
      sourceId: ticketAttachments.importSourceId,
      stored: storedColumn(),
      contentType: ticketAttachments.contentType,
      byteSize: ticketAttachments.byteSize,
      sha256: ticketAttachments.sha256,
    });
  return [
    ...inserted.map((r) => ({ id: r.id, sourceId: r.sourceId!, inserted: true, stored: null })),
    ...refreshed.map((r) => ({
      id: r.id,
      sourceId: r.sourceId!,
      inserted: false,
      stored: r.stored ? { id: r.id, contentType: r.contentType, byteSize: r.byteSize, sha256: r.sha256 } : null,
    })),
  ];
}

/**
 * Records that a reservation's bytes are in object storage (spec 2026-10-19
 * §4.3 step 2, review finding 1): the real type, size and digest on the
 * still-pending row. From then on a later pass claims the file without
 * fetching it or charging the byte bucket again, so a chunk whose files
 * exceed one pass of the byte budget still finishes, one budget at a time.
 *
 * Put first, then this: a crash between the two leaves a pending row that is
 * not marked, which the next pass re-puts (the crash table holds). Runs in a
 * short import transaction after lockImportedTicket; the ticket lock here is
 * a no-op re-take. Only this principal's pending, unclaimed row on this
 * ticket matches: false when it was claimed, re-pointed or reaped since, and
 * the caller then treats the file as present elsewhere.
 */
export async function markReservationStored(ticketId: string, principalId: string, claim: ImportedAttachmentClaim): Promise<boolean> {
  assertTicketNotMerged(await lockTicketForWrite(db, ticketId));
  const rows = await db
    .update(ticketAttachments)
    .set({ contentType: claim.contentType, byteSize: claim.byteSize, sha256: claim.sha256 })
    .where(and(
      eq(ticketAttachments.id, claim.id),
      eq(ticketAttachments.ticketId, ticketId),
      isNull(ticketAttachments.commentId),
      isNull(ticketAttachments.uploadedByUserId),
      eq(ticketAttachments.originPrincipalId, principalId),
    ))
    .returning({ id: ticketAttachments.id });
  return rows.length === 1;
}

/**
 * Whether reservation `id` is still this principal's pending, unclaimed row
 * (review finding 3): read right before its bytes are put, so a run does not
 * overwrite the object of a file another run of the same ticket has claimed
 * since. In the window's context, unlocked: markReservationStored re-checks
 * under the row lock.
 */
export async function isReservationPending(id: string, principalId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: ticketAttachments.id })
    .from(ticketAttachments)
    .where(and(
      eq(ticketAttachments.id, id),
      isNull(ticketAttachments.commentId),
      isNull(ticketAttachments.uploadedByUserId),
      eq(ticketAttachments.originPrincipalId, principalId),
    ))
    .limit(1);
  return Boolean(row);
}

/**
 * Deletes this principal's pending reservations `ids` on `ticketId` (§4.3
 * step 3): files that turned out to be permanently skipped, for which nothing
 * was stored. Runs in the chunk transaction, after lockImportedTicket; the
 * ticket lock here is a no-op re-take. Only a pending import row that is not
 * stored matches, so an attached file, a live upload, or a reservation
 * another run of the same ticket stored meanwhile is never deleted.
 */
export async function deleteSkippedReservations(ticketId: string, principalId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  assertTicketNotMerged(await lockTicketForWrite(db, ticketId));
  const rows = await db
    .delete(ticketAttachments)
    .where(and(
      inArray(ticketAttachments.id, [...ids]),
      eq(ticketAttachments.ticketId, ticketId),
      isNull(ticketAttachments.commentId),
      isNull(ticketAttachments.uploadedByUserId),
      eq(ticketAttachments.originPrincipalId, principalId),
      eq(ticketAttachments.sha256, PROVISIONAL_SHA256),
    ))
    .returning({ id: ticketAttachments.id });
  return rows.length;
}
