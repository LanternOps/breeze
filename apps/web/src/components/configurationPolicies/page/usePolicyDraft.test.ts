import { act, renderHook } from '@testing-library/react';
import '@/lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    claims: { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } } as unknown,
    user: { canManagePartnerWide: true } as Record<string, unknown> | null,
    currentOrgId: 'org-a' as string | null,
  },
}));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => state.claims }));
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: { user: unknown }) => unknown) => sel({ user: state.user }),
}));
vi.mock('../../../stores/orgStore', () => ({
  useOrgStore: (sel: (s: { currentOrgId: string | null }) => unknown) => sel({ currentOrgId: state.currentOrgId }),
}));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { usePolicyDraft } from './usePolicyDraft';
import { fetchWithAuth } from '../../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);
const created = (extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ id: 'new-1', name: 'Workstations', status: 'inactive', orgId: null, partnerId: 'p-1', parentPolicyId: null, ...extra }), { status: 201 });
const postBodies = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

beforeEach(() => {
  fetchMock.mockReset();
  state.claims = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
  state.user = { canManagePartnerWide: true };
  state.currentOrgId = 'org-a';
});

describe('usePolicyDraft', () => {
  it('creates once: a second call, made while the first is in flight, reuses it', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((r) => { resolve = r; }));
    const onCreated = vi.fn();
    const { result } = renderHook(() => usePolicyDraft({ enabled: true, onCreated }));
    act(() => result.current.setName('Workstations'));
    let a!: Promise<unknown>;
    let b!: Promise<unknown>;
    act(() => {
      a = result.current.ensurePolicy();
      b = result.current.ensurePolicy();
    });
    await act(async () => {
      resolve(created());
      await Promise.all([a, b]);
    });
    expect(await a).toEqual({ ok: true, id: 'new-1', created: true });
    expect(await b).toEqual({ ok: true, id: 'new-1', created: true });
    let c: unknown;
    await act(async () => { c = await result.current.ensurePolicy(); });
    expect(c).toEqual({ ok: true, id: 'new-1', created: false });
    expect(postBodies()).toHaveLength(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('sends status inactive, the MSP owner for a full-access partner, and the parent', async () => {
    fetchMock.mockResolvedValue(created());
    const { result } = renderHook(() => usePolicyDraft({ enabled: true, onCreated: vi.fn() }));
    act(() => {
      result.current.setName('  Workstations ');
      result.current.setParent({ id: '00000000-0000-4000-8000-0000000000p1'.replace('p', 'a'), name: 'Baseline' });
    });
    await act(async () => { await result.current.ensurePolicy(); });
    expect(postBodies()[0]).toEqual({
      name: 'Workstations',
      status: 'inactive',
      ownerScope: 'partner',
      parentPolicyId: '00000000-0000-4000-8000-0000000000a1',
    });
  });

  it('a name is required: nothing is sent and the name error is set', async () => {
    const { result } = renderHook(() => usePolicyDraft({ enabled: true, onCreated: vi.fn() }));
    let out: unknown;
    await act(async () => { out = await result.current.ensurePolicy(); });
    expect(out).toEqual({ ok: false, message: expect.any(String) });
    expect(result.current.nameError).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a limited partner defaults to the switcher org and never sends ownerScope partner', async () => {
    state.user = { canManagePartnerWide: false };
    fetchMock.mockResolvedValue(created({ orgId: 'org-a' }));
    const { result } = renderHook(() => usePolicyDraft({ enabled: true, onCreated: vi.fn() }));
    expect(result.current.draft.owner).toEqual({ kind: 'org', orgId: 'org-a' });
    // Even if something asks for MSP-managed, it is not kept.
    act(() => result.current.setOwner({ kind: 'msp' }));
    expect(result.current.draft.owner).toEqual({ kind: 'org', orgId: 'org-a' });
    act(() => result.current.setName('Front desk'));
    await act(async () => { await result.current.ensurePolicy(); });
    expect(postBodies()[0]).toEqual({ name: 'Front desk', status: 'inactive', orgId: 'org-a' });
  });

  it('a limited partner with no org selected must choose one first', async () => {
    state.user = { canManagePartnerWide: false };
    state.currentOrgId = null;
    const { result } = renderHook(() => usePolicyDraft({ enabled: true, onCreated: vi.fn() }));
    act(() => result.current.setName('Front desk'));
    let out: unknown;
    await act(async () => { out = await result.current.ensurePolicy(); });
    expect(out).toEqual({ ok: false, message: expect.any(String) });
    expect(result.current.ownerError).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an org-scope user gets their own org', async () => {
    state.claims = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-own', partnerId: null } };
    state.user = { canManagePartnerWide: true };
    state.currentOrgId = 'org-own';
    fetchMock.mockResolvedValue(created({ orgId: 'org-own' }));
    const { result } = renderHook(() => usePolicyDraft({ enabled: true, onCreated: vi.fn() }));
    expect(result.current.draft.owner).toEqual({ kind: 'org', orgId: 'org-own' });
    act(() => result.current.setName('Ours'));
    await act(async () => { await result.current.ensurePolicy(); });
    expect(postBodies()[0]).toEqual({ name: 'Ours', status: 'inactive', orgId: 'org-own' });
  });

  it('the default is re-evaluated when full access resolves, unless the user chose an owner', () => {
    state.user = { canManagePartnerWide: undefined };
    const { result, rerender } = renderHook(() => usePolicyDraft({ enabled: true, onCreated: vi.fn() }));
    expect(result.current.draft.owner).toEqual({ kind: 'org', orgId: 'org-a' });
    state.user = { canManagePartnerWide: true };
    rerender();
    expect(result.current.draft.owner).toEqual({ kind: 'msp' });

    state.user = { canManagePartnerWide: undefined };
    const second = renderHook(() => usePolicyDraft({ enabled: true, onCreated: vi.fn() }));
    act(() => second.result.current.setOwner({ kind: 'org', orgId: 'org-b' }));
    state.user = { canManagePartnerWide: true };
    second.rerender();
    expect(second.result.current.draft.owner).toEqual({ kind: 'org', orgId: 'org-b' });
  });

  it('owner and parent cannot change after the create', async () => {
    fetchMock.mockResolvedValue(created());
    const { result } = renderHook(() => usePolicyDraft({ enabled: true, onCreated: vi.fn() }));
    act(() => result.current.setName('Workstations'));
    await act(async () => { await result.current.ensurePolicy(); });
    act(() => {
      result.current.setOwner({ kind: 'org', orgId: 'org-a' });
      result.current.setParent({ id: 'x', name: 'X' });
    });
    expect(result.current.draft.owner).toEqual({ kind: 'msp' });
    expect(result.current.draft.parent).toBeNull();
  });

  it('shows the human message for an invalid parent, and a retry after a failure can create', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'INVALID_PARENT_POLICY', message: 'That policy cannot be a parent here.' }), { status: 400 }),
    );
    const { result } = renderHook(() => usePolicyDraft({ enabled: true, onCreated: vi.fn() }));
    act(() => result.current.setName('Workstations'));
    let out: unknown;
    await act(async () => { out = await result.current.ensurePolicy(); });
    expect(out).toEqual({ ok: false, message: 'That policy cannot be a parent here.' });
    fetchMock.mockResolvedValueOnce(created());
    await act(async () => { out = await result.current.ensurePolicy(); });
    expect(out).toEqual({ ok: true, id: 'new-1', created: true });
  });
});
