import { and, eq } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { ticketExternalRefs, ticketLinks, tickets } from '../../db/schema';
import { TicketMergedError } from '../ticketMerge/errors';
import { addTicketLink, TicketLinkError, type TicketLinkErrorCode } from '../ticketLinkService';
import { TicketServiceError } from '../ticketService';
import type { ImportLinkWriter } from './importRunner';
import { inImportTransaction } from './importWriter';
import type { ImportedLink } from './moduleContract';
import { readWindowDescriptor, windowWriteContext, type WindowDescriptor } from './windowLock';

/**
 * Links in import mode (#8313 W2; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.3 item 4, §6.6). The runner's links phase calls `importTicketLink` once
 * per link a conversion asked for (today: a merged ticket `duplicate_of` its
 * survivor), after both tickets had their chance to be imported.
 *
 * Both tickets are resolved through this principal's refs in the window's own
 * context, so RLS bounds what can be linked as it bounds every import write.
 * The write charges 1 unit and runs `addTicketLink` in import mode inside the
 * import transaction, which holds the window open: no event, no audit, both
 * feed rows and the link stamped with `at` and the window id.
 *
 * The answer says whether the link is done, and whether a link that was not
 * written is worth another try (`retry`). The runner records the merged
 * ticket's version only when every link of it is done or known impossible, so
 * a retryable one reloads the ticket on the next pass (§6.6). A window that
 * closed, or a throughput limit, is thrown, as `importTicket` throws it: the
 * runner stops or defers the run, and the link stays queued.
 */

export type ImportLinkResult = Awaited<ReturnType<ImportLinkWriter['writeLink']>>;

/** Each refusal of `addTicketLink` that no later pass can change (§5.3 item 4). */
const KNOWN_IMPOSSIBLE: ReadonlySet<TicketLinkErrorCode> = new Set<TicketLinkErrorCode>([
  'CROSS_ORG',
  'LINK_LIMIT',
  'DUPLICATE_TARGET_IS_DUPLICATE',
  'SOURCE_HAS_DUPLICATES',
  'LINK_CYCLE',
  'SELF_LINK',
  'NOT_FOUND',
]);

const notWritten = (code: string, retry = false): ImportLinkResult => ({ outcome: 'not_written', code, ...(retry ? { retry } : {}) });

type Side = { ticketId: string; orgId: string };

/**
 * One ticket of the link, by this principal's ref.
 *
 * The ref is read in system scope, by principal and key, as the runner reads
 * refs (conversionLookups.ts `keysWithRef`): under the window's narrowed RLS
 * a ticket in an org the window does not cover would look not imported, and
 * its merged ticket would be reloaded on every pass. Its org decides that
 * case, final for this window. The ticket itself is then read in the window's
 * context, so nothing about it rests on system scope.
 *
 * A ref the merge of #10120 moved onto a survivor names a ticket merged in
 * Breeze: never linked, as a tombstone is never written.
 */
async function resolveSide(window: WindowDescriptor, key: string): Promise<Side | ImportLinkResult> {
  const [ref] = await withSystemDbAccessContext(() => db
    .select({ ticketId: ticketExternalRefs.ticketId, orgId: ticketExternalRefs.orgId, originTicketId: ticketExternalRefs.originTicketId })
    .from(ticketExternalRefs)
    .where(and(eq(ticketExternalRefs.partnerServicePrincipalId, window.principalId), eq(ticketExternalRefs.externalId, key)))
    .limit(1), 'ticketImport.linkRefs');
  // Not imported (yet): skipped, failed, or not reached. Worth another pass.
  if (!ref) return notWritten('not_imported', true);
  if (!window.orgIds.includes(ref.orgId)) return notWritten('org_outside_window');
  if (ref.originTicketId) return notWritten('merged_in_breeze');
  const [ticket] = await withDbAccessContext(windowWriteContext(window), () => db
    .select({ id: tickets.id, orgId: tickets.orgId, deletedAt: tickets.deletedAt, mergedIntoTicketId: tickets.mergedIntoTicketId })
    .from(tickets)
    .where(eq(tickets.id, ref.ticketId))
    .limit(1));
  // Moved to an org outside the window since the ref was written.
  if (!ticket) return notWritten('org_outside_window');
  if (ticket.mergedIntoTicketId) return notWritten('merged_in_breeze');
  if (ticket.deletedAt) return notWritten('deleted');
  return { ticketId: ticket.id, orgId: ticket.orgId };
}

const isSide = (value: Side | ImportLinkResult): value is Side => 'ticketId' in value;

/**
 * `SOURCE_ALREADY_DUPLICATE`: done when the source's one `duplicate_of`
 * already points at this target (a pass that wrote it and lost its answer),
 * else `duplicate_elsewhere`, as for a chain formed between passes (§6.6).
 */
async function duplicateAnswer(context: ReturnType<typeof windowWriteContext>, source: Side, target: Side): Promise<ImportLinkResult> {
  const rows = await withDbAccessContext(context, () => db
    .select({ targetTicketId: ticketLinks.targetTicketId })
    .from(ticketLinks)
    .where(and(eq(ticketLinks.sourceTicketId, source.ticketId), eq(ticketLinks.linkType, 'duplicate_of')))
    .limit(1));
  return rows[0]?.targetTicketId === target.ticketId ? { outcome: 'already' } : notWritten('duplicate_elsewhere');
}

export async function importTicketLink(
  windowId: string,
  link: Omit<ImportedLink, 'at'> & { at: Date },
  options: { partnerId: string },
): Promise<ImportLinkResult> {
  if (getCurrentDbAccessContext()) {
    throw new Error('importTicketLink opens its own transactions; call it outside any DB context');
  }
  const descriptor = await readWindowDescriptor(windowId, options.partnerId);
  const context = windowWriteContext(descriptor);

  const source = await resolveSide(descriptor, link.sourceKey);
  const target = await resolveSide(descriptor, link.targetKey);
  if (!isSide(source)) return source;
  if (!isSide(target)) return target;
  // A cross-org survivor keeps only the conversion's note (§6.6).
  if (source.orgId !== target.orgId) return notWritten('cross_org');

  try {
    await inImportTransaction(descriptor, context, source.orgId, 1, (scope) => addTicketLink(
      {
        source: { id: source.ticketId, orgId: source.orgId },
        target: { id: target.ticketId, orgId: target.orgId },
        linkType: link.linkType,
      },
      scope.actor,
      scope.at(link.at),
    ));
    return { outcome: 'written' };
  } catch (error) {
    const answer = linkRefusalAnswer(error);
    if (answer === 'check_duplicate') return duplicateAnswer(context, source, target);
    if (answer) return answer;
    // A closed window or a throughput limit (MigrationWindowError), or
    // Breeze's own failure: the runner stops, defers or retries the slice.
    throw error;
  }
}

/**
 * What a refused write means for the link (§5.3 item 4), or null when the
 * error is not a refusal of this link and must reach the runner.
 * `check_duplicate`: the source is already a duplicate; whether of this
 * target decides between done and `duplicate_elsewhere`.
 */
export function linkRefusalAnswer(error: unknown): ImportLinkResult | 'check_duplicate' | null {
  if (error instanceof TicketLinkError) {
    if (error.code === 'ALREADY_LINKED') return { outcome: 'already' };
    if (error.code === 'SOURCE_ALREADY_DUPLICATE') return 'check_duplicate';
    if (KNOWN_IMPOSSIBLE.has(error.code)) return notWritten(error.code.toLowerCase());
    return null;
  }
  // Merged in Breeze between the read and the lock (#8972).
  if (error instanceof TicketMergedError) return notWritten('merged_in_breeze');
  // The window's org list or the historic time refused the write: no later
  // pass of this window changes either.
  if (error instanceof TicketServiceError && error.code === 'MIGRATION_WINDOW_ORG_NOT_ALLOWED') return notWritten('org_outside_window');
  if (error instanceof TicketServiceError && error.code === 'IMPORT_TIME_INVALID') return notWritten('import_time_invalid');
  return null;
}

/** The runner's link writer (importRunner.ts `ImportLinkWriter`), as the worker wires it. */
export const importLinkWriter: ImportLinkWriter = { writeLink: importTicketLink };
