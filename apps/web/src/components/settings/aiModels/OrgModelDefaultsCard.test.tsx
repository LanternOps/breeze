import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AiAssignmentRowDto, AiOrgModelDefaultsDto, AiOrgSurfaceDefaultsDto, AiSurface } from '@breeze/shared';
import { jsonRes } from './testFixtures';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { navigateTo } from '@/lib/navigation';
import OrgModelDefaultsCard from './OrgModelDefaultsCard';

const ORG = '99999999-9999-4999-8999-999999999999';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const T = '2026-10-01T00:00:00.000Z';

const SUPPORT = { effort: ['low', 'medium', 'high', 'xhigh', 'max'], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard', 'fast'], inferenceGeo: [] } as const;
const offering = (id: string, name: string) => ({
  id, displayName: name, funding: 'platform' as const, supportsTools: true, optionSupport: SUPPORT as unknown as never,
  rates: null, requiredPermission: null,
});

type SurfaceOver = { inherited?: Partial<AiOrgSurfaceDefaultsDto['inherited']>; org?: AiAssignmentRowDto | null; effective?: Partial<AiOrgSurfaceDefaultsDto['effective']> };

function surface(s: AiSurface, over: SurfaceOver = {}): AiOrgSurfaceDefaultsDto {
  const inherited = { defaultOfferingId: A, permittedOfferingIds: null, allowUserChoice: true, options: {}, ...over.inherited };
  const org = over.org ?? null;
  return {
    surface: s, requiresTools: false, inherited, org,
    effective: { defaultOfferingId: org?.defaultOfferingId ?? inherited.defaultOfferingId, defaultSource: org?.defaultOfferingId ? 'org' : 'partner', permittedOfferingIds: null, allowUserChoice: true, options: {}, ...over.effective },
  };
}

function orgDefaults(over: { chat?: SurfaceOver; canEdit?: boolean; canEditReviewer?: boolean } = {}): AiOrgModelDefaultsDto {
  return {
    orgId: ORG,
    offerings: [offering(A, 'Model A'), offering(B, 'Model B'), offering(C, 'Model C')],
    surfaces: [surface('chat', over.chat), surface('script_reviewer')],
    canEdit: over.canEdit ?? true,
    canEditReviewer: over.canEditReviewer ?? true,
  };
}

const values = (testId: string) => [...(screen.getByTestId(testId) as HTMLSelectElement).options].map((o) => o.value);

beforeEach(() => { fetchWithAuth.mockReset(); showToast.mockReset(); });

describe('OrgModelDefaultsCard', () => {
  it('shows the inherited value and its source on every row', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes(orgDefaults()));
    render(<OrgModelDefaultsCard orgId={ORG} />);
    expect((await screen.findByTestId('org-model-defaults-inherited-chat')).textContent).toMatch(/Model A.*partner default/);
    expect(screen.getByTestId('org-model-defaults-effective-chat').textContent).toMatch(/Model A.*Partner default/);
    expect(fetchWithAuth.mock.calls[0][0]).toBe(`/ai/models/orgs/${ORG}/assignments`);
    const first = (screen.getByTestId('org-model-defaults-default-chat') as HTMLSelectElement).options[0].textContent;
    expect(first).toBe('Inherit — Model A (partner default)');
  });

  it('offers only partner-permitted models and only lower efforts (tighten-only)', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes(orgDefaults({ chat: { inherited: { permittedOfferingIds: [A, B], options: { effort: 'medium' } } } })));
    render(<OrgModelDefaultsCard orgId={ORG} />);
    await screen.findByTestId('org-model-defaults-row-chat');
    fireEvent.change(screen.getByTestId('org-model-defaults-permitted-mode-chat'), { target: { value: 'list' } });
    expect(screen.getByTestId(`org-model-defaults-permitted-chat-${A}`)).toBeTruthy();
    expect(screen.queryByTestId(`org-model-defaults-permitted-chat-${C}`)).toBeNull();
    expect(values('org-model-defaults-default-chat')).toEqual(['', A, B]);
    expect(values('org-model-defaults-effort-chat')).toEqual(['', 'low', 'medium']);
  });

  it('offers fast only when the partner already allows it', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes(orgDefaults()));
    render(<OrgModelDefaultsCard orgId={ORG} />);
    await screen.findByTestId('org-model-defaults-row-chat');
    expect(values('org-model-defaults-speed-chat')).toEqual(['', 'standard']);
  });

  it('resetting a row to inherit sends an all-null row', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes(orgDefaults({ chat: { org: { surface: 'chat', role: 'default', defaultOfferingId: B, permittedOfferingIds: null, allowUserChoice: null, options: null, updatedAt: T } } })))
      .mockResolvedValueOnce(jsonRes({ assignments: [] }))
      .mockResolvedValueOnce(jsonRes(orgDefaults()));
    render(<OrgModelDefaultsCard orgId={ORG} />);
    fireEvent.change(await screen.findByTestId('org-model-defaults-default-chat'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('org-model-defaults-save'));
    await waitFor(() => expect(JSON.parse(fetchWithAuth.mock.calls[1][1].body)).toEqual({ assignments: [{
      surface: 'chat', role: 'default', defaultOfferingId: null, permittedOfferingIds: null, allowUserChoice: null, options: null, expectedUpdatedAt: T,
    }] }));
    expect(fetchWithAuth.mock.calls[1][0]).toBe(`/ai/models/orgs/${ORG}/assignments`);
    expect(fetchWithAuth.mock.calls[1][1].method).toBe('PUT');
  });

  it('is read-only without canEdit, and the reviewer row without canEditReviewer', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes(orgDefaults({ canEdit: true, canEditReviewer: false })));
    render(<OrgModelDefaultsCard orgId={ORG} />);
    expect(((await screen.findByTestId('org-model-defaults-default-script_reviewer')) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByTestId('org-model-defaults-default-chat') as HTMLSelectElement).disabled).toBe(false);
    expect(screen.queryByTestId('org-model-defaults-readonly')).toBeNull();
  });

  it('shows the read-only notice and disables everything when canEdit is false', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes(orgDefaults({ canEdit: false })));
    render(<OrgModelDefaultsCard orgId={ORG} />);
    expect(await screen.findByTestId('org-model-defaults-readonly')).toBeTruthy();
    expect((screen.getByTestId('org-model-defaults-default-chat') as HTMLSelectElement).disabled).toBe(true);
  });

  it('the lock is disabled when the partner already locks user choice', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes(orgDefaults({ chat: { inherited: { allowUserChoice: false } } })));
    render(<OrgModelDefaultsCard orgId={ORG} />);
    const lock = (await screen.findByTestId('org-model-defaults-lock-choice-chat')) as HTMLInputElement;
    expect(lock.disabled).toBe(true);
    expect(lock.checked).toBe(true);
    expect(screen.getByText('Locked by the partner')).toBeTruthy();
  });

  it('renders nothing when the org is forbidden or unknown', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'forbidden' }, 403));
    const { container } = render(<OrgModelDefaultsCard orgId={ORG} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('shows the load-failed state on a 500 and logs the status', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'x' }, 500));
    render(<OrgModelDefaultsCard orgId={ORG} />);
    expect((await screen.findByTestId('org-model-defaults-card')).textContent).toMatch(/\S/);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('OrgModelDefaultsCard'), expect.objectContaining({ message: '500' }));
    log.mockRestore();
  });

  it('routes a 401 load to login', async () => {
    vi.mocked(navigateTo).mockClear();
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'x' }, 401));
    const { container } = render(<OrgModelDefaultsCard orgId={ORG} />);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true }));
    expect(container.textContent).toBe('');
  });

  it('flags narrowing that drops the inherited default before Save', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes(orgDefaults({ chat: { inherited: { permittedOfferingIds: [A, B] } } })));
    render(<OrgModelDefaultsCard orgId={ORG} />);
    await screen.findByTestId('org-model-defaults-row-chat');
    fireEvent.change(screen.getByTestId('org-model-defaults-permitted-mode-chat'), { target: { value: 'list' } });
    fireEvent.click(screen.getByTestId(`org-model-defaults-permitted-chat-${B}`));
    expect(screen.getByTestId('org-model-defaults-pick-default-chat')).toBeTruthy();
    expect((screen.getByTestId('org-model-defaults-default-chat') as HTMLSelectElement).getAttribute('aria-invalid')).toBe('true');
    // Picking a default clears the prompt.
    fireEvent.change(screen.getByTestId('org-model-defaults-default-chat'), { target: { value: B } });
    expect(screen.queryByTestId('org-model-defaults-pick-default-chat')).toBeNull();
  });

  it('the inherited_default_not_permitted 422 alone raises the pick-a-default prompt', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes(orgDefaults()))
      .mockResolvedValueOnce(jsonRes({
        error: 'An organization can only narrow the partner’s defaults.', code: 'widens_partner',
        details: { surface: 'chat', field: 'defaultOfferingId', reason: 'inherited_default_not_permitted' },
      }, 422));
    render(<OrgModelDefaultsCard orgId={ORG} />);
    await screen.findByTestId('org-model-defaults-row-chat');
    // A draft the client-side check does not flag: only the server can raise the prompt.
    fireEvent.change(screen.getByTestId('org-model-defaults-effort-chat'), { target: { value: 'low' } });
    expect(screen.queryByTestId('org-model-defaults-pick-default-chat')).toBeNull();
    fireEvent.click(screen.getByTestId('org-model-defaults-save'));
    expect(await screen.findByTestId('org-model-defaults-pick-default-chat')).toBeTruthy();
    expect((screen.getByTestId('org-model-defaults-default-chat') as HTMLSelectElement).getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByTestId('org-model-defaults-field-error-chat')).toBeNull();
  });

  it('labels each option select with the inherited value', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes(orgDefaults({ chat: { inherited: { options: { effort: 'medium', thinkingDisplay: 'summarized', speed: 'fast' } } } })));
    render(<OrgModelDefaultsCard orgId={ORG} />);
    await screen.findByTestId('org-model-defaults-row-chat');
    const first = (id: string) => (screen.getByTestId(id) as HTMLSelectElement).options[0].textContent;
    expect(first('org-model-defaults-effort-chat')).toBe('Inherit — Medium');
    expect(first('org-model-defaults-display-chat')).toBe('Inherit — Summarized');
    expect(first('org-model-defaults-speed-chat')).toBe('Inherit — Fast');
  });

  it('shows a widens_partner 422 on the field the API named', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes(orgDefaults({ chat: { inherited: { options: { effort: 'high' } } } })))
      .mockResolvedValueOnce(jsonRes({ error: 'An organization can only narrow the partner’s defaults.', code: 'widens_partner', details: { surface: 'chat', field: 'options', key: 'effort' } }, 422));
    render(<OrgModelDefaultsCard orgId={ORG} />);
    await screen.findByTestId('org-model-defaults-row-chat');
    fireEvent.change(screen.getByTestId('org-model-defaults-effort-chat'), { target: { value: 'low' } });
    fireEvent.click(screen.getByTestId('org-model-defaults-save'));
    expect(await screen.findByTestId('org-model-defaults-field-error-chat')).toBeTruthy();
    expect(screen.getByTestId('org-model-defaults-effort-chat').getAttribute('aria-invalid')).toBe('true');
  });

  describe('stored ids that are no longer available', () => {
    // D was stored on the override but is no longer an enabled offering (absent from dto.offerings).
    const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const orgRow = (over: Partial<AiAssignmentRowDto>): AiAssignmentRowDto => ({
      surface: 'chat', role: 'default', defaultOfferingId: null, permittedOfferingIds: null, allowUserChoice: null, options: null, updatedAt: T, ...over,
    });

    it('renders a stored permitted id that is no longer offered as a checked "unavailable" entry that can be unticked', async () => {
      fetchWithAuth
        .mockResolvedValueOnce(jsonRes(orgDefaults({ chat: { org: orgRow({ permittedOfferingIds: [A, D] }) } })))
        .mockResolvedValueOnce(jsonRes({ assignments: [] }))
        .mockResolvedValueOnce(jsonRes(orgDefaults()));
      render(<OrgModelDefaultsCard orgId={ORG} />);
      const box = (await screen.findByTestId(`org-model-defaults-permitted-chat-${D}`)) as HTMLInputElement;
      expect(box.checked).toBe(true);
      expect(box.closest('label')?.textContent).toMatch(/unavailable/i);
      fireEvent.click(box);
      expect((screen.getByTestId(`org-model-defaults-permitted-chat-${D}`) as HTMLInputElement).checked).toBe(false);
      fireEvent.click(screen.getByTestId('org-model-defaults-save'));
      await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
      expect(JSON.parse(fetchWithAuth.mock.calls[1][1].body).assignments[0].permittedOfferingIds).toEqual([A]);
    });

    it('shows a stored org default that is no longer offered as unavailable, not as inherit', async () => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes(orgDefaults({ chat: { org: orgRow({ defaultOfferingId: D }) } })));
      render(<OrgModelDefaultsCard orgId={ORG} />);
      const select = (await screen.findByTestId('org-model-defaults-default-chat')) as HTMLSelectElement;
      expect(select.value).toBe(D);
      expect(select.selectedOptions[0]?.textContent).toMatch(/unavailable/i);
    });
  });

  it('discard restores the loaded values', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes(orgDefaults()));
    render(<OrgModelDefaultsCard orgId={ORG} />);
    fireEvent.change(await screen.findByTestId('org-model-defaults-default-chat'), { target: { value: B } });
    fireEvent.click(screen.getByTestId('org-model-defaults-discard'));
    expect((screen.getByTestId('org-model-defaults-default-chat') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByTestId('org-model-defaults-save')).toBeNull();
  });
});
