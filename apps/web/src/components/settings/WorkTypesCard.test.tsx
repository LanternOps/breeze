import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WorkTypesCard from './WorkTypesCard';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { resetWorkTypeCache } from '../shared/WorkTypeSelect';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ loginPathWithNext: () => '/login' }));
vi.mock('../shared/WorkTypeSelect', () => ({ resetWorkTypeCache: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
let mutationResponse: Response;
beforeEach(() => {
  vi.clearAllMocks();
  mutationResponse = response({ workType: { id: 'wt-1', name: 'Remote', isActive: true } });
  fetchMock.mockImplementation(async (_url, init) => init?.method
    ? mutationResponse
    : response({ workTypes: [{ id: 'wt-1', name: 'Remote', isActive: true }] }));
});

describe('WorkTypesCard', () => {
  it('MOUNT: lists work types and creates a new one through runAction', async () => {
    render(<WorkTypesCard />);
    await screen.findByTestId('work-type-row-wt-1');
    fireEvent.change(screen.getByTestId('work-type-new-name'), { target: { value: 'After-hours' } });
    fireEvent.click(screen.getByTestId('work-type-create'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/billing-profiles/work-types', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'After-hours' }) })));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    expect(resetWorkTypeCache).toHaveBeenCalledOnce();
  });

  it('labels the destructive action Archive and invalidates picker data after archiving', async () => {
    render(<WorkTypesCard />);
    const archive = await screen.findByTestId('work-type-archive-wt-1');
    expect(archive).toHaveTextContent(/archive/i);
    fireEvent.click(archive);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/billing-profiles/work-types/wt-1', expect.objectContaining({ method: 'DELETE' })));
    await waitFor(() => expect(resetWorkTypeCache).toHaveBeenCalledOnce());
  });

  it('renames with PATCH and refreshes picker data', async () => {
    render(<WorkTypesCard />);
    fireEvent.click(await screen.findByTestId('work-type-rename-wt-1'));
    fireEvent.change(screen.getByTestId('work-type-edit-name'), { target: { value: 'On-site' } });
    fireEvent.click(screen.getByTestId('work-type-save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/billing-profiles/work-types/wt-1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'On-site' }) })));
    await waitFor(() => expect(resetWorkTypeCache).toHaveBeenCalledOnce());
  });

  it('surfaces a duplicate-name 409 without clearing the draft or cache', async () => {
    mutationResponse = response({ code: 'WORK_TYPE_NAME_TAKEN', error: 'exists' }, 409);
    render(<WorkTypesCard />);
    await screen.findByTestId('work-type-row-wt-1');
    fireEvent.change(screen.getByTestId('work-type-new-name'), { target: { value: 'Remote' } });
    fireEvent.click(screen.getByTestId('work-type-create'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'A work type with this name already exists.' }));
    expect(screen.getByTestId('work-type-new-name')).toHaveValue('Remote');
    expect(resetWorkTypeCache).not.toHaveBeenCalled();
  });
});
