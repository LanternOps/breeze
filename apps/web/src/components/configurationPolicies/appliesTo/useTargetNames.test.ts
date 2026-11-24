import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));

import { targetNameKey, useTargetNames } from './useTargetNames';
import { draftFromAssignments, type StoredAssignment } from './appliesToDraft';
import type { ConfigPolicyAppliesToSummary } from '../appliesToSummary';

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SITE2 = 'c2c2c2c2-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const GROUP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const row = (id: string, level: StoredAssignment['level'], targetId: string): StoredAssignment => ({
  id, level, targetId, priority: 0, roleFilter: null, osFilter: null,
});

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('useTargetNames', () => {
  it('names from the owner and the summary first, then one by-id read per unknown target, never org-injected', async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === `/devices/${DEVICE}`) return jsonResponse({ id: DEVICE, hostname: 'pc-1', displayName: 'PC One' });
      if (url === `/device-groups/${GROUP}`) return jsonResponse({ data: { id: GROUP, name: 'Laptops' } });
      return jsonResponse({ error: 'nope' }, 404);
    });
    const rows = draftFromAssignments([
      row('1', 'organization', ORG),
      row('2', 'site', SITE),
      row('3', 'device', DEVICE),
      row('4', 'device_group', GROUP),
      row('5', 'partner', 'p'),
    ]);
    const summary: ConfigPolicyAppliesToSummary = {
      assignmentCount: 5,
      allOrganizations: true,
      childPolicyCount: 0,
      targets: [{ assignmentId: '2', level: 'site', targetId: SITE, name: 'HQ', roleFilter: null, osFilter: null }],
    };
    const owner = { kind: 'org' as const, orgId: ORG, orgName: 'Acme' };
    const { result } = renderHook(() => useTargetNames(rows, owner, summary));

    await waitFor(() => expect(result.current[targetNameKey('device_group', GROUP)]).toBe('Laptops'));
    expect(result.current[targetNameKey('organization', ORG)]).toBe('Acme');
    expect(result.current[targetNameKey('site', SITE)]).toBe('HQ');
    expect(result.current[targetNameKey('device', DEVICE)]).toBe('PC One');
    const urls = fetchWithAuth.mock.calls.map((c) => String(c[0])).sort();
    expect(urls).toEqual([`/device-groups/${GROUP}`, `/devices/${DEVICE}`]);
    for (const call of fetchWithAuth.mock.calls) expect(call[1]).toEqual({ skipOrgIdInjection: true });
  });

  it('a failed read leaves that name unknown, keeps the others, and is not repeated on a re-render', async () => {
    fetchWithAuth.mockImplementation(async (url: string) =>
      url === `/orgs/sites/${SITE2}` ? jsonResponse({ name: 'Branch' }) : jsonResponse({ error: 'boom' }, 500));
    const rows = draftFromAssignments([row('1', 'site', SITE), row('2', 'site', SITE2)]);
    const owner = { kind: 'msp' as const };
    const { result, rerender } = renderHook(({ r }) => useTargetNames(r, owner, null), { initialProps: { r: rows } });
    await waitFor(() => expect(result.current[targetNameKey('site', SITE2)]).toBe('Branch'));
    expect(result.current[targetNameKey('site', SITE)]).toBeUndefined();
    rerender({ r: [...rows] });
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });
});
