import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PamAuditTab, { buildAuditCsv } from './PamAuditTab';
import { fetchWithAuth } from '../../stores/auth';
import type { ElevationRequest } from './types';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

const decided: ElevationRequest = {
  id: 'aud-1',
  orgId: 'org-1',
  deviceId: 'dev-1',
  deviceHostname: 'WS-CHARLIE',
  flowType: 'ai_tool_action',
  toolName: 'run_script',
  riskTier: 2,
  subjectUsername: 'device-user',
  reason: 'Restart spooler, "quoted"',
  status: 'denied',
  denialReason: 'Out of window',
  requestedAt: '2026-06-10T12:00:00.000Z',
};

describe('PamAuditTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders history rows with filters', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        success: true,
        requests: [decided],
        pagination: { page: 1, limit: 50, total: 1 },
      }),
    );
    render(<PamAuditTab />);
    await waitFor(() => {
      expect(screen.getByTestId('pam-audit-row-aud-1')).toBeInTheDocument();
    });
    expect(screen.getByText('run_script')).toBeInTheDocument();
  });

  it('refetches with a status filter applied', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        success: true,
        requests: [],
        pagination: { page: 1, limit: 50, total: 0 },
      }),
    );
    render(<PamAuditTab />);
    await waitFor(() => screen.getByTestId('pam-audit-filter-status'));
    fireEvent.change(screen.getByTestId('pam-audit-filter-status'), {
      target: { value: 'denied' },
    });
    await waitFor(() => {
      expect(
        fetchWithAuthMock.mock.calls.some((c) => String(c[0]).includes('status=denied')),
      ).toBe(true);
    });
  });

  it('disables export when there are no rows', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        success: true,
        requests: [],
        pagination: { page: 1, limit: 50, total: 0 },
      }),
    );
    render(<PamAuditTab />);
    await waitFor(() => {
      expect(screen.getByTestId('pam-audit-export-btn')).toBeDisabled();
    });
  });
});

describe('buildAuditCsv', () => {
  it('escapes quotes, commas, and newlines per RFC 4180', () => {
    const csv = buildAuditCsv([decided]);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('id,requestedAt,status');
    expect(lines[1]).toContain('"Restart spooler, ""quoted"""');
    expect(lines[1]).toContain('run_script');
    expect(lines[1]).toContain('WS-CHARLIE');
  });

  it('falls back to deviceId when hostname is missing', () => {
    const csv = buildAuditCsv([{ ...decided, deviceHostname: null }]);
    expect(csv.split('\n')[1]).toContain('dev-1');
  });
});
