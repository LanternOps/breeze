import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceFunctionField from './DeviceFunctionField';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));
vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

const deviceId = '11111111-1111-1111-1111-111111111111';

function jsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

const aiDto = {
  deviceId,
  functionKey: 'file_server',
  label: null,
  source: 'ai',
  confidence: 0.82,
  evidence: ['SMB shares exported', 'Server OS'],
  assessedAt: '2026-09-13T00:00:00.000Z',
  runId: null,
  reportRunId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DeviceFunctionField', () => {
  it('renders the chip from the DTO with the AI badge and confidence, and loads evidence on expand', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `/devices/${deviceId}/function` && (init?.method ?? 'GET') === 'GET') return jsonResponse(aiDto);
      return jsonResponse({}, false, 404);
    });

    render(<DeviceFunctionField deviceId={deviceId} functionKey="file_server" functionSource="ai" onChanged={vi.fn()} />);
    expect(screen.getByText('File server')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();

    // Confidence + evidence come from the GET, fetched when the details open.
    fireEvent.click(screen.getByText('Why the designer thinks so'));
    await screen.findByText('SMB shares exported');
    expect(screen.getByText('82% confidence')).toBeInTheDocument();
  });

  it('shows the unavailable message (and logs) when the detail GET fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchWithAuthMock.mockImplementation(async () => jsonResponse({ error: 'boom' }, false, 500));

    render(<DeviceFunctionField deviceId={deviceId} functionKey="file_server" functionSource="ai" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByText('Why the designer thinks so'));
    await screen.findByText('Could not load the assessment details.');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('disables Save for an invalid custom slug or a missing label', () => {
    render(<DeviceFunctionField deviceId={deviceId} functionKey={null} functionSource={null} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Change function'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__custom__' } });
    const save = screen.getByTitle('Save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('custom key (a-z, 0-9, -)'), { target: { value: 'pos' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Label'), { target: { value: 'POS' } });
    expect(save.disabled).toBe(false);
    fireEvent.change(screen.getByPlaceholderText('custom key (a-z, 0-9, -)'), { target: { value: 'has space' } });
    expect(save.disabled).toBe(true);
  });

  it('toasts and logs when the parent onChanged throws after a successful save', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchWithAuthMock.mockImplementation(async (_input, init) =>
      init?.method === 'PUT'
        ? jsonResponse({ ...aiDto, functionKey: 'kiosk', source: 'manual', confidence: null, evidence: [] })
        : jsonResponse({}, false, 404),
    );
    render(<DeviceFunctionField deviceId={deviceId} functionKey={null} functionSource={null} onChanged={() => { throw new Error('parent blew up'); }} />);
    fireEvent.click(screen.getByTitle('Change function'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'kiosk' } });
    fireEvent.click(screen.getByTitle('Save'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Failed to save device function' })));
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('renders "Not assessed" with no badge when there is no function', () => {
    render(<DeviceFunctionField deviceId={deviceId} functionKey={null} functionSource={null} onChanged={vi.fn()} />);
    expect(screen.getByText('Not assessed')).toBeInTheDocument();
    expect(screen.queryByText('AI')).toBeNull();
    expect(screen.queryByText('Manual')).toBeNull();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('saves a known key via PUT with source manual and reports through runAction', async () => {
    const onChanged = vi.fn();
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `/devices/${deviceId}/function` && init?.method === 'PUT') {
        return jsonResponse({ ...aiDto, functionKey: 'domain_controller', source: 'manual', confidence: null, evidence: [] });
      }
      return jsonResponse({}, false, 404);
    });

    render(<DeviceFunctionField deviceId={deviceId} functionKey={null} functionSource={null} onChanged={onChanged} />);
    fireEvent.click(screen.getByTitle('Change function'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'domain_controller' } });
    fireEvent.click(screen.getByTitle('Save'));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ functionKey: 'domain_controller', source: 'manual', label: null }));
    const put = fetchWithAuthMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(put[0]).toBe(`/devices/${deviceId}/function`);
    expect(JSON.parse(String(put[1]?.body))).toEqual({ functionKey: 'domain_controller' });
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Device function saved' }));
  });

  it('saves a custom key as custom:<slug> with its label', async () => {
    const onChanged = vi.fn();
    fetchWithAuthMock.mockImplementation(async (_input, init) =>
      init?.method === 'PUT'
        ? jsonResponse({ ...aiDto, functionKey: 'custom:pos', label: 'POS terminal', source: 'manual', confidence: null, evidence: [] })
        : jsonResponse({}, false, 404),
    );

    render(<DeviceFunctionField deviceId={deviceId} functionKey={null} functionSource={null} onChanged={onChanged} />);
    fireEvent.click(screen.getByTitle('Change function'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__custom__' } });
    fireEvent.change(screen.getByPlaceholderText('custom key (a-z, 0-9, -)'), { target: { value: 'pos' } });
    fireEvent.change(screen.getByPlaceholderText('Label'), { target: { value: 'POS terminal' } });
    fireEvent.click(screen.getByTitle('Save'));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ functionKey: 'custom:pos', source: 'manual', label: 'POS terminal' }));
    const put = fetchWithAuthMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]?.body))).toEqual({ functionKey: 'custom:pos', label: 'POS terminal' });
  });

  it('clears via PUT {functionKey: null}', async () => {
    const onChanged = vi.fn();
    fetchWithAuthMock.mockImplementation(async (_input, init) =>
      init?.method === 'PUT'
        ? jsonResponse({ ...aiDto, functionKey: null, source: null, confidence: null, evidence: [] })
        : jsonResponse({}, false, 404),
    );

    render(<DeviceFunctionField deviceId={deviceId} functionKey="file_server" functionSource="manual" onChanged={onChanged} />);
    fireEvent.click(screen.getByTitle('Change function'));
    fireEvent.click(screen.getByText('Clear'));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ functionKey: null, source: null, label: null }));
    const put = fetchWithAuthMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]?.body))).toEqual({ functionKey: null });
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Device function cleared' }));
  });

  it('surfaces an error toast when the API rejects the save and keeps the old value', async () => {
    const onChanged = vi.fn();
    fetchWithAuthMock.mockImplementation(async (_input, init) =>
      init?.method === 'PUT' ? jsonResponse({ error: 'device_not_found' }, false, 400) : jsonResponse({}, false, 404),
    );

    render(<DeviceFunctionField deviceId={deviceId} functionKey="file_server" functionSource="manual" onChanged={onChanged} />);
    fireEvent.click(screen.getByTitle('Change function'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'kiosk' } });
    fireEvent.click(screen.getByTitle('Save'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(onChanged).not.toHaveBeenCalled();
  });
});
