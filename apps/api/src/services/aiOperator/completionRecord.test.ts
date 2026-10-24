/**
 * The completion record (spec §6.6, §5.5): BOUNDED TEXT, never jsonb, assembled
 * from rows. The model contributes only the narrative, last and truncated
 * first; the Unresolved section — the one a technician must act on — is never
 * the part that gets cut. Posted once, as an internal ticket comment.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lockMock = vi.hoisted(() => ({
  row: { id: 'ticket-1', orgId: 'o', mergedIntoTicketId: null } as { id: string; orgId: string; mergedIntoTicketId: string | null } | null,
}));
vi.mock('../ticketRowLock', () => ({ lockTicketForWrite: async () => lockMock.row }));
vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { TicketMergedError } from '../ticketMerge/errors';
import {
  COMPLETION_RECORD_MAX_CHARS,
  CompletionRecordNoTicketError,
  postCompletionRecord,
  renderCompletionRecord,
  type CompletionRecordData,
} from './completionRecord';

function data(over: Partial<CompletionRecordData> = {}): CompletionRecordData {
  return {
    recipeKey: 'identity_offboarding',
    targets: [{ kind: 'contact', label: 'Dana Ruiz', detached: false }, { kind: 'ticket', label: 'Offboard Dana', detached: false }],
    accounts: [{ provider: 'google', principalLabel: 'dana@customer.example' }, { provider: 'm365', principalLabel: 'dana@customer.example' }],
    approverName: 'Sam Approver',
    effects: [
      { ordinal: 0, provider: 'google', toolName: 'google_set_vacation', rendering: 'Set auto-reply', outcome: 'succeeded', verification: 'verified' },
      { ordinal: 1, provider: 'google', toolName: 'google_remove_from_group', rendering: 'Remove from All Staff', outcome: 'noop', verification: 'verified' },
      { ordinal: 2, provider: 'google', toolName: 'google_signout', rendering: 'Sign out', outcome: 'succeeded', verification: 'unobservable', subsumedBy: 'google_suspend_user' },
      { ordinal: 3, provider: 'google', toolName: 'google_suspend_user', rendering: 'Suspend', outcome: 'succeeded', verification: 'verified' },
      { ordinal: 4, provider: 'm365', toolName: 'm365_disable_user', rendering: 'Disable', outcome: 'failed', verification: 'not_verified' },
    ],
    humanWork: [
      { label: 'Confirm identity', done: true, completedBy: 'Tina Tech', completedAt: '2026-10-23T12:00:00.000Z' },
      { label: 'Collect Dana Ruiz\'s company hardware', done: false, completedBy: null, completedAt: null },
    ],
    verification: { result: 'failed', detail: 'still a member of Finance' },
    discoveryFlags: [{ code: 'm365_groups_read_failed', subject: 'dana@customer.example', detail: 'read failed' }],
    costCents: 42,
    narrative: 'Dana was offboarded. One Microsoft 365 step failed.',
    ...over,
  };
}

const ORDER = ['Targets', 'Effects', 'Human work', 'Not independently verifiable', 'Unresolved', 'Cost', 'Narrative'];

describe('renderCompletionRecord', () => {
  it('1. every section appears, in order', () => {
    const { text, truncated } = renderCompletionRecord(data());
    expect(truncated).toBe(false);
    const idx = ORDER.map((h) => text.indexOf(`## ${h}`));
    for (const i of idx) expect(i).toBeGreaterThan(-1);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(text).toContain('Dana Ruiz');
    expect(text).toContain('approved by Sam Approver');
    expect(text).toContain('completed by Tina Tech');
    expect(text).toContain('$0.42');
  });

  it('2. renders a no-op as a no-op, not as a plain success', () => {
    const { text } = renderCompletionRecord(data());
    expect(text).toContain('#1 google google_remove_from_group — succeeded (no-op, already in the desired state)');
    expect(text).toMatch(/#0 google google_set_vacation — succeeded,/);
  });

  it('3. an unobservable effect names its subsuming criterion', () => {
    const { text } = renderCompletionRecord(data());
    const section = text.slice(text.indexOf('## Not independently verifiable'), text.indexOf('## Unresolved'));
    expect(section).toContain('google_signout: dispatched, not independently verifiable; superseded by the verified google_suspend_user');
  });

  it('4b. ordinary names, group names and ids are NOT withheld (no false positives on the list a technician acts on)', () => {
    const GUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const { text } = renderCompletionRecord(data({
      targets: [{ kind: 'contact', label: 'Jane Passmore', detached: false }],
      humanWork: [{ label: "Collect Jane Passmore's company hardware", done: false, completedBy: null, completedAt: null }],
      verification: { result: 'failed', detail: `still in Microsoft 365 group Disaster Recovery Team; still in Google group Executive Secretaries; groupId=${GUID}` },
    }));
    expect(text).toContain('Jane Passmore');
    expect(text).toContain('Disaster Recovery Team');
    expect(text).toContain('Executive Secretaries');
    expect(text).toContain(GUID);
  });

  it('4d. snake_case, prefixed and plural keywords are still withheld', () => {
    for (const leak of [
      'client_secret=abc', 'db_password=hunter2', 'passwords: hunter2', 'GOOGLE_API_KEY=xyz', 'my_tokens=1', 'access_token: q',
      'clientSecrets=abc', 'secretValue=abc', 'passwordHash=abc', 'apiTokens=abc', 'clientSecretValue=abc', 'userPasswords: x',
      // a base64url refresh token that a '-' splits into short runs
      '1//0gLp3x9Qk2mZrTn8vYw4bH6cJ1dE5fG7-hI0jK2lM4nO6pQ8rS0tU2vW4xY6zA8bC0dE2fG4',
    ]) {
      const { text } = renderCompletionRecord(data({ narrative: `note ${leak}` }));
      expect(text, leak).not.toContain(leak);
    }
  });

  it('4c. one secret-shaped verification problem withholds only that problem', () => {
    const { text } = renderCompletionRecord(data({
      verification: { result: 'failed', detail: 'still in Google group Finance; refreshToken=abc123; Google account is still active' },
    }));
    expect(text).toContain('still in Google group Finance');
    expect(text).toContain('Google account is still active');
    expect(text).not.toContain('abc123');
  });

  it('4. no secret-shaped material survives, even when a field carries some', () => {
    const { text } = renderCompletionRecord(data({
      narrative: 'password=hunter2 clientSecret=abc -----BEGIN PRIVATE KEY-----xyz vaultRef: vault://1',
      humanWork: [
        { label: 'Use eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig to log in', done: false, completedBy: null, completedAt: null },
        { label: 'Key AKIAABCDEFGHIJKLMNOP for the bucket', done: false, completedBy: null, completedAt: null },
        { label: 'Give them the recovery code 123456', done: false, completedBy: null, completedAt: null },
      ],
      effects: [{ ordinal: 0, provider: 'google', toolName: 'google_set_vacation', rendering: 'set password to hunter2', outcome: 'succeeded', verification: 'verified' }],
    }));
    expect(text).not.toMatch(/password|-----BEGIN|clientSecret|vaultRef|hunter2|eyJhbGci|AKIAABCD|123456/i);
  });

  it('5. is capped with a visible marker; the narrative goes first and Unresolved is never cut', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      ordinal: i, provider: 'm365' as const, toolName: 'm365_remove_from_group', rendering: `Remove from group ${i} ${'x'.repeat(60)}`,
      outcome: 'succeeded' as const, verification: 'verified' as const,
    }));
    const { text, truncated } = renderCompletionRecord(data({ effects: many, narrative: 'n'.repeat(5000) }));
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(COMPLETION_RECORD_MAX_CHARS);
    expect(text).toContain('… truncated');
    const unresolved = text.slice(text.indexOf('## Unresolved'), text.indexOf('## Cost'));
    expect(unresolved).toContain("Collect Dana Ruiz's company hardware");
    expect(unresolved).toContain('still a member of Finance');
    expect(unresolved).toContain('m365_groups_read_failed');
    expect(text).not.toContain('n'.repeat(2001));
  });

  it('caps the narrative at 2,000 chars and labels it as the model\'s', () => {
    const { text } = renderCompletionRecord(data({ narrative: 'z'.repeat(3000) }));
    const narrative = text.slice(text.indexOf('## Narrative'));
    expect(narrative).toContain('written by the AI Operator');
    expect(narrative.split('z').length - 1).toBeLessThanOrEqual(2000);
  });
});

describe('postCompletionRecord', () => {
  let inserts: Array<Record<string, unknown>>;
  let stamps: number;
  let stampReturns: unknown[];
  const dbh = () => ({
    update: () => { stamps += 1; return { set: () => ({ where: () => ({ returning: async () => stampReturns }) }) }; },
    insert: () => ({ values: (v: Record<string, unknown>) => { inserts.push(v); return { returning: async () => [{ id: 'comment-1' }] }; } }),
  });

  beforeEach(() => { inserts = []; stamps = 0; stampReturns = [{ id: 'doc-step' }]; lockMock.row = { id: 'ticket-1', orgId: 'o', mergedIntoTicketId: null }; });

  it('REFUSES a ticket that is not in the task\'s org — no comment, no stamp', async () => {
    lockMock.row = { id: 'ticket-1', orgId: 'other-org', mergedIntoTicketId: null };
    await expect(postCompletionRecord(dbh() as never, { orgId: 'o', taskId: 't', ticketId: 'ticket-1', stepId: 'doc-step', text: 'r' }))
      .rejects.toBeInstanceOf(CompletionRecordNoTicketError);
    lockMock.row = null;
    await expect(postCompletionRecord(dbh() as never, { orgId: 'o', taskId: 't', ticketId: 'ticket-1', stepId: 'doc-step', text: 'r' }))
      .rejects.toBeInstanceOf(CompletionRecordNoTicketError);
    expect(inserts).toHaveLength(0);
  });

  it('REFUSES a merged tombstone under the lock (#8972 W1) — no stamp, no comment; the retry re-reads the survivor', async () => {
    // A merge that commits between the record build (which read the task's
    // ticket target) and this lock leaves the read pointing at the tombstone;
    // the merge re-pointed the target, so the coordinator's retry lands on the
    // survivor. The stamp must not be set, or the retry would post nothing.
    lockMock.row = { id: 'ticket-1', orgId: 'o', mergedIntoTicketId: 'survivor-1' };
    const err = await postCompletionRecord(dbh() as never, { orgId: 'o', taskId: 't', ticketId: 'ticket-1', stepId: 'doc-step', text: 'r' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TicketMergedError);
    expect((err as TicketMergedError).mergedIntoTicketId).toBe('survivor-1');
    expect(stamps).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('6. posts an INTERNAL, non-public comment authored by the AI Operator', async () => {
    const r = await postCompletionRecord(dbh() as never, { orgId: 'o', taskId: 't', ticketId: 'ticket-1', stepId: 'doc-step', text: 'record' });
    expect(r).toEqual({ posted: true, commentId: 'comment-1' });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ ticketId: 'ticket-1', commentType: 'internal', isPublic: false, authorType: 'ai_agent', userId: null, content: 'record' });
  });

  it('7. is idempotent: the guarded stamp already set means NO second comment', async () => {
    stampReturns = [];
    const r = await postCompletionRecord(dbh() as never, { orgId: 'o', taskId: 't', ticketId: 'ticket-1', stepId: 'doc-step', text: 'record' });
    expect(r).toEqual({ posted: false, commentId: null });
    expect(inserts).toHaveLength(0);
  });

  it('8. a task with no ticket is a named programming error, not a silent skip', async () => {
    await expect(postCompletionRecord(dbh() as never, { orgId: 'o', taskId: 't', ticketId: null, stepId: 'doc-step', text: 'r' }))
      .rejects.toBeInstanceOf(CompletionRecordNoTicketError);
    expect(inserts).toHaveLength(0);
  });
});
