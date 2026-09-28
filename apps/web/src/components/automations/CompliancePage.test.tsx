import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import CompliancePage from './CompliancePage';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    json({
      overall: { total: 0, compliant: 0, nonCompliant: 0, unknown: 0 },
      trend: [],
      policies: [],
      nonCompliantDevices: [],
    })
  );
});

describe('CompliancePage back link (#7158 a11y)', () => {
  it('gives the icon-only back-to-policies link an accessible name', async () => {
    render(<CompliancePage />);

    expect(await screen.findByRole('link', { name: 'Back to Policies' })).toHaveAttribute('href', '/policies');
  });
});
