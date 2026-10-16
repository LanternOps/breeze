import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  db: null as any,
  contexts: [] as string[],
  applyDecision: vi.fn(),
  observeLogin: vi.fn(),
}));
vi.mock('../../db', () => ({
  db: new Proxy({}, { get: (_, key) => m.db[key] }),
  withSystemDbAccessContext: (fn: () => unknown, label?: string) => { m.contexts.push(`system:${label ?? ''}`); return fn(); },
}));
vi.mock('./service', () => ({ applyDecision: m.applyDecision }));
vi.mock('./subjects', () => ({ observeLogin: m.observeLogin }));

import { makeDbMock } from './testing';
import {
  decisionForResult,
  handleCallerVerifyResult,
  isCallerNotMe,
  persistCallerNotMeReceipt,
  principalForResult,
} from './workstationResult';

describe('decisionForResult', () => {
  it.each([
    [{ delivered: false, error: 'no_session_for_user' }, { kind: 'undeliverable', reason: 'no_session_for_user' }],
    [{ delivered: false, error: 'session_not_console' }, { kind: 'undeliverable', reason: 'session_not_console' }],
    [{ delivered: false, error: 'helper_outdated' }, { kind: 'undeliverable', reason: 'helper_outdated' }],
    [{ delivered: false }, { kind: 'undeliverable', reason: 'helper_outdated' }],
    [{ delivered: true, choice: 'timeout' }, { kind: 'timeout' }],
    [{ delivered: true }, { kind: 'timeout' }],
    [{ delivered: true, choice: 'not_me' }, { kind: 'not_me' }],
    [{ delivered: true, choice: '42', principal: { uid: 5, username: 'alex' } }, { kind: 'choice', value: '42' }],
  ] as const)('maps %j', (value, want) => {
    expect(decisionForResult(value as never)).toEqual(want);
  });

  it('never approves an unreadable result', () => {
    expect(decisionForResult(null)).toEqual({ kind: 'undeliverable', reason: 'invalid_result' });
    expect(decisionForResult(null, 'unknown command type: caller_verify')).toEqual({ kind: 'undeliverable', reason: 'helper_outdated' });
  });

  it('never accepts a number without a principal', () => {
    expect(decisionForResult({ delivered: true, choice: '42' } as never)).toEqual({ kind: 'undeliverable', reason: 'invalid_result' });
  });
});

describe('principalForResult', () => {
  it('namespaces a Unix uid by the persisted hostname and keeps uid 0', () => {
    expect(principalForResult({ delivered: true, choice: '42', principal: { uid: 0, username: 'root' } }, 'host'))
      .toEqual({ osPrincipal: 'uid:0@host', osUsername: 'root', upn: null });
  });
  it('uses the SID as the Windows principal and carries the OS UPN', () => {
    expect(principalForResult({ delivered: true, choice: '42', principal: { sid: 'S-1-5-21-1', username: 'alex', upn: 'alex@example.com' } }, 'host'))
      .toEqual({ osPrincipal: 'S-1-5-21-1', osUsername: 'alex', upn: 'alex@example.com' });
  });
  it('has no principal for a uid without a hostname, or for no principal', () => {
    expect(principalForResult({ delivered: true, choice: '42', principal: { uid: 5, username: 'alex' } }, null)).toBeUndefined();
    expect(principalForResult({ delivered: true, choice: 'timeout' }, 'host')).toBeUndefined();
    expect(principalForResult(null, 'host')).toBeUndefined();
  });
});

describe('isCallerNotMe', () => {
  it('detects a rejection on either transport shape only', () => {
    expect(isCallerNotMe(JSON.stringify({ delivered: true, choice: 'not_me' }), undefined)).toBe(true);
    expect(isCallerNotMe(undefined, { delivered: true, choice: 'not_me' })).toBe(true);
    expect(isCallerNotMe(undefined, { delivered: true, choice: '42', principal: { uid: 1, username: 'a' } })).toBe(false);
    expect(isCallerNotMe('not json', undefined)).toBe(false);
  });
});

const VID = '11111111-1111-4111-8111-111111111111';
const CMD = '22222222-2222-4222-8222-222222222222';
const DEV = '33333333-3333-4333-8333-333333333333';
const owned = {
  id: VID, orgId: 'org-1', contactId: 'contact-1', status: 'pending', matchValue: '42', deviceHostname: 'host',
};
const params = (stdout: string | undefined, result: Record<string, unknown> = {}) => ({
  agentId: 'agent-1', command: { id: CMD } as never, commandId: CMD, resolvedDeviceId: DEV,
  result: { status: 'completed' as const, ...result }, stdout,
});

describe('handleCallerVerifyResult', () => {
  let state: ReturnType<typeof makeDbMock>;
  beforeEach(() => {
    vi.clearAllMocks();
    m.contexts = [];
    state = makeDbMock(); m.db = state.db;
  });

  it('ignores a command it cannot tie to a workstation verification on that device', async () => {
    state.results.push([]);
    await handleCallerVerifyResult(params(JSON.stringify({ delivered: true, choice: 'not_me' })));
    expect(m.applyDecision).not.toHaveBeenCalled();
    // Ownership comes from the persisted command id and the transport's device,
    // and the device row is share-locked against a concurrent org move.
    expect(state.calls.some((c) => c.name === 'for' && c.args[0] === 'share')).toBe(true);
  });

  it('applies a matching number with the agent principal, then observes the login', async () => {
    state.results.push([owned]);
    m.applyDecision.mockResolvedValue({ status: 'verified' });
    const stdout = JSON.stringify({ delivered: true, choice: '42', principal: { sid: 'S-1-5-21-9', username: 'alex', upn: 'alex@example.com' } });
    await handleCallerVerifyResult(params(stdout));
    expect(m.applyDecision).toHaveBeenCalledWith({
      verificationId: VID, decision: { kind: 'choice', value: '42' },
      principal: { osPrincipal: 'S-1-5-21-9', osUsername: 'alex', upn: 'alex@example.com' },
    });
    expect(m.observeLogin).toHaveBeenCalledWith({
      orgId: 'org-1', contactId: 'contact-1', osPrincipal: 'S-1-5-21-9', osUsername: 'alex', upn: 'alex@example.com',
    });
    // Joins whatever context the transport already holds.
    expect(m.contexts).toEqual(['system:callerVerification.commandResult']);
  });

  it('never observes a login for a wrong number, an unverified outcome or a missing UPN', async () => {
    const stdout = (choice: string, upn?: string) => JSON.stringify({ delivered: true, choice, principal: { sid: 'S-1-5-21-9', username: 'alex', ...(upn ? { upn } : {}) } });
    state.results.push([owned], [owned], [owned]);
    m.applyDecision.mockResolvedValueOnce({ status: 'wrong_choice' });
    await handleCallerVerifyResult(params(stdout('17', 'alex@example.com')));
    m.applyDecision.mockResolvedValueOnce({ status: 'expired' });
    await handleCallerVerifyResult(params(stdout('42', 'alex@example.com')));
    m.applyDecision.mockResolvedValueOnce({ status: 'verified' });
    await handleCallerVerifyResult(params(stdout('42')));
    expect(m.observeLogin).not.toHaveBeenCalled();
  });

  it('applies a rejection from the WS structured result even after the verification left pending', async () => {
    state.results.push([{ ...owned, status: 'verified' }]);
    m.applyDecision.mockResolvedValue({ status: 'rejected_by_user' });
    await handleCallerVerifyResult(params(undefined, { result: { delivered: true, choice: 'not_me' } }));
    expect(m.applyDecision).toHaveBeenCalledWith({ verificationId: VID, decision: { kind: 'not_me' }, principal: undefined });
  });

  it('records an agent-side failure as undeliverable, never as a decision', async () => {
    state.results.push([owned], [owned]);
    m.applyDecision.mockResolvedValue({ status: 'undeliverable' });
    await handleCallerVerifyResult(params(undefined, { status: 'failed', error: 'invalid caller_verify payload' }));
    expect(m.applyDecision).toHaveBeenLastCalledWith(expect.objectContaining({ decision: { kind: 'undeliverable', reason: 'invalid_result' } }));
    await handleCallerVerifyResult(params(undefined, { status: 'failed', error: 'unknown command type: caller_verify' }));
    expect(m.applyDecision).toHaveBeenLastCalledWith(expect.objectContaining({ decision: { kind: 'undeliverable', reason: 'helper_outdated' } }));
  });
});

describe('persistCallerNotMeReceipt', () => {
  let state: ReturnType<typeof makeDbMock>;
  beforeEach(() => {
    vi.clearAllMocks();
    state = makeDbMock(); m.db = state.db;
  });

  it('never touches a command for a number, a timeout or an unreadable result', async () => {
    for (const result of [
      { delivered: true, choice: '42', principal: { uid: 1, username: 'a' } },
      { delivered: true, choice: 'timeout' },
      { delivered: true, choice: 'allow' },
    ]) {
      expect(await persistCallerNotMeReceipt({ commandId: CMD, deviceId: DEV, result })).toBe(false);
    }
    expect(state.calls.some((c) => c.name === 'update')).toBe(false);
  });

  it('merges a durable marker into the owned command row without reopening it', async () => {
    state.results.push([{ id: CMD }]);
    expect(await persistCallerNotMeReceipt({ commandId: CMD, deviceId: DEV, result: { delivered: true, choice: 'not_me' } })).toBe(true);
    const set = state.calls.find((c) => c.name === 'set')!.args[0] as Record<string, unknown>;
    expect(Object.keys(set)).toEqual(['result']);
  });

  it('reports false when the command is not this device\'s caller_verify row', async () => {
    state.results.push([]);
    expect(await persistCallerNotMeReceipt({ commandId: CMD, deviceId: DEV, result: { delivered: true, choice: 'not_me' } })).toBe(false);
  });
});
