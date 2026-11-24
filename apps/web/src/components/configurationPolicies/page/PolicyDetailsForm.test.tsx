import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: showToastMock }));

import PolicyDetailsForm from './PolicyDetailsForm';
import { fetchWithAuth } from '../../../stores/auth';
import { i18n } from '@/lib/i18n';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 400, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const initial = { name: 'Workstations', description: 'All desks' };

describe('PolicyDetailsForm (#12469)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('en');
  });

  it('the details form saves through runAction and Cancel restores', async () => {
    const onSaved = vi.fn();
    const onCancel = vi.fn();
    const onDirtyChange = vi.fn();
    fetchMock.mockResolvedValueOnce(json({ error: 'Name already taken' }, false));
    render(
      <PolicyDetailsForm policyId="pol-1" initial={initial} onSaved={onSaved} onCancel={onCancel} onDirtyChange={onDirtyChange} />,
    );
    const name = screen.getByLabelText('Name') as HTMLInputElement;
    const description = screen.getByLabelText('Description') as HTMLTextAreaElement;
    expect(name.value).toBe('Workstations');
    // Status is not edited here (#12470): Activate and Deactivate are its home.
    expect(screen.queryByLabelText('Status')).toBeNull();

    fireEvent.change(name, { target: { value: 'Desks' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    // A refused save toasts through runAction and keeps what was typed.
    fireEvent.click(screen.getByTestId('config-policy-details-save'));
    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Name already taken' })),
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(name.value).toBe('Desks');

    fetchMock.mockResolvedValueOnce(json({ id: 'pol-1', name: 'Desks' }));
    fireEvent.click(screen.getByTestId('config-policy-details-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ name: 'Desks', description: 'All desks' }));
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/configuration-policies/pol-1');
    expect((init as RequestInit).method).toBe('PATCH');
    // No status in the body: a details save can never re-activate a policy
    // someone deactivated while the form was open.
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: 'Desks', description: 'All desks' });
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Policy details saved' }));
  });

  it('Cancel restores the saved values and closes without a request', () => {
    const onCancel = vi.fn();
    const onDirtyChange = vi.fn();
    render(
      <PolicyDetailsForm policyId="pol-1" initial={initial} onSaved={vi.fn()} onCancel={onCancel} onDirtyChange={onDirtyChange} />,
    );
    const description = screen.getByLabelText('Description') as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: 'Changed' } });
    fireEvent.click(screen.getByTestId('config-policy-details-cancel'));
    expect(description.value).toBe('All desks');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clearing the description sends an empty string, so the API clears it', async () => {
    const onSaved = vi.fn();
    fetchMock.mockResolvedValueOnce(json({ id: 'pol-1' }));
    render(<PolicyDetailsForm policyId="pol-1" initial={initial} onSaved={onSaved} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('config-policy-details-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body).toHaveProperty('description', '');
  });

  it('a failure after a successful save is not reported as a failed save', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'pol-1' }));
    const onSaved = vi.fn(() => {
      throw new Error('parent blew up');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<PolicyDetailsForm policyId="pol-1" initial={initial} onSaved={onSaved} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('config-policy-details-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    errors.mockRestore();
  });

  it('a blank name cannot be saved', () => {
    render(<PolicyDetailsForm policyId="pol-1" initial={initial} onSaved={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    expect(screen.getByTestId('config-policy-details-save')).toBeDisabled();
  });
});
