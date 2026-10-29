import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PartnerGroupAssignmentSection from './PartnerGroupAssignmentSection';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);
const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
const props = { policyId: 'p1', assignments: [], roleFilter: ['server'], osFilter: ['linux'], disabled: false, onChanged: vi.fn() };

describe('PartnerGroupAssignmentSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url, init) => {
      if (url === '/device-groups?ownerScope=partner') return json({ data: [{ id: 'g1', name: 'All servers' }] });
      if (init?.method) return json({});
      throw new Error(`Unexpected URL ${url}`);
    });
  });
  it('loads partner groups without org injection and assigns with filters through runAction', async () => {
    render(<PartnerGroupAssignmentSection {...props} />);
    await screen.findByRole('option', { name: 'All servers' });
    expect(fetchMock).toHaveBeenCalledWith('/device-groups?ownerScope=partner', { skipOrgIdInjection: true });
    fireEvent.change(screen.getByTestId('policy-partner-group-select'), { target: { value: 'g1' } });
    fireEvent.click(screen.getByTestId('policy-partner-group-assign'));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/configuration-policies/p1/assignments', expect.objectContaining({ method: 'POST', body: JSON.stringify({ level: 'device_group', targetId: 'g1', priority: 0, roleFilter: ['server'], osFilter: ['linux'] }) }));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
  it('shows assignment names and filters, excludes assigned groups and removes through runAction', async () => {
    render(<PartnerGroupAssignmentSection {...props} assignments={[{ id: 'a1', level: 'device_group', targetId: 'g1', roleFilter: ['server'] }]} />);
    await screen.findByText('All servers');
    expect(screen.getByText('Server')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'All servers' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('policy-partner-group-remove-g1'));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/configuration-policies/p1/assignments/a1', { method: 'DELETE' });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
  it('links the empty state to partner groups', async () => {
    fetchMock.mockResolvedValue(json({ data: [] }));
    render(<PartnerGroupAssignmentSection {...props} />);
    expect(await screen.findByRole('link')).toHaveAttribute('href', '/devices/groups#owner=partner');
  });
  it('shows load failures inline and disables assigning', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Unavailable' }, 500));
    render(<PartnerGroupAssignmentSection {...props} />);
    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('policy-partner-group-assign')).toBeDisabled();
  });
  it('toasts a failed assignment without refreshing saved assignments', async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (url === '/device-groups?ownerScope=partner') return json({ data: [{ id: 'g1', name: 'All servers' }] });
      if (init?.method === 'POST') return json({ error: 'Assignment failed' }, 400);
      throw new Error(`Unexpected URL ${url}`);
    });
    render(<PartnerGroupAssignmentSection {...props} />);
    await screen.findByRole('option', { name: 'All servers' });
    fireEvent.change(screen.getByTestId('policy-partner-group-select'), { target: { value: 'g1' } });
    fireEvent.click(screen.getByTestId('policy-partner-group-assign'));
    expect(await screen.findByText('Assignment failed')).toBeInTheDocument();
    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Assignment failed' });
    expect(props.onChanged).not.toHaveBeenCalled();
  });
  it('disables assignment and removal while the panel is busy', async () => {
    render(<PartnerGroupAssignmentSection {...props} disabled assignments={[{ id: 'a1', level: 'device_group', targetId: 'unknown-group' }]} />);
    await screen.findByRole('option', { name: 'All servers' });
    expect(screen.getByText('unknown-group')).toBeInTheDocument();
    expect(screen.getByTestId('policy-partner-group-select')).toBeDisabled();
    expect(screen.getByTestId('policy-partner-group-assign')).toBeDisabled();
    expect(screen.getByTestId('policy-partner-group-remove-unknown-group')).toBeDisabled();
  });

});
