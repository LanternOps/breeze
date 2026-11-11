import { createHash } from 'node:crypto';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { ticketComments } from '../../db/schema';
import { normalizeRequesterEmail } from '../ticketRequesterEmail';
import { ATTACHMENT_SKIP_NOTE_PG_PATTERN, stripAttachmentSkipNote } from './importAttachments';
import type { ImportedComment, ImportedTicket } from './importedTicket';

/**
 * Report-only detail of a resume (#8313 W0; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.3 item 3, §5.9): what changed in the source since a ticket was imported
 * that the import writer (importWriter.ts) does not apply. Nothing here writes.
 */

/**
 * What changed in the source since a ticket was imported that the writer
 * does NOT apply (spec 2026-10-19 §5.3 item 3, §5.9): report-only, no row
 * changes. Computed on a resume from the plan's read; on a first import
 * everything is false or empty. Each list's length is its count (the style of
 * the spec's `attachmentsSkipped`), in source order, holding source ids only,
 * so the run report (§5.10 `requester_changed`, `org_changed`,
 * `comments_changed`, `comments_missing`) can take it as is.
 */
export type SourceChanges = {
  /**
   * The input's requester is not the stored one: another contact, or a
   * display-only email that differs from the stored submitter email (trimmed,
   * case-insensitive; no email on both sides is equal). The name is not
   * compared. It also fires when a Breeze user changed the requester: no
   * reliable trace tells the two apart (a requester edit stamps no
   * field_provenance, and an org move or a contact deletion clears
   * requester_contact_id without one).
   */
  requesterChanged: boolean;
  /**
   * The input's org is not the ticket's. The writer never moves a ticket. It
   * also fires when the ticket was moved in Breeze: moveTicketOrg leaves only
   * a free-text feed note and best-effort audit rows, and a device move or an
   * org merge leaves none.
   */
  orgChanged: boolean;
  /**
   * Source-article comments of this import whose content or visibility
   * differs in the source. With `ImportTicketOptions.isSourceArticleId`, a
   * note the module composed is never one: it is module output, not the
   * source's.
   */
  commentsChangedInSource: CommentChangedInSource[];
  /**
   * Source article ids this import stored on the ticket that the input no
   * longer has (deleted in the source). Counted only when the caller passes
   * `ImportTicketOptions.isSourceArticleId`; empty otherwise. An article the
   * source moved to another ticket (a merge in the source) also reads as
   * deleted here: the module must exclude the articles it knows moved,
   * through `isSourceArticleId`.
   */
  commentsMissingInSource: string[];
};

export type CommentChangedInSource = {
  sourceId: string;
  /**
   * The content differs from what the writer would store for the input. Not
   * compared for a comment a Breeze user edited since (Breeze wins).
   */
  contentChanged: boolean;
  /**
   * The source flipped the internal flag: 'made_internal' means the comment
   * is public in Breeze and internal in the source, the case the report lists
   * first (§5.9); 'made_public' the reverse; null when it did not change.
   */
  visibility: 'made_internal' | 'made_public' | null;
};

/** A first import's: nothing to compare against. */
export function noSourceChanges(): SourceChanges {
  return { requesterChanged: false, orgChanged: false, commentsChangedInSource: [], commentsMissingInSource: [] };
}

/** A comment this principal imported onto the ticket, as the report compares it. */
export type StoredImportedComment = {
  sourceId: string;
  isPublic: boolean;
  /**
   * sha256 (hex) of the stored content's UTF-8 bytes, without the note the
   * writer appends when files were skipped (#8313 W1: the note is the
   * import's, not the source's); computed only for a comment whose source id
   * is in the input (null otherwise).
   */
  contentHash: string | null;
  /** A Breeze user edited its content since (editTicketComment). */
  edited: boolean;
  /** Soft-deleted in Breeze. */
  deleted: boolean;
  /** Moved here from another ticket by a Breeze merge (#8972). */
  mergedIn: boolean;
};

/**
 * The comments this principal imported onto `ticketId`, for a resume: one
 * read that serves both the presence check (which input comments are already
 * here, by id) and the report (`sourceChanges`). The content is hashed only
 * for a comment whose source id is in the input, the only ones the report
 * compares; the rest cost their id and flags. `inputSourceIds` travels as one
 * JSON parameter, however long the thread.
 */
export async function importedCommentsOf(
  ticketId: string,
  principalId: string,
  inputSourceIds: readonly string[],
): Promise<StoredImportedComment[]> {
  const inInput = sql`${ticketComments.importSourceId} IN (SELECT jsonb_array_elements_text(${JSON.stringify(inputSourceIds)}::jsonb))`;
  const rows = await db
    .select({
      sourceId: ticketComments.importSourceId,
      isPublic: ticketComments.isPublic,
      contentHash: sql<string | null>`CASE WHEN ${inInput} THEN encode(sha256(convert_to(regexp_replace(${ticketComments.content}, ${ATTACHMENT_SKIP_NOTE_PG_PATTERN}::text, ''), 'UTF8')), 'hex') END`,
      edited: sql<boolean>`${ticketComments.editedAt} IS NOT NULL`,
      deleted: sql<boolean>`${ticketComments.deletedAt} IS NOT NULL`,
      mergedIn: sql<boolean>`${ticketComments.mergedFromTicketId} IS NOT NULL`,
    })
    .from(ticketComments)
    .where(and(
      eq(ticketComments.ticketId, ticketId),
      eq(ticketComments.originPrincipalId, principalId),
      isNotNull(ticketComments.importSourceId),
    ))
    .orderBy(asc(ticketComments.createdAt), asc(ticketComments.id));
  return rows.filter((r): r is StoredImportedComment => r.sourceId !== null);
}

/**
 * The content the writer stores for an imported comment. The report compares
 * against it, so a comment the writer would store unchanged is never reported
 * as changed in the source: any normalisation added here applies to both.
 */
export function storedCommentContent(comment: ImportedComment): string {
  return comment.content;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * What changed in the source that a resume does not apply (`SourceChanges`;
 * spec 2026-10-19 §5.3 item 3, §5.9). Pure: `stored` and `storedComments` are
 * the plan's read.
 *
 * - A comment a Breeze user deleted is neither changed nor missing: Breeze
 *   already removed it. One a Breeze user edited is compared on visibility
 *   only, which no Breeze edit changes.
 * - A comment a Breeze merge moved onto this ticket is compared when the input
 *   has it, and never counted missing: it was not this source ticket's.
 * - With `isSourceArticleId`, only source articles are compared or counted
 *   missing: a note the module composed (an owner note, a time note) is
 *   module output, never a change in the source (W5 review 10). Without it,
 *   every comment is compared and none is counted missing.
 */
export function sourceChanges(
  stored: { orgId: string; requesterContactId: string | null; submitterEmail: string | null },
  storedComments: readonly StoredImportedComment[],
  t: ImportedTicket,
  isSourceArticleId?: (sourceId: string) => boolean,
): SourceChanges {
  const requesterChanged = 'contactId' in t.requester
    ? stored.requesterContactId !== t.requester.contactId
    : normalizeRequesterEmail(stored.submitterEmail) !== normalizeRequesterEmail(t.requester.email);

  const bySourceId = new Map(storedComments.filter((c) => !c.deleted).map((c) => [c.sourceId, c]));
  const commentsChangedInSource: CommentChangedInSource[] = [];
  for (const comment of t.comments) {
    // A note the module composed (an owner note naming a renamed user, a
    // time note) is module output, not the source's: never "changed".
    if (isSourceArticleId && !isSourceArticleId(comment.sourceId)) continue;
    const row = bySourceId.get(comment.sourceId);
    if (!row) continue;
    // Both sides without a trailing skip note (the SQL strips the stored side).
    const contentChanged = !row.edited && row.contentHash !== contentHash(stripAttachmentSkipNote(storedCommentContent(comment)));
    const visibility = row.isPublic === comment.isPublic ? null : comment.isPublic ? 'made_public' : 'made_internal';
    if (contentChanged || visibility) commentsChangedInSource.push({ sourceId: comment.sourceId, contentChanged, visibility });
  }

  const inInput = new Set(t.comments.map((c) => c.sourceId));
  const commentsMissingInSource = isSourceArticleId
    ? storedComments
      .filter((c) => !c.deleted && !c.mergedIn && !inInput.has(c.sourceId) && isSourceArticleId(c.sourceId))
      .map((c) => c.sourceId)
    : [];

  return { requesterChanged, orgChanged: t.orgId !== stored.orgId, commentsChangedInSource, commentsMissingInSource };
}
