import { describe, expect, it } from 'vitest';
import { GATED_COMMAND_TYPES, LIFECYCLE_COMMAND_TYPES } from '../partnerTrust';
import { defaultOfflinePolicy } from '../commandOfflinePolicy';
import { CommandTypes } from '../commandTypes';
import {
  CALLER_VERIFY_COMMAND,
  readWorkstationResult,
  workstationCommandSchema,
  workstationResultSchema,
} from './workstationProtocol';

const payload = {
  verificationId: '11111111-1111-4111-8111-111111111111',
  username: 'alex',
  technicianName: 'Sam',
  orgName: 'Acme',
  actionLabel: 'reset the password',
  targetLabel: 'alex@example.com',
  reverseCode: '7319',
  choices: ['42', '17', '86'],
  timeoutMs: 120000,
};

describe('caller_verify registration', () => {
  it('is a gated, non-lifecycle, live-only command type', () => {
    expect(CALLER_VERIFY_COMMAND).toBe('caller_verify');
    expect(CommandTypes.CALLER_VERIFY).toBe('caller_verify');
    expect(GATED_COMMAND_TYPES).toContain('caller_verify');
    expect(LIFECYCLE_COMMAND_TYPES).not.toContain('caller_verify');
    // A short interactive challenge: never queue it for days.
    expect(defaultOfflinePolicy('caller_verify')).toEqual({ kind: 'reject' });
  });
});

describe('workstationCommandSchema', () => {
  it('accepts the frozen payload', () => {
    expect(workstationCommandSchema.safeParse(payload).success).toBe(true);
  });

  it.each([
    ['duplicate choices', { choices: ['42', '42', '17'] }],
    ['two choices', { choices: ['42', '17'] }],
    ['four choices', { choices: ['42', '17', '86', '11'] }],
    ['one-digit choice', { choices: ['4', '17', '86'] }],
    ['short reverse code', { reverseCode: '731' }],
    ['timeout below floor', { timeoutMs: 29999 }],
    ['timeout above ceiling', { timeoutMs: 300001 }],
    ['non-uuid verification id', { verificationId: 'v' }],
    ['empty username', { username: '' }],
  ])('rejects %s', (_label, patch) => {
    expect(workstationCommandSchema.safeParse({ ...payload, ...patch }).success).toBe(false);
  });

  it('rejects unknown fields (no approval or principal can ride the command)', () => {
    expect(workstationCommandSchema.safeParse({ ...payload, approved: true }).success).toBe(false);
  });
});

describe('readWorkstationResult', () => {
  it('reads HTTP stdout and the WS structured result alike', () => {
    const value = { delivered: true, choice: '42', principal: { uid: 0, username: 'root' } };
    expect(readWorkstationResult(JSON.stringify(value), undefined)).toEqual(value);
    expect(readWorkstationResult(undefined, value)).toEqual(value);
  });

  it('prefers stdout when both are present', () => {
    expect(readWorkstationResult(JSON.stringify({ delivered: true, choice: 'not_me' }), { delivered: true, choice: '42' }))
      .toEqual({ delivered: true, choice: 'not_me' });
  });

  it.each([
    ['malformed JSON', '{', undefined],
    ['an unknown choice', undefined, { delivered: true, choice: 'allow' }],
    ['both SID and UID', undefined, { delivered: true, choice: '42', principal: { sid: 'S-1-5-21-1', uid: 5, username: 'alex' } }],
    ['neither SID nor UID', undefined, { delivered: true, choice: '42', principal: { username: 'alex' } }],
    ['a choice on an undelivered result', undefined, { delivered: false, choice: '42', error: 'helper_outdated' }],
    ['an error on a delivered result', undefined, { delivered: true, error: 'helper_outdated' }],
    ['an unknown error code', undefined, { delivered: false, error: 'something_else' }],
    ['nothing at all', undefined, undefined],
    ['a non-object', undefined, 'not_me'],
  ])('returns null for %s', (_label, stdout, result) => {
    expect(readWorkstationResult(stdout as string | undefined, result)).toBeNull();
  });

  it('keeps UID zero', () => {
    const parsed = workstationResultSchema.parse({ delivered: true, choice: '42', principal: { uid: 0, username: 'root' } });
    expect(parsed.principal?.uid).toBe(0);
  });
});
