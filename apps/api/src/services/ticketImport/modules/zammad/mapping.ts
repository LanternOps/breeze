import { z } from 'zod';
import type { TicketType } from '@breeze/shared';
import type { ImportedTicket } from '../../importedTicket';
import { stripRefusedControlChars } from '../../importText';
import { normalizeRequesterEmail } from '../../../ticketRequesterEmail';
import type { ConversionContext } from '../../moduleContract';
import type { ZammadOptions } from './options';
import { ZAMMAD_ARTICLE_TYPE_BY_ID, ZAMMAD_SENDER_BY_ID, type ZammadArticle, type ZammadPerson, type ZammadStateInfo, type ZammadTicket } from './shapes';

/**
 * The Zammad mapping tables (#8313 W5; spec 2026-10-19 §6.3, §6.4, §9
 * decisions 6–10, 16). Pure: every Breeze lookup arrives resolved in the
 * ConversionContext.
 */

type FinalStatus = ImportedTicket['finalStatus'];
type Priority = ImportedTicket['priority'];

/** The system user: the unassigned owner (Z15) and the author of trigger notes. */
export const ZAMMAD_SYSTEM_USER_ID = 1;
export const ZAMMAD_SYSTEM_NAME = 'Zammad (system)';

const emailSchema = z.string().email().max(255);

/** Text with the control characters importedTicket refuses (F2) removed: importText's one rule. */
export function cleanText(value: string | null | undefined): string {
  return stripRefusedControlChars(value ?? '');
}

/**
 * An address the writer accepts, normalized as Breeze compares requester
 * emails (`normalizeRequesterEmail`: trimmed, lower-cased); null for an empty
 * or malformed one (Z15: email may be empty).
 */
export function usableEmail(raw: string | null | undefined): string | null {
  const email = normalizeRequesterEmail(raw);
  return email && emailSchema.safeParse(email).success ? email : null;
}

/** A record's own entry only: never `constructor`, `__proto__` or anything inherited. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A person's display name: `firstname lastname`, else the login, else the email, else a placeholder. */
export function personName(person: ZammadPerson | null | undefined, userId: number): string {
  if (userId === ZAMMAD_SYSTEM_USER_ID) return ZAMMAD_SYSTEM_NAME;
  const full = cleanText([person?.firstname, person?.lastname].filter((p) => p && p.trim() && p.trim() !== '-').join(' ')).trim();
  const name = full || cleanText(person?.login).trim() || cleanText(person?.email).trim() || `Zammad user ${userId}`;
  return name.slice(0, 255);
}

// ---------------------------------------------------------------- states

export type StateMapping = {
  finalStatus: FinalStatus;
  resolvedAt?: string;
  closedAt?: string;
  /**
   * The internal note of a pending state: Breeze has no pending-until time
   * and no auto-close (F18). `reminder`: a pending reminder; `auto_close`: a
   * pending action that closes when its time comes (`pending close`);
   * `until`: a pending action whose next state is not a closed one (a pause).
   */
  pendingNote?: { kind: 'reminder' | 'auto_close' | 'until'; pendingTime: string | null };
  merged?: true;
  /** A legacy `removed` state (Z12), counted in the report. */
  removed?: true;
};

/** The times a status carries: a resolve at the last change, a close at the latest close (Z12). */
function timesFor(status: FinalStatus, ticket: ZammadTicket): Pick<StateMapping, 'resolvedAt' | 'closedAt'> {
  if (status === 'resolved') return { resolvedAt: ticket.updated_at };
  // close_at is the first close and never reset; last_close_at the latest.
  if (status === 'closed') return { closedAt: ticket.last_close_at ?? ticket.close_at ?? ticket.updated_at };
  return {};
}

function byStateType(state: ZammadStateInfo, ticket: ZammadTicket): StateMapping | null {
  const pendingTime = ticket.pending_time ?? null;
  switch (state.type) {
    case 'new':
      // An assigned import opens, as live does (the writer's rule).
      return { finalStatus: 'new' };
    case 'open':
      return { finalStatus: 'open' };
    case 'pending reminder':
      return { finalStatus: 'pending', pendingNote: { kind: 'reminder', pendingTime } };
    case 'pending action':
      // `pending close` goes to a closed state: done, closing unless the
      // customer replies, which is Breeze's resolved (decision 10). A state
      // list that does not say (`undefined`) is read the seeded way.
      if (state.nextStateType === 'closed' || state.nextStateType === undefined) {
        return { finalStatus: 'resolved', ...timesFor('resolved', ticket), pendingNote: { kind: 'auto_close', pendingTime } };
      }
      // A pending action that closes nothing (a custom "paused" state, seen
      // on a live 7.2.0): on hold until someone acts.
      return { finalStatus: 'on_hold', pendingNote: { kind: 'until', pendingTime } };
    case 'closed':
      return { finalStatus: 'closed', ...timesFor('closed', ticket) };
    case 'merged':
      return { finalStatus: 'closed', closedAt: ticket.updated_at, merged: true };
    case 'removed':
      return { finalStatus: 'closed', closedAt: ticket.updated_at, removed: true };
    default:
      return null;
  }
}

/**
 * By state TYPE, never by name: custom states follow their type (Z12). The
 * options' per-state map overrides one state's status (its times follow the
 * new status, its pending note stays) and can map a type 7.2 does not have.
 * A merged ticket stays closed with its merge note whatever the map says.
 * Null for a type 7.2 does not have and no override.
 */
export function mapState(
  state: ZammadStateInfo,
  ticket: ZammadTicket,
  stateMap: ZammadOptions['stateMap'] = {},
): StateMapping | null {
  const base = byStateType(state, ticket);
  const override = own(stateMap, String(state.id))?.status;
  if (!override || base?.merged) return base;
  return {
    finalStatus: override,
    ...timesFor(override, ticket),
    ...(base?.pendingNote ? { pendingNote: base.pendingNote } : {}),
    ...(base?.removed ? { removed: true as const } : {}),
  };
}

// ------------------------------------------------------------ priorities

const SEEDED_PRIORITIES: ReadonlyMap<string, Priority> = new Map([['1 low', 'low'], ['2 normal', 'normal'], ['3 high', 'high']]);

/** The wizard's map by priority id; else the seeded name; else normal (Z13). */
export function mapPriority(priorityId: number, priorityName: string | null, options: Pick<ZammadOptions, 'priorityMap'>): Priority {
  return own(options.priorityMap, String(priorityId))
    ?? SEEDED_PRIORITIES.get((priorityName ?? '').trim().toLowerCase())
    ?? 'normal';
}

// --------------------------------------------------------- header fields

export function articleTypeName(article: Pick<ZammadArticle, 'type' | 'type_id'>): string {
  const named = article.type?.trim().toLowerCase();
  if (named) return named;
  return (article.type_id ? ZAMMAD_ARTICLE_TYPE_BY_ID.get(article.type_id) : undefined) ?? 'note';
}

export function senderName(article: Pick<ZammadArticle, 'sender' | 'sender_id'>): 'Agent' | 'Customer' | 'System' {
  const named = article.sender?.trim().toLowerCase();
  if (named === 'agent' || named === 'customer' || named === 'system') {
    return (named[0]!.toUpperCase() + named.slice(1)) as 'Agent' | 'Customer' | 'System';
  }
  return (article.sender_id ? ZAMMAD_SENDER_BY_ID.get(article.sender_id) : undefined) ?? 'Customer';
}

/** `create_article_type` (Z19): email -> email, web -> portal, everything else -> manual. No new ticket_source (step-1 F15). */
export function mapSource(createTypeName: string | null): ImportedTicket['source'] {
  if (createTypeName === 'email') return 'email';
  if (createTypeName === 'web') return 'portal';
  return 'manual';
}

/** The ticket's creating article type: named by an article of that type, else the seeded table. */
export function createArticleTypeName(ticket: ZammadTicket, articles: readonly ZammadArticle[]): string | null {
  const typeId = ticket.create_article_type_id;
  if (!typeId) return null;
  const article = articles.find((a) => a.type_id === typeId && a.type);
  return article ? articleTypeName(article) : ZAMMAD_ARTICLE_TYPE_BY_ID.get(typeId) ?? null;
}

const TICKET_TYPES: ReadonlyMap<string, TicketType> = new Map([['incident', 'incident'], ['problem', 'problem'], ['request for change', 'change']]);

/** The seeded `type` attribute (Z17); anything else is omitted, so the live default applies. */
export function mapTicketType(type: string | null | undefined): TicketType | undefined {
  return TICKET_TYPES.get((type ?? '').trim().toLowerCase());
}

/**
 * Trimmed to 100 characters and capped at 50 (F2). `cut` counts each source
 * tag that lost something, once: dropped past the cap, or shortened. A tag
 * that becomes one already kept (a repeat, or a shortened tag that collapses
 * into another) lost nothing and is not counted.
 */
export function mapTags(tags: readonly string[]): { tags: string[]; cut: number } {
  const out: string[] = [];
  const seen = new Set<string>();
  let cut = 0;
  for (const raw of tags) {
    const cleaned = cleanText(raw).trim();
    if (!cleaned) continue;
    let tag = cleaned.slice(0, 100);
    // Never end on half of a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(tag)) tag = tag.slice(0, -1);
    tag = tag.trim();
    if (seen.has(tag)) continue;
    if (out.length >= 50) {
      cut += 1;
      continue;
    }
    seen.add(tag);
    out.push(tag);
    if (tag.length < cleaned.length) cut += 1;
  }
  return { tags: out, cut };
}

/**
 * The ticket's plain columns in 7.2.2 (the base migration, `checklist_id`,
 * `ai_agent_running`) and the keys `expand=true` adds. Any other top-level
 * key is an Object Manager attribute (Z17): not imported in v1, counted by
 * name when it has a value (§6.5). `type` is mapped, not counted.
 */
const KNOWN_TICKET_KEYS: ReadonlySet<string> = new Set([
  'id', 'group_id', 'priority_id', 'state_id', 'organization_id', 'number', 'title', 'owner_id', 'customer_id', 'note',
  'first_response_at', 'first_response_escalation_at', 'first_response_in_min', 'first_response_diff_in_min',
  'close_at', 'close_escalation_at', 'close_in_min', 'close_diff_in_min', 'update_escalation_at', 'update_in_min',
  'update_diff_in_min', 'last_close_at', 'last_contact_at', 'last_contact_agent_at', 'last_contact_customer_at',
  'last_owner_update_at', 'create_article_type_id', 'create_article_sender_id', 'article_count', 'escalation_at',
  'pending_time', 'type', 'time_unit', 'preferences', 'ai_agent_running', 'checklist_id', 'updated_by_id',
  'created_by_id', 'created_at', 'updated_at',
  'article_ids', 'ticket_time_accounting_ids', 'ticket_time_accounting', 'referencing_checklist_ids',
  'referencing_checklists', 'ai_stored_result_ids', 'ai_stored_results', 'group', 'organization', 'state', 'priority',
  'owner', 'customer', 'created_by', 'updated_by', 'create_article_type', 'create_article_sender',
]);

/** An Object Manager attribute of tickets that is not one of 7.2.2's own columns. */
export function isCustomTicketAttribute(name: string): boolean {
  return !KNOWN_TICKET_KEYS.has(name);
}

export function customAttributesWithValue(ticket: ZammadTicket): string[] {
  return Object.entries(ticket)
    .filter(([key, value]) => isCustomTicketAttribute(key)
      && value !== null && value !== undefined && value !== ''
      && !(Array.isArray(value) && value.length === 0))
    .map(([key]) => key)
    .sort();
}

// -------------------------------------------------------------- people

export type OwnerMapping =
  | { assigneeUserId: string | null; unmatched: null }
  | { assigneeUserId: null; unmatched: { userId: number; name: string; email: string | null } };

/**
 * `owner_id = 1` is unassigned (Z15). Otherwise the owner's email matched to
 * a user import eligibility accepts (partner, org null or the ticket's,
 * deactivated included: closed tickets keep inactive owners). No match:
 * unassigned, with the owner note, and no user is ever created (decision 24).
 */
export function mapOwner(ticket: ZammadTicket, people: Readonly<Record<string, ZammadPerson | null>>, ctx: Pick<ConversionContext, 'userIdByEmail'>): OwnerMapping {
  const ownerId = ticket.owner_id ?? ZAMMAD_SYSTEM_USER_ID;
  if (ownerId === ZAMMAD_SYSTEM_USER_ID) return { assigneeUserId: null, unmatched: null };
  const person = own(people, String(ownerId)) ?? null;
  const email = usableEmail(person?.email);
  const userId = email ? ctx.userIdByEmail.get(email) : undefined;
  if (userId) return { assigneeUserId: userId, unmatched: null };
  return { assigneeUserId: null, unmatched: { userId: ownerId, name: personName(person, ownerId), email } };
}

/**
 * The requester (`customer_id`): a contact when exactly one in the target org
 * has the email (F15), else display-only with the email when it has one.
 */
export function mapRequester(
  ticket: ZammadTicket,
  people: Readonly<Record<string, ZammadPerson | null>>,
  ctx: Pick<ConversionContext, 'contactIdByEmail'>,
): { requester: ImportedTicket['requester']; withoutContact: boolean } {
  const person = own(people, String(ticket.customer_id)) ?? null;
  const email = usableEmail(person?.email);
  const contactId = email ? ctx.contactIdByEmail.get(email) : undefined;
  if (contactId) return { requester: { contactId }, withoutContact: false };
  return { requester: { name: personName(person, ticket.customer_id), ...(email ? { email } : {}) }, withoutContact: true };
}

/** The author of an article: `origin_by`, else `created_by` (Z14); System articles are "Zammad (system)". */
export function articleAuthor(
  article: ZammadArticle,
  people: Readonly<Record<string, ZammadPerson | null>>,
): { kind: 'staff' | 'requester'; name: string; email?: string } {
  const sender = senderName(article);
  if (sender === 'System') return { kind: 'staff', name: ZAMMAD_SYSTEM_NAME };
  const userId = article.origin_by_id ?? article.created_by_id ?? ZAMMAD_SYSTEM_USER_ID;
  const person = own(people, String(userId)) ?? null;
  const email = userId === ZAMMAD_SYSTEM_USER_ID ? null : usableEmail(person?.email);
  return { kind: sender === 'Agent' ? 'staff' : 'requester', name: personName(person, userId), ...(email ? { email } : {}) };
}

/**
 * The header lines an article type adds (§6.3): `To:` and `Cc:` for email
 * when not empty (Breeze has no CC list; this keeps who was copied),
 * `[<type>]` for the other channels, none for `note` and `web`.
 */
export function articleHeaderLines(article: ZammadArticle): string[] {
  const type = articleTypeName(article);
  if (type === 'note' || type === 'web') return [];
  if (type === 'email') {
    const lines: string[] = [];
    const to = cleanText(article.to).trim();
    const cc = cleanText(article.cc).trim();
    if (to) lines.push(`To: ${to}`);
    if (cc) lines.push(`Cc: ${cc}`);
    return lines;
  }
  return [`[${cleanText(type)}]`];
}

/** `2026-11-20 09:00 UTC` for a note; the raw value when it is not a time. */
export function formatInstant(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return cleanText(iso);
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** `time_unit` as a number string ("45.0" -> "45"); null when absent, zero or not a number (Z16). */
export function timeUnitValue(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(n);
}
