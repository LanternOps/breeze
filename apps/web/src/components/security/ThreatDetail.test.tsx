import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));

import ThreatDetail from './ThreatDetail';

function ok(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
}

const quarantinedThreat = {
  id: 't1',
  deviceId: 'dev-1',
  deviceName: 'Workstation 1',
  name: 'Emotet',
  category: 'trojan',
  severity: 'critical',
  status: 'quarantined',
  detectedAt: '2026-06-20T00:00:00Z',
  filePath: 'C:\\temp\\evil.exe',
};

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
});

describe('ThreatDetail', () => {
  // #6685 -- status/severity rendered the raw lowercase enum value instead of
  // a human label.
  it('renders human-readable status and severity labels, not raw enum values', async () => {
    fetchWithAuth.mockResolvedValue(ok({ data: [quarantinedThreat] }));

    render(<ThreatDetail threatId="t1" />);

    await screen.findByText('Emotet');

    const statusLabels = screen.getAllByText('Quarantined');
    expect(statusLabels.length).toBeGreaterThan(0);
    const severityLabels = screen.getAllByText('Critical');
    expect(severityLabels.length).toBeGreaterThan(0);
    expect(screen.queryByText('quarantined')).toBeNull();
    expect(screen.queryByText('critical')).toBeNull();
  });

  // #9660 -- the timeline was synthesized from status and stamped every entry
  // with the detection time, plus an unconditional "Analyst review".
  it('shows only events that have a record: no invented analyst review, no fake timestamps', async () => {
    fetchWithAuth.mockResolvedValue(ok({ data: [{ ...quarantinedThreat, status: 'active' }] }));
    render(<ThreatDetail threatId="t1" />);
    await screen.findByText('Emotet');

    expect(screen.queryByText('Analyst review')).toBeNull();
    expect(screen.queryByText('Threat quarantined')).toBeNull();
    expect(screen.queryByText('Threat removed')).toBeNull();
    expect(screen.getByText('Threat detected')).toBeTruthy();
  });

  it('does not stamp a quarantine event with the detection time', async () => {
    fetchWithAuth.mockResolvedValue(ok({ data: [quarantinedThreat] }));
    render(<ThreatDetail threatId="t1" />);
    await screen.findByText('Emotet');

    const entry = screen.getByText('Threat quarantined').parentElement as HTMLElement;
    // title + description only; no timestamp line.
    expect(entry.querySelectorAll('p')).toHaveLength(2);
  });

  it('stamps a removal event with removedAt, not detectedAt', async () => {
    fetchWithAuth.mockResolvedValue(
      ok({ data: [{ ...quarantinedThreat, status: 'removed', removedAt: '2026-06-21T12:00:00Z' }] }),
    );
    render(<ThreatDetail threatId="t1" />);
    await screen.findByText('Emotet');

    const entry = screen.getByText('Threat removed').parentElement as HTMLElement;
    expect(entry.querySelectorAll('p')).toHaveLength(3);
    const detected = screen.getByText('Threat detected').parentElement as HTMLElement;
    expect(entry.querySelectorAll('p')[2].textContent).not.toBe(detected.querySelectorAll('p')[2].textContent);
  });

  it('shows the catalog provider name instead of the raw id', async () => {
    fetchWithAuth.mockResolvedValue(
      ok({
        data: [
          {
            ...quarantinedThreat,
            providerId: 'breeze',
            provider: { id: 'breeze', name: 'Breeze IOC scan' },
          },
        ],
      }),
    );
    render(<ThreatDetail threatId="t1" />);
    await screen.findByText('Emotet');

    expect(screen.getByText('Breeze IOC scan')).toBeTruthy();
    expect(screen.queryByText('breeze')).toBeNull();
  });

  it('toasts a queued action as queued, not as completed', async () => {
    fetchWithAuth.mockImplementation(async (url: string, init?: { method?: string }) =>
      init?.method === 'POST'
        ? ok({ data: { id: 't1' } })
        : ok({ data: [{ ...quarantinedThreat, status: 'active' }] }),
    );
    render(<ThreatDetail threatId="t1" />);
    await screen.findByText('Emotet');

    fireEvent.click(screen.getByRole('button', { name: 'Quarantine' }));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    const toast = showToast.mock.calls[0][0] as { message: string };
    expect(toast.message).toMatch(/queued/i);
    expect(toast.message).not.toBe('Threat quarantined');
  });
});
