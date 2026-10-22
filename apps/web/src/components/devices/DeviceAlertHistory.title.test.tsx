import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceAlertHistory from './DeviceAlertHistory';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

function respond(data: unknown[]) {
  fetchWithAuthMock.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue({ data }),
  } as unknown as Response);
}

describe('DeviceAlertHistory row title (#9610)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the alert title, not the long message, as the row heading', async () => {
    respond([
      {
        id: 'a1',
        title: 'Disk almost full',
        summary: 'Disk almost full',
        message: 'Volume C: has 6.8 GB free of 238 GB. Threshold: 90%.',
        severity: 'high',
        status: 'active',
        createdAt: '2026-02-09T09:00:00.000Z',
      },
    ]);
    render(<DeviceAlertHistory deviceId="device-1" />);
    expect(await screen.findByText('Disk almost full')).toBeInTheDocument();
    expect(screen.queryByText(/6\.8 GB free/)).toBeNull();
  });

  it('prefers summary over message when the API sends no title', async () => {
    respond([
      {
        id: 'a2',
        summary: 'Disk almost full',
        message: 'Volume C: has 6.8 GB free of 238 GB. Threshold: 90%.',
        severity: 'high',
        status: 'active',
        createdAt: '2026-02-09T09:00:00.000Z',
      },
    ]);
    render(<DeviceAlertHistory deviceId="device-1" />);
    expect(await screen.findByText('Disk almost full')).toBeInTheDocument();
    expect(screen.queryByText(/6\.8 GB free/)).toBeNull();
  });
});
