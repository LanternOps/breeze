import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CreateMonitorForm from './CreateMonitorForm';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

function submit() {
  fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Gateway' } });
  fireEvent.submit(document.querySelector('form')!);
}

describe('CreateMonitorForm feedback (#5313)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('toasts success and calls onCreated on 201', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'm1' }), { status: 201 }));
    const onCreated = vi.fn();
    render(<CreateMonitorForm defaultTarget="10.0.0.1" onCreated={onCreated} onCancel={() => {}} />);
    submit();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('toasts the error and does not call onCreated on failure', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), { status: 400 }));
    const onCreated = vi.fn();
    render(<CreateMonitorForm defaultTarget="10.0.0.1" onCreated={onCreated} onCancel={() => {}} />);
    submit();
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(onCreated).not.toHaveBeenCalled();
  });
});
