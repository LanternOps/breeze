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

const payload = (overall: Record<string, number>, nonCompliantDevices: unknown[] = []) =>
  json({ overall, trend: [], policies: [], nonCompliantDevices });

describe('CompliancePage empty and plural states (#8967)', () => {
  it('does not claim compliance before anything has been evaluated', async () => {
    render(<CompliancePage />);

    expect(await screen.findByText('No devices have been evaluated yet.')).toBeInTheDocument();
    expect(screen.queryByText('All devices are compliant!')).not.toBeInTheDocument();
  });

  it('does not claim compliance while devices are only pending evaluation', async () => {
    fetchMock.mockImplementation(async () =>
      payload({ total: 2, compliant: 0, nonCompliant: 0, unknown: 2 })
    );
    render(<CompliancePage />);

    expect(await screen.findByText('No violations found; 2 devices are still pending evaluation.')).toBeInTheDocument();
    expect(screen.queryByText('All devices are compliant!')).not.toBeInTheDocument();
  });

  it('still celebrates when every evaluated device is compliant', async () => {
    fetchMock.mockImplementation(async () =>
      payload({ total: 2, compliant: 2, nonCompliant: 0, unknown: 0 })
    );
    render(<CompliancePage />);

    expect(await screen.findByText('All devices are compliant!')).toBeInTheDocument();
  });

  it('pluralizes the violation badge and the overflow line', async () => {
    const violation = (n: number) => ({ policyId: `p${n}`, policyName: `P${n}`, ruleName: 'r', message: `m${n}` });
    const device = (id: string, violations: unknown[]) => ({
      deviceId: id, deviceName: id, status: 'non_compliant',
      violationCount: violations.length, violations, lastCheckedAt: new Date().toISOString(),
    });
    fetchMock.mockImplementation(async () =>
      payload({ total: 2, compliant: 0, nonCompliant: 2, unknown: 0 }, [
        device('one-v', [violation(1)]),
        device('five-v', [1, 2, 3, 4].map(violation)),
      ])
    );
    render(<CompliancePage />);

    expect(await screen.findByText('1 violation')).toBeInTheDocument();
    expect(screen.getByText('4 violations')).toBeInTheDocument();
    expect(screen.getByText('+1 more violation')).toBeInTheDocument();
  });
});
