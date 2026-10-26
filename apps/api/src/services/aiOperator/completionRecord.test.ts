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

// ---------------------------------------------------------------------------
// W07 R2a Task 13 — appended. R1's cases above are not edited.
// ---------------------------------------------------------------------------

/**
 * Loader harness for the appended cases. The file-level db mock above is a bare
 * `{}`; these cases lend it the repo's table-keyed stand-in, made WHERE-aware
 * below so a read for one approval does not see another approval's rows.
 * `readTaskSpentCents` and `listCreatedAccountsForTask` are stubbed: the first
 * runs outside the record's system context and is not under test here, the
 * second is Task 11's projection, under test in its own suites.
 */
const r2a = vi.hoisted(() => ({
  list: vi.fn(async (_orgId: string, _taskId: string): Promise<unknown[]> => []),
}));
vi.mock('./taskLimitsLoader', () => ({ readTaskSpentCents: async () => 42 }));
vi.mock('./credentialHandover', () => ({ listCreatedAccountsForTask: r2a.list }));

import { createTableKeyedDb, renderSql, type TableKeyedDb } from '../../__tests__/helpers/tableKeyedDb';
import { loadCompletionData } from './completionRecord';
import { planEffectOperationKey } from './planApproval';

const R2A_ORG = '00000000-0000-4000-8000-0000000000a1';
const R2A_TASK = '00000000-0000-4000-8000-0000000000b1';
const R2A_CONTACT = '00000000-0000-4000-8000-0000000000e1';
const U_CREATE = '00000000-0000-4000-8000-0000000000c1';
const U_PROVISION = '00000000-0000-4000-8000-0000000000c2';
const U_TECH = '00000000-0000-4000-8000-0000000000c3';
const A_CREATE = '00000000-0000-4000-8000-0000000000f3';
const A_PROVISION = '00000000-0000-4000-8000-0000000000f4';
const A_OFFBOARD = '00000000-0000-4000-8000-0000000000f1';
const ENTRA_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const SEALED = 'enc:v3:SEALED-CIPHERTEXT-SENTINEL';
const PLAIN = 'Plain-Sentinel#4821';

type Rows = Record<string, Record<string, unknown>[]>;

/** The rows a table's WHERE would return, filtered on the values bound into it. */
function whereAware(k: () => TableKeyedDb, rows: () => Rows) {
  return () => {
    const last = k().selects[k().selects.length - 1];
    const params = last?.where ? renderSql(last.where).params : [];
    const has = (v: unknown) => params.includes(v);
    const all = rows();
    return {
      ...all,
      ai_operator_plan_approvals: (all.ai_operator_plan_approvals ?? []).filter((r) => has(r.planRevision) && (
        // a read that binds a step key returns only that step's approvals
        !params.some((p) => p === 'create_accounts' || p === 'provision_effects') || has(r.stepKey))),
      ai_operator_plan_approval_effects: (all.ai_operator_plan_approval_effects ?? []).filter((r) => has(r.approvalId)),
      ai_operator_operations: (all.ai_operator_operations ?? []).filter((r) => has(r.operationKey)),
      ai_operator_task_steps: (all.ai_operator_task_steps ?? []).filter((r) =>
        (has('human_work') ? r.stepKind === 'human_work' : has(r.stepKey))),
      users: (all.users ?? []).filter((r) => has(r.id)),
    };
  };
}

function stepRow(over: Record<string, unknown>): Record<string, unknown> {
  return { index: 0, stepKey: 'x', stepKind: 'reason', label: null, tickedAt: null, tickedBy: null, checkpoint: {}, ...over };
}

function effectRow(approvalId: string, ordinal: number, toolName: string, rendering: string, provider = 'm365'): Record<string, unknown> {
  return { approvalId, ordinal, provider, toolName, targetId: R2A_CONTACT, rendering };
}

function opRow(stepKey: string, planRevision: number, toolName: string, ordinal: number, result: Record<string, unknown>, resultState = 'succeeded') {
  return {
    operationKey: planEffectOperationKey({ stepKey, planRevision, toolName, targetId: R2A_CONTACT, ordinal }),
    resultState, result,
  };
}

/** R1's offboarding task as rows: one approval, at the task's revision. */
function offboardingRows(): Rows {
  return {
    ai_operator_tasks: [{ revision: 2, checkpoint: { manualWorkCursor: 1, lastVerification: { result: 'failed', detail: 'still a member of Finance' } } }],
    ai_operator_task_targets: [
      { kind: 'contact', label: 'Dana Ruiz', detachedAt: null, ticketId: null },
      { kind: 'ticket', label: 'Offboard Dana', detachedAt: null, ticketId: '00000000-0000-4000-8000-000000000071' },
    ],
    ai_operator_task_target_accounts: [{ provider: 'm365', principalLabel: 'dana@customer.example' }],
    ai_operator_plan_approvals: [{ id: A_OFFBOARD, stepKey: 'identity_effects', planRevision: 2, approvedBy: U_CREATE }],
    ai_operator_plan_approval_effects: [
      effectRow(A_OFFBOARD, 0, 'm365_disable_user', 'Disable dana@customer.example'),
      effectRow(A_OFFBOARD, 1, 'm365_remove_from_group', 'Remove from Finance'),
    ],
    ai_operator_operations: [
      opRow('identity_effects', 2, 'm365_disable_user', 0, { verified: { ok: true } }),
      opRow('identity_effects', 2, 'm365_remove_from_group', 1, { verified: { ok: false } }),
    ],
    ai_operator_task_steps: [
      stepRow({ stepKey: 'confirm_identity', stepKind: 'human_work', label: 'Confirm identity', tickedAt: new Date('2026-10-23T12:00:00.000Z'), tickedBy: U_TECH }),
      stepRow({ stepKey: 'review', checkpoint: { reviewOutput: { summary: 'Dana was offboarded.' } } }),
      stepRow({ stepKey: 'discover', checkpoint: { planningSnapshot: { facts: { flags: [{ code: 'm365_groups_read_failed', subject: 'dana@customer.example', detail: 'read failed' }] } } } }),
    ],
    users: [
      { id: U_CREATE, name: 'Sam Approver', email: 'sam@customer.example' },
      { id: U_TECH, name: 'Tina Tech', email: 'tina@customer.example' },
    ],
  };
}

let r2aRows: Rows = {};
let r2aK: TableKeyedDb;
beforeEach(async () => {
  r2a.list.mockReset();
  r2a.list.mockResolvedValue([]);
  r2aRows = {};
  r2aK = createTableKeyedDb(whereAware(() => r2aK, () => r2aRows));
  const mod = await import('../../db');
  (mod.db as unknown as Record<string, unknown>).select = r2aK.db.select;
});

describe('completion record — PIN: offboarding and service-recovery records are byte-identical (R2a Task 13)', () => {
  // PIN, not a red: these freeze the shipped R1/SR output so Task 13's
  // onboarding additions are proven conditional on the recipe. If one moves,
  // the additions leaked into a recipe that did not ask for them.
  it('PIN: R1\'s offboarding fixture renders exactly as shipped', () => {
    const r = renderCompletionRecord(data());
    expect(r.truncated).toBe(false);
    expect(r.text).toMatchInlineSnapshot(`
      "# AI Operator completion record (identity_offboarding)

      ## Targets
      - contact: Dana Ruiz
      - ticket: Offboard Dana
      - google account: dana@customer.example
      - m365 account: dana@customer.example

      ## Effects
      - #0 google google_set_vacation — succeeded, verified, approved by Sam Approver: Set auto-reply
      - #1 google google_remove_from_group — succeeded (no-op, already in the desired state), verified, approved by Sam Approver: Remove from All Staff
      - #2 google google_signout — succeeded, not independently verifiable, approved by Sam Approver: Sign out
      - #3 google google_suspend_user — succeeded, verified, approved by Sam Approver: Suspend
      - #4 m365 m365_disable_user — failed, NOT verified, approved by Sam Approver: Disable

      ## Human work
      - [x] Confirm identity — completed by Tina Tech at 2026-10-23T12:00:00.000Z
      - [ ] Collect Dana Ruiz's company hardware

      ## Not independently verifiable
      - google_signout: dispatched, not independently verifiable; superseded by the verified google_suspend_user

      ## Unresolved
      - Not done by hand yet: Collect Dana Ruiz's company hardware
      - m365_disable_user (#4): failed
      - Final verification failed: still a member of Finance
      - Discovery: m365_groups_read_failed (dana@customer.example): read failed

      ## Cost
      - AI reasoning spend for this task: $0.42

      ## Narrative (written by the AI Operator; the sections above are from records)
      Dana was offboarded. One Microsoft 365 step failed."
    `);
  });

  it('PIN: a service-recovery record renders exactly as shipped', () => {
    const r = renderCompletionRecord(data({
      recipeKey: 'service_recovery',
      targets: [{ kind: 'device', label: 'FS-01', detached: false }, { kind: 'ticket', label: 'Print spooler down', detached: false }],
      accounts: [],
      approverName: 'Sam Approver',
      effects: [{ ordinal: 0, provider: 'breeze', toolName: 'restart_service', rendering: 'Restart Spooler on FS-01', outcome: 'succeeded', verification: 'verified' }],
      humanWork: [],
      verification: { result: 'passed', detail: '' },
      discoveryFlags: [],
      costCents: 7,
      narrative: 'The spooler was restarted and printing resumed.',
    }));
    expect(r.text).toMatchInlineSnapshot(`
      "# AI Operator completion record (service_recovery)

      ## Targets
      - device: FS-01
      - ticket: Print spooler down

      ## Effects
      - #0 breeze restart_service — succeeded, verified, approved by Sam Approver: Restart Spooler on FS-01

      ## Human work
      - (none)

      ## Not independently verifiable
      - (none)

      ## Unresolved
      - (nothing)

      ## Cost
      - AI reasoning spend for this task: $0.07

      ## Narrative (written by the AI Operator; the sections above are from records)
      The spooler was restarted and printing resumed."
    `);
  });

  it('PIN: the offboarding LOADER reads the same tables, never asks for created accounts, and yields the same record', async () => {
    r2aRows = offboardingRows();
    const loaded = await loadCompletionData({ orgId: R2A_ORG, taskId: R2A_TASK, recipeKey: 'identity_offboarding' });
    expect(r2a.list).not.toHaveBeenCalled();
    expect(r2aK.reads).toEqual([
      'ai_operator_tasks', 'ai_operator_task_targets', 'ai_operator_task_target_accounts', 'ai_operator_plan_approvals',
      'ai_operator_plan_approval_effects', 'ai_operator_operations', 'ai_operator_task_steps', 'users',
      'ai_operator_task_steps', 'ai_operator_task_steps',
    ]);
    expect(Object.keys(loaded).sort()).toEqual([
      'accounts', 'approverName', 'costCents', 'discoveryFlags', 'effects', 'humanWork', 'narrative', 'recipeKey',
      'targets', 'ticketId', 'verification',
    ]);
    expect(renderCompletionRecord(loaded).text).toMatchInlineSnapshot(`
      "# AI Operator completion record (identity_offboarding)

      ## Targets
      - contact: Dana Ruiz
      - ticket: Offboard Dana
      - m365 account: dana@customer.example

      ## Effects
      - #0 m365 m365_disable_user — succeeded, verified, approved by Sam Approver: Disable dana@customer.example
      - #1 m365 m365_remove_from_group — succeeded, NOT verified, approved by Sam Approver: Remove from Finance

      ## Human work
      - [x] Confirm identity — completed by Tina Tech at 2026-10-23T12:00:00.000Z

      ## Not independently verifiable
      - (none)

      ## Unresolved
      - m365_remove_from_group (#1): ran but was not verified
      - Final verification failed: still a member of Finance
      - Discovery: m365_groups_read_failed (dana@customer.example): read failed

      ## Cost
      - AI reasoning spend for this task: $0.42

      ## Narrative (written by the AI Operator; the sections above are from records)
      Dana was offboarded."
    `);
  });
});

type OnboardingSection = NonNullable<CompletionRecordData['onboarding']>;
type OnboardingAccount = OnboardingSection['accounts'][number];

function account(over: Partial<OnboardingAccount> = {}): OnboardingAccount {
  return {
    provider: 'm365', principalLabel: 'priya@customer.example', externalId: ENTRA_ID,
    credentialState: 'available', revealableByName: 'Sam Approver', revealExpiresAt: '2026-10-31T11:00:00.000Z',
    ...over,
  };
}

function onboardingData(over: Partial<CompletionRecordData> = {}): CompletionRecordData {
  return data({
    recipeKey: 'identity_onboarding',
    targets: [{ kind: 'contact', label: 'Priya Raman', detached: false }, { kind: 'ticket', label: 'Onboard Priya', detached: false }],
    accounts: [{ provider: 'm365', principalLabel: 'priya@customer.example' }],
    approverName: 'Avery Approver',
    effects: [
      { ordinal: 0, provider: 'm365', toolName: 'm365_create_user', rendering: 'Create priya@customer.example', outcome: 'succeeded', verification: 'verified', planRevision: 3 },
      { ordinal: 0, provider: 'm365', toolName: 'm365_assign_license', rendering: 'Assign Business Premium', outcome: 'succeeded', verification: 'verified', planRevision: 4 },
      { ordinal: 1, provider: 'm365', toolName: 'm365_add_to_group', rendering: 'Add to Sales', outcome: 'failed', verification: 'none', planRevision: 4 },
    ],
    humanWork: [
      { label: 'Confirm the new hire\'s details', done: true, completedBy: 'Tina Tech', completedAt: '2026-10-23T09:00:00.000Z' },
      { label: 'Hand over the laptop', done: false, completedBy: null, completedAt: null },
    ],
    verification: { result: 'passed', detail: '' },
    discoveryFlags: [],
    narrative: 'Priya was onboarded; one group add failed.',
    onboarding: {
      accounts: [account(), account({ provider: 'google', externalId: '900100', credentialState: 'not_applicable', revealableByName: null, revealExpiresAt: null })],
      approvals: [
        { stage: 'create', planRevision: 3, state: 'superseded', approverName: 'Sam Approver', approvedAt: '2026-10-24T10:00:00.000Z' },
        { stage: 'provision', planRevision: 4, state: 'approved', approverName: 'Avery Approver', approvedAt: '2026-10-24T11:00:00.000Z' },
      ],
    },
    ...over,
  });
}

function section(text: string, head: string): string {
  const start = text.indexOf(`## ${head}`);
  expect(start, head).toBeGreaterThan(-1);
  const next = text.indexOf('\n## ', start + 3);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

describe('completion record — identity_onboarding (R2a Task 13)', () => {
  it('O1. every section appears in order, with "Accounts created" between Targets and Effects', () => {
    const { text, truncated } = renderCompletionRecord(onboardingData());
    expect(truncated).toBe(false);
    const order = ['Targets', 'Accounts created', 'Effects', 'Human work', 'Not independently verifiable', 'Unresolved', 'Cost', 'Narrative'];
    const idx = order.map((h) => text.indexOf(`## ${h}`));
    for (const [i, at] of idx.entries()) expect(at, order[i]).toBeGreaterThan(-1);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    const accounts = section(text, 'Accounts created');
    expect(accounts).toContain(`- m365: priya@customer.example (id ${ENTRA_ID}) — temporary password: available to Sam Approver until 2026-10-31T11:00:00.000Z (one reveal, from the approval history)`);
    expect(accounts).toContain('- google: priya@customer.example (id 900100) — password set by hand during onboarding (no stored credential)');
  });

  it('O2. the credential STATE is said in words for every state, and no credential is ever printed', () => {
    const words: Record<OnboardingAccount['credentialState'], string> = {
      available: 'temporary password: available to Sam Approver until 2026-10-31T11:00:00.000Z',
      revealed: 'temporary password: revealed (the one-time reveal has been used)',
      expired: 'temporary password: expired un-revealed — reset the password instead of creating a second account',
      unretrievable: 'temporary password: never stored (sealing failed) — reset the password instead of creating a second account',
      not_applicable: 'no revealable temporary password on record',
    };
    for (const [state, rendering] of Object.entries(words) as Array<[OnboardingAccount['credentialState'], string]>) {
      // The view is typed; a future field carrying the value must still not print.
      const leaky = { ...account({ credentialState: state }), temporaryPassword: PLAIN, temporaryPasswordEnc: SEALED } as OnboardingAccount;
      const { text } = renderCompletionRecord(onboardingData({ onboarding: { accounts: [leaky], approvals: [] } }));
      expect(section(text, 'Accounts created'), state).toContain(rendering);
      expect(text).not.toContain(PLAIN);
      expect(text).not.toContain(SEALED);
      expect(text).not.toContain('enc:v3:');
      expect(text).not.toMatch(/temporaryPassword/);
    }
  });

  it('O3. an expired or never-stored credential is an Unresolved RESET item, never a re-create', () => {
    for (const state of ['expired', 'unretrievable'] as const) {
      const { text } = renderCompletionRecord(onboardingData({ onboarding: { accounts: [account({ credentialState: state, revealableByName: null, revealExpiresAt: null })], approvals: [] } }));
      const unresolved = section(text, 'Unresolved');
      expect(unresolved, state).toContain('- Reset the password for priya@customer.example (m365) with m365_reset_password; do not create a second account');
      expect(text).not.toMatch(/re-?create the account|create it again/i);
    }
    const { text } = renderCompletionRecord(onboardingData());
    expect(section(text, 'Unresolved')).not.toContain('Reset the password');
  });

  it('O4. both approvals appear, labelled by stage with their own approver; the superseded creation approval is shown, not hidden', () => {
    const { text } = renderCompletionRecord(onboardingData());
    const effects = section(text, 'Effects');
    const stage1 = '### Stage 1 of 2 — account creation (plan revision 3; approval superseded at the stage change, kept as the record): approved by Sam Approver at 2026-10-24T10:00:00.000Z';
    const stage2 = '### Stage 2 of 2 — provisioning (plan revision 4; approval approved): approved by Avery Approver at 2026-10-24T11:00:00.000Z';
    expect(effects).toContain(stage1);
    expect(effects).toContain(stage2);
    expect(effects.indexOf(stage1)).toBeLessThan(effects.indexOf(stage2));
    // Each stage's effects sit under it and carry that stage's approver.
    const s1 = effects.slice(effects.indexOf(stage1), effects.indexOf(stage2));
    const s2 = effects.slice(effects.indexOf(stage2));
    expect(s1).toContain('- #0 m365 m365_create_user — succeeded, verified, approved by Sam Approver: Create priya@customer.example');
    expect(s2).toContain('- #0 m365 m365_assign_license — succeeded, verified, approved by Avery Approver: Assign Business Premium');
    expect(s2).toContain('- #1 m365 m365_add_to_group — failed, no verification, approved by Avery Approver: Add to Sales');
    expect(s1).not.toContain('m365_assign_license');
  });

  it('O4b. a stage with no approval says so instead of borrowing the other stage\'s approver', () => {
    const { text } = renderCompletionRecord(onboardingData({
      effects: [{ ordinal: 0, provider: 'm365', toolName: 'm365_create_user', rendering: 'Create priya@customer.example', outcome: 'succeeded', verification: 'verified', planRevision: 3 }],
      onboarding: { accounts: [account()], approvals: [{ stage: 'create', planRevision: 3, state: 'approved', approverName: 'Sam Approver', approvedAt: '2026-10-24T10:00:00.000Z' }] },
    }));
    const effects = section(text, 'Effects');
    expect(effects).toContain('### Stage 2 of 2 — provisioning: no approval recorded');
    expect(effects).not.toContain('Avery Approver');
  });

  it('O5. a Google-only onboarding names who created the account by hand, and when', () => {
    const { text } = renderCompletionRecord(onboardingData({
      accounts: [{ provider: 'google', principalLabel: 'priya@customer.example' }],
      effects: [],
      humanWork: [{ label: 'Create the Google account priya@customer.example', done: true, completedBy: 'Tina Tech', completedAt: '2026-10-24T09:30:00.000Z' }],
      onboarding: { accounts: [account({ provider: 'google', externalId: '900100', credentialState: 'not_applicable', revealableByName: null, revealExpiresAt: null })], approvals: [] },
    }));
    expect(section(text, 'Human work')).toContain('- [x] Create the Google account priya@customer.example — completed by Tina Tech at 2026-10-24T09:30:00.000Z');
    expect(section(text, 'Accounts created')).toContain('- google: priya@customer.example (id 900100) — password set by hand during onboarding (no stored credential)');
    expect(section(text, 'Effects')).toContain('### Stage 1 of 2 — account creation: no approval recorded');
  });

  it('O7. capped at COMPLETION_RECORD_MAX_CHARS; "Accounts created" and Unresolved both survive and the narrative goes first', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      ordinal: i, provider: 'm365', toolName: 'm365_add_to_group', rendering: `Add to group ${i} ${'x'.repeat(60)}`,
      outcome: 'succeeded' as const, verification: 'verified' as const, planRevision: 4,
    }));
    const { text, truncated } = renderCompletionRecord(onboardingData({
      effects: many, narrative: 'n'.repeat(5000),
      onboarding: { accounts: [account({ credentialState: 'expired', revealableByName: null, revealExpiresAt: null })], approvals: onboardingData().onboarding!.approvals },
    }));
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(COMPLETION_RECORD_MAX_CHARS);
    expect(section(text, 'Accounts created')).toContain('temporary password: expired un-revealed — reset the password instead of creating a second account');
    expect(section(text, 'Unresolved')).toContain('Reset the password for priya@customer.example (m365)');
    expect(section(text, 'Unresolved')).toContain('Hand over the laptop');
    expect(text).not.toContain('n'.repeat(2001));
  });

  it('O8. a bounded account list: at most four account lines, however many views arrive', () => {
    const accounts = Array.from({ length: 9 }, (_, i) => account({ principalLabel: `u${i}@customer.example` }));
    const { text } = renderCompletionRecord(onboardingData({ onboarding: { accounts, approvals: [] } }));
    expect(section(text, 'Accounts created').split('\n').filter((l) => l.startsWith('- ')).length).toBe(4);
  });
});

/** An onboarding task at r+1 = 4 whose creation approval at r = 3 is superseded. */
function onboardingRows(): Rows {
  return {
    ai_operator_tasks: [{ revision: 4, checkpoint: { checkpointKind: 'identity_onboarding', createPlanRevision: 3, lastVerification: { result: 'passed', detail: '' } } }],
    ai_operator_task_targets: [
      { kind: 'contact', label: 'Priya Raman', detachedAt: null, ticketId: null },
      { kind: 'ticket', label: 'Onboard Priya', detachedAt: null, ticketId: '00000000-0000-4000-8000-000000000072' },
    ],
    ai_operator_task_target_accounts: [{ provider: 'm365', principalLabel: 'priya@customer.example' }],
    ai_operator_plan_approvals: [
      { id: A_PROVISION, stepKey: 'provision_effects', planRevision: 4, state: 'approved', approvedBy: U_PROVISION, approvedAt: new Date('2026-10-24T11:00:00.000Z') },
      // Superseded by resolve_accounts' bump; approved_by / approved_at are kept (B7).
      { id: A_CREATE, stepKey: 'create_accounts', planRevision: 3, state: 'superseded', approvedBy: U_CREATE, approvedAt: new Date('2026-10-24T10:00:00.000Z') },
    ],
    ai_operator_plan_approval_effects: [
      effectRow(A_CREATE, 0, 'm365_create_user', 'Create priya@customer.example'),
      effectRow(A_PROVISION, 0, 'm365_assign_license', 'Assign Business Premium'),
    ],
    ai_operator_operations: [
      // The create result carries the sealed credential (and, adversarially, a
      // plaintext): the record renders only the operation's STATE.
      opRow('create_accounts', 3, 'm365_create_user', 0, {
        success: true, action: 'm365.user.create', userId: ENTRA_ID, verified: { ok: true },
        temporaryPasswordEnc: SEALED, temporaryPassword: PLAIN,
      }),
      opRow('provision_effects', 4, 'm365_assign_license', 0, { verified: { ok: true } }),
    ],
    ai_operator_task_steps: [
      stepRow({ stepKey: 'confirm_details', stepKind: 'human_work', label: 'Confirm the new hire\'s details', tickedAt: new Date('2026-10-23T09:00:00.000Z'), tickedBy: U_TECH }),
      stepRow({ stepKey: 'review', checkpoint: { reviewOutput: { summary: 'Priya was onboarded.' } } }),
      stepRow({ stepKey: 'discover', checkpoint: { planningSnapshot: { facts: { flags: [] } } } }),
    ],
    users: [
      { id: U_CREATE, name: 'Sam Approver', email: 'sam@customer.example' },
      { id: U_PROVISION, name: 'Avery Approver', email: 'avery@customer.example' },
      { id: U_TECH, name: 'Tina Tech', email: 'tina@customer.example' },
    ],
  };
}

describe('completion record — identity_onboarding LOADER (R2a Task 13)', () => {
  beforeEach(() => {
    r2aRows = onboardingRows();
    r2a.list.mockResolvedValue([{
      provider: 'm365', principalLabel: 'priya@customer.example', externalId: ENTRA_ID, credentialState: 'available',
      intentId: '00000000-0000-4000-8000-0000000000d1', revealableByUserId: U_CREATE, revealableByName: 'Sam Approver',
      revealExpiresAt: '2026-10-31T11:00:00.000Z',
      // Injected: the mocked projection result carries the value; it must not print.
      temporaryPassword: PLAIN, temporaryPasswordEnc: SEALED,
    }]);
  });

  it('L1. lists the created accounts with their credential STATE, from Task 11\'s projection', async () => {
    const r = await loadCompletionData({ orgId: R2A_ORG, taskId: R2A_TASK, recipeKey: 'identity_onboarding' });
    expect(r2a.list).toHaveBeenCalledTimes(1);
    expect(r2a.list).toHaveBeenCalledWith(R2A_ORG, R2A_TASK);
    expect(r.onboarding?.accounts).toEqual([account()]);
    const { text } = renderCompletionRecord(r);
    expect(section(text, 'Accounts created')).toContain(`- m365: priya@customer.example (id ${ENTRA_ID}) — temporary password: available to Sam Approver until 2026-10-31T11:00:00.000Z`);
  });

  it('L2. no plaintext, no sealed value and no carrier key reach the record, though the projection and the operation result carry them', async () => {
    const r = await loadCompletionData({ orgId: R2A_ORG, taskId: R2A_TASK, recipeKey: 'identity_onboarding' });
    const { text } = renderCompletionRecord(r);
    expect(JSON.stringify(r)).not.toContain(PLAIN);
    expect(JSON.stringify(r)).not.toContain(SEALED);
    expect(text).not.toContain(PLAIN);
    expect(text).not.toContain(SEALED);
    expect(text).not.toContain('enc:v3:');
    expect(text).not.toMatch(/temporaryPassword/);
  });

  it('L3. the SUPERSEDED creation approval at r is still attributed, beside the provisioning approval at r+1', async () => {
    const r = await loadCompletionData({ orgId: R2A_ORG, taskId: R2A_TASK, recipeKey: 'identity_onboarding' });
    expect(r.onboarding?.approvals).toEqual([
      { stage: 'create', planRevision: 3, state: 'superseded', approverName: 'Sam Approver', approvedAt: '2026-10-24T10:00:00.000Z' },
      { stage: 'provision', planRevision: 4, state: 'approved', approverName: 'Avery Approver', approvedAt: '2026-10-24T11:00:00.000Z' },
    ]);
    const effects = section(renderCompletionRecord(r).text, 'Effects');
    expect(effects).toContain('### Stage 1 of 2 — account creation (plan revision 3; approval superseded at the stage change, kept as the record): approved by Sam Approver at 2026-10-24T10:00:00.000Z');
    expect(effects).toContain('- #0 m365 m365_create_user — succeeded, verified, approved by Sam Approver: Create priya@customer.example');
    expect(effects).toContain('### Stage 2 of 2 — provisioning (plan revision 4; approval approved): approved by Avery Approver at 2026-10-24T11:00:00.000Z');
    expect(effects).toContain('- #0 m365 m365_assign_license — succeeded, verified, approved by Avery Approver: Assign Business Premium');
  });

  it('L4. every read the onboarding branch adds carries an explicit org_id predicate', async () => {
    await loadCompletionData({ orgId: R2A_ORG, taskId: R2A_TASK, recipeKey: 'identity_onboarding' });
    const tenant = r2aK.selects.filter((s) => s.table !== 'users');
    expect(tenant.length).toBeGreaterThan(10);
    for (const s of tenant) {
      const { sql: text, params } = renderSql(s.where);
      expect(text, s.table).toContain(`"${s.table}"."org_id" = `);
      expect(params, s.table).toContain(R2A_ORG);
    }
  });

  it('L5. a task handed off before the bump (still at r) renders its creation stage from the current-revision approval', async () => {
    r2aRows = onboardingRows();
    r2aRows.ai_operator_tasks = [{ revision: 3, checkpoint: { checkpointKind: 'identity_onboarding', createPlanRevision: 3, lastVerification: null } }];
    r2aRows.ai_operator_plan_approvals = r2aRows.ai_operator_plan_approvals!.filter((a) => a.id === A_CREATE).map((a) => ({ ...a, state: 'approved' }));
    const r = await loadCompletionData({ orgId: R2A_ORG, taskId: R2A_TASK, recipeKey: 'identity_onboarding' });
    const effects = section(renderCompletionRecord(r).text, 'Effects');
    expect(effects).toContain('### Stage 1 of 2 — account creation (plan revision 3; approval approved): approved by Sam Approver at 2026-10-24T10:00:00.000Z');
    expect(effects.match(/m365_create_user/g)).toHaveLength(1);
    expect(effects).toContain('### Stage 2 of 2 — provisioning: no approval recorded');
  });
});

describe('completion record — the onboarding create-stage read projects only noop / verified (R2a review)', () => {
  it('loadOnboardingStages never selects the whole operation result column (a secret-bearing result is not copied out)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./completionRecord.ts', import.meta.url), 'utf8');
    const start = src.indexOf('async function loadOnboardingStages(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\nexport async function buildCompletionRecord(', start));
    expect(body).toContain('aiOperatorOperations');
    expect(body).not.toMatch(/result:\s*aiOperatorOperations\.result\b/);
    expect(body).toContain('OPERATION_RESULT_STATE_KEYS');
  });
});
