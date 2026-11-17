import { describe, expect, it } from 'vitest';
import { MigrationWindowError } from '../migrationWindows';
import { TicketMergedError } from '../ticketMerge/errors';
import { TicketLinkError, type TicketLinkErrorCode } from '../ticketLinkService';
import { TicketServiceError } from '../ticketService';
import { linkRefusalAnswer } from './importLinks';

const refused = (code: TicketLinkErrorCode) => new TicketLinkError(code, code);

describe('linkRefusalAnswer (#8313 W2, spec 2026-10-19 §5.3 item 4)', () => {
  it('an existing identical link is done', () => {
    expect(linkRefusalAnswer(refused('ALREADY_LINKED'))).toEqual({ outcome: 'already' });
  });

  it('a source already a duplicate is checked against this target', () => {
    expect(linkRefusalAnswer(refused('SOURCE_ALREADY_DUPLICATE'))).toBe('check_duplicate');
  });

  it.each([
    ['CROSS_ORG', 'cross_org'],
    ['LINK_LIMIT', 'link_limit'],
    ['DUPLICATE_TARGET_IS_DUPLICATE', 'duplicate_target_is_duplicate'],
    ['SOURCE_HAS_DUPLICATES', 'source_has_duplicates'],
    ['LINK_CYCLE', 'link_cycle'],
    ['SELF_LINK', 'self_link'],
    ['NOT_FOUND', 'not_found'],
  ] as const)('%s is known impossible: not written, final', (code, reported) => {
    expect(linkRefusalAnswer(refused(code))).toEqual({ outcome: 'not_written', code: reported });
  });

  it('a ticket merged in Breeze under the lock is final', () => {
    expect(linkRefusalAnswer(new TicketMergedError('a', 'b'))).toEqual({ outcome: 'not_written', code: 'merged_in_breeze' });
  });

  it('the window org check and the historic time are final for this window', () => {
    expect(linkRefusalAnswer(new TicketServiceError('x', 403, 'MIGRATION_WINDOW_ORG_NOT_ALLOWED'))).toEqual({ outcome: 'not_written', code: 'org_outside_window' });
    expect(linkRefusalAnswer(new TicketServiceError('x', 400, 'IMPORT_TIME_INVALID'))).toEqual({ outcome: 'not_written', code: 'import_time_invalid' });
  });

  it('a closed window, a rate limit or any other error reaches the runner', () => {
    expect(linkRefusalAnswer(new MigrationWindowError('MIGRATION_WINDOW_NOT_OPEN', 'closed', 409, { reason: 'closed' }))).toBeNull();
    expect(linkRefusalAnswer(new MigrationWindowError('MIGRATION_WINDOW_RATE_LIMITED', 'busy', 429, { retryAfterSeconds: 5 }))).toBeNull();
    expect(linkRefusalAnswer(new TicketServiceError('x', 400, 'VALIDATION_ERROR' as never))).toBeNull();
    expect(linkRefusalAnswer(new Error('connection reset'))).toBeNull();
  });
});
