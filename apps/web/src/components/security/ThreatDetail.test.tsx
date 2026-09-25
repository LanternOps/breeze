import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
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
});
