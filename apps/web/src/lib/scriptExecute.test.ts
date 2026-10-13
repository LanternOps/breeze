import '@/lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionError } from './runAction';
import { describeScriptExecuteError, postScriptExecute } from './scriptExecute';
import { fetchWithAuth } from '../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../components/shared/Toast';

vi.mock('../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const t = ((key: string, opts?: Record<string, unknown>) => `${key}${opts ? JSON.stringify(opts) : ''}`) as never;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('postScriptExecute', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends deviceIds for a device run and no target', async () => {
    fetchMock.mockResolvedValue(json(201, { requestId: 'r', status: 'queued', targets: [] }));
    await postScriptExecute('s-1', ['d-1'], { a: 1 }, 'system', 'fallback');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/scripts/s-1/execute');
    expect(JSON.parse(init!.body as string)).toEqual({ deviceIds: ['d-1'], parameters: { a: 1 }, runAs: 'system' });
  });

  it('sends target and no deviceIds for a group run, and returns warnings', async () => {
    fetchMock.mockResolvedValue(json(201, { requestId: 'r', status: 'queued', targets: [], warnings: ['w1'] }));
    const result = await postScriptExecute('s-1', { type: 'groups', groupIds: ['g-1'] }, {}, 'user', 'fallback');
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.target).toEqual({ type: 'groups', groupIds: ['g-1'] });
    expect('deviceIds' in body).toBe(false);
    expect(result.warnings).toEqual(['w1']);
  });

  it('throws an ActionError carrying the structured body, without a duplicate toast', async () => {
    fetchMock.mockResolvedValue(
      json(400, { error: 'too many', code: 'TOO_MANY_TARGETS', count: 612, perGroupCounts: [{ id: 'g-1', memberCount: 612 }] }),
    );
    const err = await postScriptExecute('s-1', { type: 'groups', groupIds: ['g-1'] }, {}, 'system', 'fb').catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err.code).toBe('TOO_MANY_TARGETS');
    expect(err.status).toBe(400);
    expect((err.body as { count: number }).count).toBe(612);
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('postScriptExecute auth and trust handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('redirects to login on a 401 without a toast, and describes it with the fallback', async () => {
    fetchMock.mockResolvedValue(json(401, { error: 'Unauthorized' }));
    const err = await postScriptExecute('s-1', ['d-1'], {}, 'system', 'fb').catch((e) => e);
    expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true });
    expect(showToast).not.toHaveBeenCalled();
    expect(describeScriptExecuteError(err, t, new Map(), 'fallback-text')).toBe('fallback-text');
  });

  it('does not suppress the toast for a 403 so trust denials still surface', async () => {
    fetchMock.mockResolvedValue(json(403, { error: 'Forbidden' }));
    await postScriptExecute('s-1', ['d-1'], {}, 'system', 'fb').catch(() => undefined);
    expect(showToast).toHaveBeenCalled();
  });
});

describe('describeScriptExecuteError', () => {
  it('does not invent a count when TOO_MANY_TARGETS carries none', () => {
    const msg = describeScriptExecuteError(new ActionError('server says 612 devices', 400, 'TOO_MANY_TARGETS', {}), t, new Map(), 'fb');
    expect(msg).toBe('server says 612 devices');
  });

  const names = new Map([['g-1', 'Servers'], ['g-2', 'Laptops']]);

  it('names the resolved count and cap for TOO_MANY_TARGETS, with per-group counts', () => {
    const err = new ActionError('x', 400, 'TOO_MANY_TARGETS', {
      count: 612,
      perGroupCounts: [{ id: 'g-1', memberCount: 400 }, { id: 'g-2', memberCount: 300 }],
    });
    const message = describeScriptExecuteError(err, t, names, 'fb');
    expect(message).toContain('"count":612');
    expect(message).toContain('"max":500');
    expect(message).toContain('Servers (400)');
    expect(message).toContain('Laptops (300)');
  });

  it('renders GROUP_NOT_FOUND and NO_TARGETS with their own copy', () => {
    expect(describeScriptExecuteError(new ActionError('x', 404, 'GROUP_NOT_FOUND', { groupIds: ['g-1', 'g-9'] }), t, names, 'fb'))
      .toContain('groupNotFound');
    const none = describeScriptExecuteError(
      new ActionError('x', 400, 'NO_TARGETS', { count: 0, warnings: ['group g-1 was excluded'] }),
      t,
      names,
      'fb',
    );
    expect(none).toContain('noTargets');
    expect(none).toContain('group g-1 was excluded');
  });

  it('falls back to the error message for anything else', () => {
    expect(describeScriptExecuteError(new ActionError('boom', 500), t, names, 'fb')).toBe('boom');
    expect(describeScriptExecuteError(new Error('plain'), t, names, 'fb')).toBe('plain');
    expect(describeScriptExecuteError('weird', t, names, 'fb')).toBe('fb');
  });
});
