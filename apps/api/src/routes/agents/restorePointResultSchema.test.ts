import { describe, expect, it } from 'vitest';
import { RESTORE_POINT_STATUSES, type RestorePointOutcome } from '@breeze/shared';
import { RESTORE_POINT_ATTEMPT_STATUSES } from '../../db/schema/deviceRestorePointAttempts';
import { buildStoredCommandResult } from '../../services/storedCommandResult';
import {
  classifyRestorePointOutcome,
  commandResultSchema,
  parseRestorePointOutcome,
  RESTORE_POINT_OUTCOME_STATUSES,
  restorePointOutcomeSchema,
} from './schemas';

const REQUEST_ID = '3f1d1a0e-0000-4000-8000-000000000001';

function outcome(overrides: Record<string, unknown> = {}) {
  return {
    status: 'created',
    requestId: REQUEST_ID,
    sequenceNumber: '42',
    attemptedAt: '2026-09-02T18:03:11Z',
    durationMs: 1234,
    ...overrides,
  };
}

describe('restorePoint outcome status vocabulary (#4757)', () => {
  // The agent (agent/internal/systemrestore/types.go, Status) produces exactly
  // these nine. A rename or a new value on any one of the three sides must
  // fail here rather than silently classify real outcomes as invalid.
  const NINE = [
    'created', 'existing_accepted', 'skipped_disabled', 'skipped_definition_only',
    'unsupported', 'busy', 'insufficient_privileges', 'verification_failed', 'failed',
  ];

  it('accepts exactly the nine agent-produced statuses', () => {
    expect([...RESTORE_POINT_OUTCOME_STATUSES]).toEqual(NINE);
    expect([...restorePointOutcomeSchema.shape.status.options]).toEqual(NINE);
  });

  it('equals the shared status union minus the server-only requested', () => {
    expect([...RESTORE_POINT_OUTCOME_STATUSES]).toEqual(RESTORE_POINT_STATUSES.filter((s) => s !== 'requested'));
  });

  it('equals the ledger terminal statuses', () => {
    expect([...RESTORE_POINT_OUTCOME_STATUSES]).toEqual(RESTORE_POINT_ATTEMPT_STATUSES.filter((s) => s !== 'requested'));
  });

  it('parses to the shared RestorePointOutcome type (compile-time)', () => {
    const parsed = parseRestorePointOutcome(outcome());
    const typed: RestorePointOutcome | null = parsed;
    expect(typed?.status).toBe('created');
  });
});

describe('commandResultSchema restorePoint transport field', () => {
  it('accepts a result with no restorePoint field (every agent shipped to date)', () => {
    const res = commandResultSchema.safeParse({ status: 'completed', exitCode: 0 });
    expect(res.success).toBe(true);
    expect(res.success && 'restorePoint' in res.data).toBe(false);
  });

  it('carries a well-formed outcome through', () => {
    const res = commandResultSchema.safeParse({ status: 'completed', exitCode: 0, restorePoint: outcome() });
    expect(res.success).toBe(true);
    expect(res.success && res.data.restorePoint).toEqual(outcome());
  });

  // Decision 2: a bad restorePoint must never 400 the whole command result
  // and strand a completed patch/script/install.
  it.each([
    ['an unknown status', outcome({ status: 'probably_fine' })],
    ['a numeric sequenceNumber', outcome({ sequenceNumber: 9223372036854775807 })],
    ['an oversized message', outcome({ status: 'failed', message: 'x'.repeat(10_001) })],
    ['the server-only requested status', outcome({ status: 'requested' })],
    ['a non-object', 'created'],
    ['null', null],
  ])('still accepts the command result when restorePoint has %s', (_label, rp) => {
    const res = commandResultSchema.safeParse({ status: 'completed', exitCode: 0, restorePoint: rp });
    expect(res.success).toBe(true);
  });
});

describe('restorePointOutcomeSchema / classifyRestorePointOutcome', () => {
  it('accepts a well-formed throttle-path outcome', () => {
    expect(classifyRestorePointOutcome(outcome({
      status: 'existing_accepted', sequenceNumber: '9223372036854775807',
      existingPointAgeMinutes: 240, frequencyMinutes: 1440,
    }))).toMatchObject({ ok: true });
  });

  it('accepts the minimal shape the Go agent emits (omitempty fields absent, empty attemptedAt)', () => {
    expect(classifyRestorePointOutcome({
      status: 'skipped_disabled', requestId: REQUEST_ID, attemptedAt: '', durationMs: 0,
    })).toMatchObject({ ok: true });
  });

  it('strips unknown keys', () => {
    const parsed = parseRestorePointOutcome(outcome({ extra: 'nope' }));
    expect(parsed && 'extra' in parsed).toBe(false);
  });

  it.each([
    ['unknown_status', outcome({ status: 'probably_fine' })],
    ['unknown_status', outcome({ status: 'requested' })],
    ['malformed', outcome({ sequenceNumber: 9223372036854775807 })],
    ['malformed', outcome({ sequenceNumber: '12abc' })],
    // 20 digits passes the decimal shape but exceeds int64.
    ['malformed', outcome({ sequenceNumber: '99999999999999999999' })],
    ['malformed', outcome({ message: 'x'.repeat(10_001) })],
    ['malformed', outcome({ description: 'x'.repeat(513) })],
    ['malformed', outcome({ requestId: 'not-a-uuid' })],
    ['malformed', outcome({ durationMs: 2_147_483_648 })],
    ['malformed', outcome({ durationMs: 1.5 })],
    ['malformed', outcome({ frequencyMinutes: -1 })],
    ['malformed', outcome({ status: undefined })],
    ['malformed', null],
    ['malformed', 'created'],
  ])('classifies as invalid (%s)', (reason, raw) => {
    expect(classifyRestorePointOutcome(raw)).toEqual({ ok: false, reason });
    expect(parseRestorePointOutcome(raw)).toBeNull();
  });

  it('redacts secrets from the agent-authored message and description (#2434)', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----';
    const parsed = parseRestorePointOutcome(outcome({ status: 'failed', message: `vss said ${pem}`, description: `d ${pem}` }));
    expect(parsed?.message).toContain('vss said');
    expect(parsed?.message).not.toContain('MIIabc');
    expect(parsed?.description).not.toContain('MIIabc');
    const stored = buildStoredCommandResult(
      'script', { status: 'completed', restorePoint: outcome({ status: 'failed', message: pem }) }, undefined,
    ) as { restorePoint?: { message?: string } };
    expect(stored.restorePoint?.message).not.toContain('MIIabc');
  });

  it('accepts the int64 bounds exactly', () => {
    expect(classifyRestorePointOutcome(outcome({ sequenceNumber: '-9223372036854775808' })).ok).toBe(true);
    expect(classifyRestorePointOutcome(outcome({ sequenceNumber: '9223372036854775808' })).ok).toBe(false);
  });
});

describe('buildStoredCommandResult restorePoint (decision 6)', () => {
  it('stores the parsed outcome verbatim when valid', () => {
    const stored = buildStoredCommandResult(
      'script', { status: 'completed', exitCode: 0, restorePoint: outcome({ extra: 'dropped' }) }, undefined,
    );
    expect(stored).toMatchObject({ restorePoint: outcome() });
    expect((stored as { restorePoint?: Record<string, unknown> }).restorePoint).not.toHaveProperty('extra');
  });

  it('does not add a restorePoint key when the agent sent none', () => {
    const stored = buildStoredCommandResult('script', { status: 'completed', exitCode: 0 }, undefined);
    expect('restorePoint' in stored).toBe(false);
  });

  it('does not persist an invalid outcome', () => {
    const stored = buildStoredCommandResult(
      'install_patches', { status: 'completed', exitCode: 0, restorePoint: outcome({ status: 'probably_fine' }) }, undefined,
    );
    expect('restorePoint' in stored).toBe(false);
  });
});
