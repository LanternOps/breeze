import type { ImportedAttachment, ImportedComment, ImportedTicket } from '../../importedTicket';
import { htmlForImport, IMPORT_TEXT_MAX_CHARS, plainTextForImport, type ImportImageResolver } from '../../importText';
import type { Conversion, ConversionContext, ImportedLink, LoadedTicket, ReportNote } from '../../moduleContract';
import { zammadIds } from './ids';
import {
  articleAuthor,
  articleHeaderLines,
  articleTypeName,
  cleanText,
  createArticleTypeName,
  customAttributesWithValue,
  formatInstant,
  mapOwner,
  mapPriority,
  mapRequester,
  mapSource,
  mapState,
  mapTags,
  mapTicketType,
  senderName,
  timeUnitValue,
  ZAMMAD_SYSTEM_NAME,
} from './mapping';
import { zammadOptionsSchema, type ZammadOptions } from './options';
import type { ZammadArticle, ZammadAttachment, ZammadLoadedData } from './shapes';

/**
 * The pure conversion of one loaded Zammad 7.2.2 ticket (#8313 W5; spec
 * 2026-10-19 §5.2, §6.3–§6.6). No I/O, no clock: `now` and every Breeze
 * lookup arrive in the context, so it is tested against the recorded
 * responses alone (§6.8).
 *
 * - **Description**: the first article that is public and not from System
 *   (an internal note never becomes the portal's description). It is not
 *   imported again as a comment; its files ride on one public comment by the
 *   same author, "Attachments from the original message." (F8's shape).
 * - **Articles** become comments: internal stays internal, a Customer is the
 *   requester kind, an Agent staff; System articles are skipped and counted,
 *   or kept as internal notes by "Zammad (system)" (option); the merge
 *   marker of a merged ticket is skipped (Z9).
 * - **Bodies**: HTML through the import converter (links inline, quotes
 *   prefixed); an inline image (an API attachment URL or a `cid:`) becomes
 *   `[image: <name>]` and its original an attachment marked inline; an
 *   external image is dropped; an unmatched `cid:` is `[image]`. Plain text
 *   is normalized. Both are clamped with the visible marker and counted.
 * - **Composed notes** (internal, at the ticket's `updated_at`): the
 *   historic owner, the pending time, the merge, the accounted time. Never
 *   a time entry (F19).
 * - **Times**: an article older than its ticket (one moved in by a merge
 *   keeps its `created_at`, Z9) is raised to the ticket's creation, which
 *   Breeze requires, and counted.
 */

export const ZAMMAD_FILES_COMMENT = 'Attachments from the original message.';
export const ZAMMAD_RENDER_ERROR_MARKER = '[Zammad could not render this message; the original is in the source ticket.]';

const ATTACHMENT_PATH = /^\/api\/v1\/ticket_attachment\/\d+\/\d+\/(\d+)(?:[?#].*)?$/i;

function normalizeCid(raw: string): string {
  let cid = raw.trim();
  try {
    cid = decodeURIComponent(cid);
  } catch {
    // keep it as is
  }
  return cid.replace(/^<|>$/g, '').trim().toLowerCase();
}

function filenameOf(file: ZammadAttachment): string {
  return (cleanText(file.filename).trim() || `attachment-${file.id}`).slice(0, 1024);
}

function isAlternative(file: ZammadAttachment): boolean {
  const flag = file.preferences?.['content-alternative'];
  return flag === true || flag === 'true';
}

/**
 * The image resolver of one article (§6.5): records which of its files the
 * body shows inline.
 */
export function zammadImageResolver(article: ZammadArticle, baseUrl: string, inline: Set<number>): ImportImageResolver {
  const files = (article.attachments ?? []).filter((f) => !isAlternative(f));
  const byStore = new Map(files.map((f) => [f.id, f]));
  const byCid = new Map<string, ZammadAttachment>();
  for (const f of files) {
    const cid = f.preferences?.['Content-ID'];
    if (typeof cid === 'string' && cid.trim()) byCid.set(normalizeCid(cid), f);
  }
  const base = baseUrl.toLowerCase();
  const hit = (file: ZammadAttachment | undefined): string => {
    if (!file) return '[image]';
    inline.add(file.id);
    return `[image: ${filenameOf(file)}]`;
  };
  return (rawSrc) => {
    let src = rawSrc.trim();
    if (src.toLowerCase().startsWith(base)) src = src.slice(base.length);
    const path = ATTACHMENT_PATH.exec(src);
    if (path) return hit(byStore.get(Number(path[1])));
    if (/^cid:/i.test(src)) return hit(byCid.get(normalizeCid(src.slice(4))));
    // An external image, often a tracking pixel: dropped.
    if (/^(https?:)?\/\//i.test(src)) return null;
    // data:, blob: or a path the source did not rewrite: the reader still learns an image was there.
    return '[image]';
  };
}

type ArticleText = { content: string; truncated: boolean; files: ImportedAttachment[]; alternatives: number; renderError: boolean };

/** One article's text (header lines, marker, body) and its files. */
export function zammadArticleText(article: ZammadArticle, baseUrl: string): ArticleText {
  const head = articleHeaderLines(article);
  const renderError = article.body_rendering_error === true;
  if (renderError) head.push(ZAMMAD_RENDER_ERROR_MARKER);
  const prefix = head.join('\n');
  const budget = IMPORT_TEXT_MAX_CHARS - (prefix ? prefix.length + 2 : 0);
  const inline = new Set<number>();
  const raw = article.body ?? '';
  let body: string;
  let truncated: boolean;
  if ((article.content_type ?? 'text/plain').trim().toLowerCase().startsWith('text/html')) {
    const out = htmlForImport(raw, { maxOutputChars: budget, image: zammadImageResolver(article, baseUrl, inline) });
    body = out.text;
    truncated = out.truncatedInput || out.truncatedOutput;
  } else {
    const out = plainTextForImport(raw, { maxOutputChars: budget });
    body = out.text.trim();
    truncated = out.truncated;
  }
  const content = prefix ? (body ? `${prefix}\n\n${body}` : prefix) : body;

  const files: ImportedAttachment[] = [];
  let alternatives = 0;
  for (const file of article.attachments ?? []) {
    // The raw HTML copy of an HTML mail (Z7): the body already is that message.
    if (isAlternative(file)) {
      alternatives += 1;
      continue;
    }
    const size = Number.parseInt(String(file.size ?? ''), 10);
    files.push({
      sourceId: zammadIds.attachment(file.id),
      filename: filenameOf(file),
      ...(Number.isSafeInteger(size) && size >= 0 ? { declaredBytes: size } : {}),
      inline: inline.has(file.id),
    });
  }
  return { content, truncated, files, alternatives, renderError };
}

function isMergeMarker(article: ZammadArticle, data: ZammadLoadedData): boolean {
  if (data.state.type !== 'merged') return false;
  return senderName(article) === 'Agent' && article.internal !== true
    && articleTypeName(article) === 'note'
    && (article.body ?? '').replace(/<[^>]*>/g, '').trim() === 'merged';
}

function later(a: string, b: string | null | undefined): string {
  if (!b) return a;
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}

function instant(iso: string): Date {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) throw new Error('A Zammad time is not an ISO 8601 instant');
  return at;
}

export function convertZammadTicket(loaded: LoadedTicket, ctx: ConversionContext<ZammadOptions>): Conversion {
  const data = loaded.data as ZammadLoadedData;
  const options = zammadOptionsSchema.parse(ctx.options ?? {});
  const t = data.ticket;
  const key = zammadIds.ticket(t.id);
  const notes: ReportNote[] = [];

  // A later Zammad moves inline images out of `attachments` (Z6): refuse
  // loudly rather than import their bodies without them.
  if (data.articles.some((a) => (a.inline_attachments?.length ?? 0) > 0)) return { kind: 'skip', code: 'unsupported', notes };
  const state = mapState(data.state, t);
  if (!state) return { kind: 'skip', code: 'unsupported', notes };

  const createdAt = instant(t.created_at);
  // Breeze keeps no comment before its ticket: an article moved in by a merge is raised to the creation.
  let raised = 0;
  const notBeforeCreation = (iso: string): Date => {
    const at = instant(iso);
    if (at.getTime() >= createdAt.getTime()) return at;
    raised += 1;
    return createdAt;
  };
  const noteAt = instant(later(t.created_at, t.updated_at));
  const composed = (sourceId: string, content: string): ImportedComment => ({
    sourceId, createdAt: noteAt, isPublic: false, author: { kind: 'staff', name: ZAMMAD_SYSTEM_NAME }, content: cleanText(content),
  });

  const description = data.articles.find((a) => a.internal !== true && senderName(a) !== 'System' && !isMergeMarker(a, data)) ?? null;
  let descriptionText = '';
  let truncated = 0;
  let systemSkipped = 0;
  let alternatives = 0;
  let renderErrors = 0;
  const comments: ImportedComment[] = [];

  for (const article of data.articles) {
    if (isMergeMarker(article, data)) continue;
    const system = senderName(article) === 'System';
    if (system && options.systemArticles === 'skip') {
      systemSkipped += 1;
      continue;
    }
    const text = zammadArticleText(article, data.baseUrl);
    if (text.truncated) truncated += 1;
    if (text.renderError) renderErrors += 1;
    alternatives += text.alternatives;
    const author = articleAuthor(article, data.people);
    if (article === description) {
      descriptionText = text.content;
      if (text.files.length > 0) {
        comments.push({
          sourceId: zammadIds.articleFiles(article.id),
          createdAt: notBeforeCreation(article.created_at),
          isPublic: true,
          author,
          content: ZAMMAD_FILES_COMMENT,
          attachments: text.files,
        });
      }
      continue;
    }
    comments.push({
      sourceId: zammadIds.article(article.id),
      createdAt: notBeforeCreation(article.created_at),
      isPublic: !system && article.internal !== true,
      author,
      content: text.content,
      ...(text.files.length > 0 ? { attachments: text.files } : {}),
    });
  }

  const owner = mapOwner(t, data.people, ctx);
  if (owner.unmatched) {
    const who = owner.unmatched;
    comments.push(composed(zammadIds.ownerNote(t.id, who.userId), `Owner in Zammad: ${who.name}${who.email ? ` <${who.email}>` : ''}`));
    notes.push({ kind: 'owner_unmatched', sourceUserKey: String(who.userId) });
  }
  if (state.pendingNote) {
    const { kind, pendingTime } = state.pendingNote;
    const when = pendingTime ? formatInstant(pendingTime) : null;
    const content = kind === 'reminder'
      ? (when ? `Pending reminder in Zammad: ${when}` : 'Pending reminder in Zammad, with no reminder time set.')
      : (when ? `Zammad would have closed this at ${when}` : 'Zammad would have closed this, with no close time set.');
    comments.push(composed(zammadIds.pendingNote(t.id, data.state.id, pendingTime), content));
  }
  const links: ImportedLink[] = [];
  if (state.merged) {
    const survivorId = data.merge?.survivorId ?? null;
    const survivorNumber = data.merge?.survivorNumber ?? null;
    const content = survivorId === null
      ? 'Merged in Zammad into a ticket the import cannot see.'
      : survivorNumber ? `Merged into Zammad #${cleanText(survivorNumber)}.` : `Merged into Zammad ticket ${survivorId}.`;
    comments.push(composed(zammadIds.mergeNote(t.id, survivorId), content));
    if (survivorId !== null) {
      links.push({
        sourceKey: key,
        targetKey: zammadIds.ticket(survivorId),
        linkType: 'duplicate_of',
        at: instant(later(t.updated_at, data.merge?.survivorCreatedAt)),
      });
    }
  }
  const timeUnit = timeUnitValue(t.time_unit);
  if (options.timeAccountingNote && timeUnit) {
    comments.push(composed(zammadIds.timeNote(t.id, timeUnit), `Time accounted in Zammad: ${timeUnit} ${options.timeUnitLabel}`));
  }

  const { requester, withoutContact } = mapRequester(t, data.people, ctx);
  if (withoutContact) notes.push({ kind: 'requester_without_contact' });
  const tags = mapTags(data.tags);
  if (truncated > 0) notes.push({ kind: 'content_truncated', count: truncated });
  if (systemSkipped > 0) notes.push({ kind: 'comments_system_skipped', count: systemSkipped });
  if (alternatives > 0) notes.push({ kind: 'attachments_alternative_ignored', count: alternatives });
  for (const name of customAttributesWithValue(t)) notes.push({ kind: 'custom_attribute', name });
  if (state.removed) notes.push({ kind: 'module_count', name: 'state_removed' });
  if (tags.cut > 0) notes.push({ kind: 'module_count', name: 'tags_cut', count: tags.cut });
  if (renderErrors > 0) notes.push({ kind: 'module_count', name: 'body_rendering_error', count: renderErrors });
  if (raised > 0) notes.push({ kind: 'module_count', name: 'article_time_raised', count: raised });

  const subject = cleanText(t.title).trim().slice(0, 5000) || '(no subject)';
  const sourceNumber = cleanText(String(t.number)).trim().slice(0, 255);
  const sourceUrl = `${data.baseUrl}/#ticket/zoom/${t.id}`;
  const ticketType = mapTicketType(t.type);
  const ticket: ImportedTicket = {
    sourceId: key,
    ...(sourceNumber ? { sourceNumber } : {}),
    ...(sourceUrl.length <= 2048 ? { sourceUrl } : {}),
    orgId: ctx.orgId,
    createdAt,
    updatedAt: instant(later(t.created_at, t.updated_at)),
    subject,
    description: descriptionText,
    priority: mapPriority(t.priority_id, data.priorityName, options),
    categoryId: ctx.categoryIdBySourceGroup.get(String(t.group_id)) ?? null,
    tags: tags.tags,
    ...(ticketType ? { ticketType } : {}),
    source: mapSource(createArticleTypeName(t, data.articles)),
    requester,
    assigneeUserId: owner.assigneeUserId,
    finalStatus: state.finalStatus,
    ...(state.resolvedAt ? { resolvedAt: instant(later(t.created_at, state.resolvedAt)) } : {}),
    ...(state.closedAt ? { closedAt: instant(later(t.created_at, state.closedAt)) } : {}),
    comments,
  };
  return { kind: 'ticket', ticket, links, notes };
}
