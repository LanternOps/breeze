import { describe, expect, it } from 'vitest';
import { releaseArgumentsForStoredIntent } from './intentReleaseLegacyArgs';
import { validateToolInput } from '../services/aiToolSchemas';

const TICKET_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '66666666-6666-4666-8666-666666666666';

const timeEntryArgs = {
  action: 'log_time_entry',
  ticketId: TICKET_ID,
  startedAt: '2026-11-01T10:00:00.000Z',
  endedAt: '2026-11-01T10:15:00.000Z',
  isBillable: true,
  description: 'Replied to the customer with AI assistance',
};

/** A stored AI time-entry proposal minted before #11861 removed the two keys. */
const legacyIntent = (args: Record<string, unknown>) => ({
  actionName: 'manage_tickets',
  source: 'ai_agent',
  idempotencyKey: 'ai-time-entry:44444444-4444-4444-8444-444444444444:draft_sent',
  arguments: args,
});

describe('releaseArgumentsForStoredIntent (#11861 legacy AI time-entry keys)', () => {
  it('strips exactly durationMinutes and proposedForUserId from a pre-change AI time-entry proposal', () => {
    const stored = { ...timeEntryArgs, durationMinutes: 15, proposedForUserId: USER_ID };
    const released = releaseArgumentsForStoredIntent(legacyIntent(stored));
    expect(released).toEqual(timeEntryArgs);
    expect(validateToolInput('manage_tickets', released)).toEqual({ success: true });
    // The stored row is never mutated.
    expect(stored).toHaveProperty('durationMinutes', 15);
  });

  it('leaves any other unknown key in place, so release still refuses it clearly', () => {
    const released = releaseArgumentsForStoredIntent(
      legacyIntent({ ...timeEntryArgs, durationMinutes: 15, proposedForUserId: USER_ID, bogusKey: 1 }),
    );
    expect(released).toEqual({ ...timeEntryArgs, bogusKey: 1 });
    const v = validateToolInput('manage_tickets', released);
    expect(v.success).toBe(false);
    expect(v.success === false && v.error).toMatch(/^Invalid input: unknown argument "bogusKey"/);
  });

  it.each([
    ['another tool', { actionName: 'manage_alerts' }],
    ['another manage_tickets action', { arguments: { ...timeEntryArgs, action: 'comment', durationMinutes: 15 } }],
    ['a non-agent source', { source: 'mcp_api' }],
    ['an intent not minted by the AI time-entry lane', { idempotencyKey: 'mcp:abc' }],
  ])('does not touch %s', (_label, override) => {
    const intent = { ...legacyIntent({ ...timeEntryArgs, durationMinutes: 15, proposedForUserId: USER_ID }), ...override };
    expect(releaseArgumentsForStoredIntent(intent)).toBe(intent.arguments);
  });

  it('returns the stored arguments object unchanged when no legacy key is present', () => {
    const intent = legacyIntent({ ...timeEntryArgs });
    expect(releaseArgumentsForStoredIntent(intent)).toBe(intent.arguments);
  });

  it('a live manage_tickets call carrying durationMinutes is still refused', () => {
    const v = validateToolInput('manage_tickets', { ...timeEntryArgs, durationMinutes: 15 });
    expect(v.success).toBe(false);
    expect(v.success === false && v.error).toMatch(/unknown argument "durationMinutes"/);
  });
});
