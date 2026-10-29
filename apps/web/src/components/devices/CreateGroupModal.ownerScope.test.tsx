import '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CreateGroupModal from './CreateGroupModal';
import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '../shared/Toast';
import { i18n } from '@/lib/i18n';

const state = vi.hoisted(() => ({ partner: true, wide: true as boolean | undefined, defaultScope: 'organization' as 'organization' | 'partner' }));
vi.mock('@/hooks/useDefaultOwnerScope', () => ({ useDefaultOwnerScope: () => ({ isPartnerScope: state.partner, defaultOwnerScope: state.defaultScope }) }));
vi.mock('@/lib/authScope', () => ({ getJwtClaims: () => ({ scope: state.partner ? 'partner' : 'organization' }) }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { canManagePartnerWide: state.wide } }) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../filters/useDeviceFilterFields', () => ({ useDeviceFilterFields: () => [] }));
vi.mock('../filters/FilterBuilder', () => ({ FilterBuilder: () => <div data-testid="filter-builder" /> }));
const mockFetch = vi.mocked(fetchWithAuth);
beforeEach(() => {
  vi.clearAllMocks(); state.partner = true; state.wide = true; state.defaultScope = 'organization';
  mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: { id: 'group-1' } }), { status: 201 }));
});

describe('CreateGroupModal owner scope', () => {
  it('creates a dynamic partner group without organization fields and toasts success', async () => {
    const user = userEvent.setup(); const onCreated = vi.fn();
    render(<CreateGroupModal isOpen onClose={vi.fn()} onCreated={onCreated} />);
    expect(screen.getByTestId('group-owner-scope')).toBeInTheDocument();
    await user.click(screen.getByTestId('group-owner-scope-partner'));
    expect(screen.queryByRole('button', { name: 'Static' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dynamic' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'All servers');
    await user.click(screen.getByRole('button', { name: 'Create Group' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('group-1', 'partner'));
    const body = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    expect(body).toEqual({ ownerScope: 'partner', name: 'All servers', type: 'dynamic', filterConditions: { operator: 'AND', conditions: [{ field: 'hostname', operator: 'contains', value: '' }] } });
    expect(showToast).toHaveBeenCalledWith({ type: 'success', message: 'Device group created' });
  });
  it.each(['restricted partner', 'organization'])('hides owner selector for %s', (kind) => {
    state.partner = kind !== 'organization'; state.wide = kind === 'organization';
    render(<CreateGroupModal isOpen onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.queryByTestId('group-owner-scope')).not.toBeInTheDocument();
  });
  it('shows the owner selector when partner-wide capability is absent', () => {
    state.wide = undefined;
    render(<CreateGroupModal isOpen onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByTestId('group-owner-scope')).toBeInTheDocument();
  });
  it('shows one error toast and an inline error without success when the response has no id', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 201 }));
    const user = userEvent.setup(); const onCreated = vi.fn();
    render(<CreateGroupModal isOpen onClose={vi.fn()} onCreated={onCreated} />);
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Servers');
    await user.click(screen.getByRole('button', { name: 'Create Group' }));
    expect(await screen.findByText(i18n.t('devices:createGroupModal.failedToCreateGroup'))).toBeInTheDocument();
    expect(showToast).toHaveBeenCalledExactlyOnceWith({ type: 'error', message: i18n.t('devices:createGroupModal.failedToCreateGroup') });
    expect(onCreated).not.toHaveBeenCalled();
  });
  it('uses the latest ambient default when a mounted closed modal opens', () => {
    const props = { onClose: vi.fn(), onCreated: vi.fn() };
    const { rerender } = render(<CreateGroupModal {...props} isOpen={false} />);
    state.defaultScope = 'partner';
    rerender(<CreateGroupModal {...props} isOpen={false} />);
    rerender(<CreateGroupModal {...props} isOpen />);
    expect(screen.getByTestId('group-owner-scope-partner')).toBeChecked();
    rerender(<CreateGroupModal {...props} isOpen={false} />);
    state.defaultScope = 'organization';
    rerender(<CreateGroupModal {...props} isOpen={false} />);
    rerender(<CreateGroupModal {...props} isOpen />);
    expect(screen.getByTestId('group-owner-scope-organization')).toBeChecked();
  });
  it('toasts the localized API error code', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ code: 'PARTNER_GROUP_FILTER_UNSUPPORTED', error: 'raw API error' }), { status: 400 }));
    const user = userEvent.setup();
    render(<CreateGroupModal isOpen onClose={vi.fn()} onCreated={vi.fn()} />);
    await user.click(screen.getByTestId('group-owner-scope-partner'));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'All servers');
    await user.click(screen.getByRole('button', { name: 'Create Group' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'error', message: i18n.t('errors:PARTNER_GROUP_FILTER_UNSUPPORTED') }));
    expect(screen.queryByText('raw API error')).not.toBeInTheDocument();
  });
});
