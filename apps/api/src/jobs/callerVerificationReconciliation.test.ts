import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  pages: [] as unknown[][],
  contexts: [] as string[],
  handle: vi.fn(),
  capture: vi.fn(),
}));
vi.mock('../db', () => {
  const chain: any = {};
  for (const k of ['select', 'from', 'innerJoin', 'where', 'orderBy', 'limit']) chain[k] = () => chain;
  chain.then = (yes: (v: unknown) => unknown, no: (e: unknown) => unknown) => Promise.resolve(m.pages.shift() ?? []).then(yes, no);
  return {
    db: chain,
    runOutsideDbContext: (fn: () => unknown) => { m.contexts.push('outside'); return fn(); },
    withSystemDbAccessContext: (fn: () => unknown, label?: string) => { m.contexts.push(`system:${label}`); return fn(); },
  };
});
vi.mock('../services/callerVerification/workstationResult', () => ({
  NOT_ME_RECEIPT_KEY: 'callerVerificationNotMe',
  handleCallerVerifyResult: m.handle,
}));
vi.mock('../services/sentry', () => ({ captureException: m.capture }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import { reconcileCallerVerifications, reconciliationInput } from './callerVerificationReconciliation';

const command = (over: Record<string, unknown> = {}) => ({
  id: 'cmd-1', deviceId: 'device-1', type: 'caller_verify', status: 'completed',
  result: { status: 'completed', stdout: '{"delivered":true,"choice":"42"}' }, ...over,
});

describe('reconciliationInput', () => {
  it('replays a terminal command result for a still-pending verification', () => {
    expect(reconciliationInput('pending', command() as never)).toEqual({
      result: { status: 'completed', result: undefined, error: undefined },
      stdout: '{"delivered":true,"choice":"42"}',
    });
  });

  it('replays a durable rejection receipt from any non-rejected status', () => {
    for (const status of ['pending', 'verified', 'wrong_choice', 'expired', 'revoked', 'cancelled', 'undeliverable']) {
      const input = reconciliationInput(status, command({ result: { status: 'completed', stdout: '{"delivered":true,"choice":"42"}', callerVerificationNotMe: true } }) as never);
      expect(input).toEqual({ result: { status: 'completed', result: { delivered: true, choice: 'not_me' } }, stdout: undefined });
    }
  });

  it('skips work that is not owed', () => {
    expect(reconciliationInput('rejected_by_user', command({ result: { callerVerificationNotMe: true } }) as never)).toBeNull();
    expect(reconciliationInput('verified', command() as never)).toBeNull();
    // A command still in flight is the agent's to answer; expiry is the publisher's.
    expect(reconciliationInput('pending', command({ status: 'sent', result: null }) as never)).toBeNull();
    expect(reconciliationInput('pending', command({ status: 'pending', result: null }) as never)).toBeNull();
  });

  it('reads a server-side command timeout as the challenge expiring', () => {
    expect(reconciliationInput('pending', command({ status: 'failed', result: { status: 'timeout', error: 'no response from agent' } }) as never))
      .toEqual({ result: { status: 'completed', result: { delivered: true, choice: 'timeout' } }, stdout: undefined });
  });

  it('reports a failed or cancelled command as a failed result (never an approval)', () => {
    expect(reconciliationInput('pending', command({ status: 'cancelled', result: { reason: 'org_moved' } }) as never))
      .toEqual({ result: { status: 'failed', result: undefined, error: undefined }, stdout: undefined });
  });
});

describe('reconcileCallerVerifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.pages = []; m.contexts = [];
  });

  it('pages through candidates and calls the shared handler once per owed row, each in its own context', async () => {
    m.pages.push(
      [
        { id: 'v1', status: 'pending', command: command() },
        { id: 'v2', status: 'verified', command: command({ id: 'cmd-2', result: { callerVerificationNotMe: true } }) },
        { id: 'v3', status: 'verified', command: command({ id: 'cmd-3' }) },
      ],
      [],
    );
    await reconcileCallerVerifications();
    expect(m.handle).toHaveBeenCalledTimes(2);
    expect(m.handle).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'cmd-1', resolvedDeviceId: 'device-1', agentId: 'reconciler' }));
    expect(m.handle).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'cmd-2', result: { status: 'completed', result: { delivered: true, choice: 'not_me' } } }));
    expect(m.contexts.filter((c) => c === 'system:callerVerification.reconcile.row')).toHaveLength(2);
  });

  it('isolates a failing row and keeps going', async () => {
    m.pages.push([
      { id: 'v1', status: 'pending', command: command() },
      { id: 'v2', status: 'pending', command: command({ id: 'cmd-2' }) },
    ], []);
    m.handle.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);
    await reconcileCallerVerifications();
    expect(m.handle).toHaveBeenCalledTimes(2);
    expect(m.capture).toHaveBeenCalledTimes(1);
  });
});
