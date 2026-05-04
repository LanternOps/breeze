import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import AuditExport from './AuditExport';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

describe('AuditExport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:audit-export'),
      revokeObjectURL: vi.fn()
    });
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('timestamp,action\n2026-05-02T00:00:00Z,device.update')
    } as unknown as Response);
  });

  it('sends column controls and suppresses details when details are excluded', async () => {
    render(<AuditExport />);

    fireEvent.click(screen.getByLabelText(/include details/i));
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    const [, options] = fetchWithAuthMock.mock.calls[0]!;
    const body = JSON.parse(String(options?.body));

    expect(body.includeDetails).toBe(false);
    expect(body.columns).not.toContain('details');
    expect(body.columns).toEqual([
      'timestamp',
      'actorName',
      'actorEmail',
      'action',
      'category',
      'result',
      'resourceType',
      'resourceId',
      'resourceName',
      'ipAddress'
    ]);
  });
});
