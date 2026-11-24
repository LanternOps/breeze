import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionError } from '@/lib/runAction';
import apiSource from './appliesToApi.ts?raw';

const fetchWithAuth = vi.fn();
const showToast = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('../../shared/Toast', () => ({ showToast: (...args: unknown[]) => showToast(...args) }));

import {
  applyAssignments,
  dryRunAssignments,
  fetchAssignments,
  fetchPolicyReach,
  fetchReach,
  parseApplyFailure,
  parseApplyResult,
  parseDelta,
  parseReach,
  parseStoredAssignments,
} from './appliesToApi';

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const POLICY = '11111111-1111-4111-8111-111111111111';
const A1 = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';

// A stored assignment row as the API serializes `configPolicyAssignments.$inferSelect`.
const ROW = {
  id: A1,
  configPolicyId: POLICY,
  level: 'organization',
  targetId: ORG,
  priority: 0,
  roleFilter: null,
  osFilter: ['windows'],
  createdAt: '2026-11-21T00:00:00.000Z',
  createdBy: null,
};

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
});

describe('wire parsers', () => {
  it('parseStoredAssignments keeps well-formed rows and drops malformed ones', () => {
    expect(parseStoredAssignments({ data: [ROW, { id: 7 }, { ...ROW, id: 'x', level: 'galaxy' }] })).toEqual([
      { id: A1, level: 'organization', targetId: ORG, priority: 0, roleFilter: null, osFilter: ['windows'] },
    ]);
    expect(parseStoredAssignments({})).toBeNull();
    expect(parseStoredAssignments(null)).toBeNull();
  });

  it('parseReach reads the three counts and keeps partial', () => {
    expect(parseReach({ direct: 12, throughChildren: 3, organizations: 2 })).toEqual({
      direct: 12, throughChildren: 3, organizations: 2,
    });
    expect(parseReach({ direct: 12, throughChildren: 0, organizations: 2, partial: true })).toEqual({
      direct: 12, throughChildren: 0, organizations: 2, partial: true,
    });
    expect(parseReach({ direct: -1, throughChildren: 0, organizations: 0 })).toBeNull();
    expect(parseReach({ direct: 1 })).toBeNull();
    expect(parseReach('12')).toBeNull();
  });

  it('parseDelta reads added and removed and keeps partial', () => {
    expect(parseDelta({ dryRun: true, delta: { added: 4, removed: 1 } })).toEqual({ added: 4, removed: 1 });
    expect(parseDelta({ dryRun: true, delta: { added: 4, removed: 1, partial: true } })).toEqual({
      added: 4, removed: 1, partial: true,
    });
    expect(parseDelta({ dryRun: true, delta: { added: '4', removed: 1 } })).toBeNull();
    expect(parseDelta({ added: 4, removed: 1 })).toBeNull();
  });

  it('parseApplyResult counts the row arrays the API returns', () => {
    expect(parseApplyResult({ added: [ROW, ROW], updated: [ROW], removed: [] })).toEqual({ added: 2, updated: 1, removed: 0 });
    expect(parseApplyResult({ added: 2, updated: 1, removed: 0 })).toBeNull();
  });

  it('parseApplyFailure reads a conflict, an entry ref and a plain refusal', () => {
    expect(parseApplyFailure({
      error: 'assignment_conflict',
      message: 'This policy is already assigned to this target at this level',
      entry: { op: 'add', index: 1 },
    })).toEqual({
      conflict: true,
      message: 'This policy is already assigned to this target at this level',
      entry: { op: 'add', index: 1 },
    });
    expect(parseApplyFailure({ error: 'Assignment not found', entry: { op: 'remove', index: 0 } })).toEqual({
      conflict: false, message: 'Assignment not found', entry: { op: 'remove', index: 0 },
    });
    expect(parseApplyFailure({ error: 'Vendor updates need execute', code: 'oem_updates_execute_required' })).toEqual({
      conflict: false, message: 'Vendor updates need execute',
    });
    expect(parseApplyFailure({ error: 'x', entry: { op: 'move', index: 0 } })).toEqual({ conflict: false, message: 'x' });
    expect(parseApplyFailure(null)).toEqual({ conflict: false });
  });
});

describe('client', () => {
  it('fetchAssignments reads the policy rows', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ data: [ROW] }));
    await expect(fetchAssignments(POLICY)).resolves.toHaveLength(1);
    expect(fetchWithAuth).toHaveBeenCalledWith(`/configuration-policies/${POLICY}/assignments`);
  });

  it('applyAssignments goes through runAction', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ added: [ROW], updated: [], removed: [] }, 201));
    await expect(applyAssignments(POLICY, { add: [{ level: 'organization', targetId: ORG, priority: 0 }], update: [], remove: [] }))
      .resolves.toEqual({ added: 1, updated: 0, removed: 0 });
    const [url, init] = fetchWithAuth.mock.calls[0]!;
    expect(url).toBe(`/configuration-policies/${POLICY}/assignments/apply`);
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).not.toHaveProperty('dryRun');
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('applyAssignments toasts a refusal and throws it with its body', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ error: 'Vendor updates need execute', code: 'oem_updates_execute_required' }, 403));
    const err = await applyAssignments(POLICY, { add: [], update: [], remove: [A1] }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).status).toBe(403);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('applyAssignments leaves a conflict to the caller: no toast, the body on the error', async () => {
    const body = { error: 'assignment_conflict', message: 'The assignments changed', entry: { op: 'remove', index: 0 } };
    fetchWithAuth.mockResolvedValueOnce(jsonResponse(body, 409));
    const err = await applyAssignments(POLICY, { add: [], update: [], remove: [A1] }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).body).toEqual(body);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('dryRunAssignments carries the runaction-exempt marker and does not toast', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ dryRun: true, delta: { added: 3, removed: 0 } }));
    await expect(dryRunAssignments(POLICY, { add: [], update: [], remove: [A1] })).resolves.toEqual({
      ok: true, delta: { added: 3, removed: 0 },
    });
    expect(JSON.parse(String((fetchWithAuth.mock.calls[0]![1] as RequestInit).body)).dryRun).toBe(true);

    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ error: 'assignment_conflict', message: 'dup', entry: { op: 'add', index: 0 } }, 409));
    await expect(dryRunAssignments(POLICY, { add: [], update: [], remove: [A1] })).resolves.toEqual({
      ok: false, status: 409, failure: { conflict: true, message: 'dup', entry: { op: 'add', index: 0 } },
    });
    fetchWithAuth.mockRejectedValueOnce(new Error('offline'));
    await expect(dryRunAssignments(POLICY, { add: [], update: [], remove: [A1] })).resolves.toEqual({
      ok: false, status: 0, failure: { conflict: false },
    });
    expect(showToast).not.toHaveBeenCalled();

    expect(apiSource).toMatch(/\/\/ runaction-exempt: [^\n]{20,}\n[^\n]*fetchWithAuth\(/);
  });

  it('fetchReach batches ids and treats an absent id as unknown', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`);
    fetchWithAuth.mockImplementation(async (url: string) => {
      const asked = new URL(url, 'http://x').searchParams.get('ids')!.split(',');
      return jsonResponse({ data: Object.fromEntries(asked.slice(1).map((id) => [id, { direct: 1, throughChildren: 0, organizations: 1 }])) });
    });
    const reach = await fetchReach(ids);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(Object.keys(reach)).toHaveLength(148);
    expect(reach[ids[0]!]).toBeUndefined();
  });

  it('fetchReach throws on a failed read', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 500));
    await expect(fetchReach([POLICY])).rejects.toThrow();
  });

  it('fetchPolicyReach returns null for a malformed body', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ direct: 'many' }));
    await expect(fetchPolicyReach(POLICY)).resolves.toBeNull();
    expect(fetchWithAuth).toHaveBeenCalledWith(`/configuration-policies/${POLICY}/reach`);
  });
});
