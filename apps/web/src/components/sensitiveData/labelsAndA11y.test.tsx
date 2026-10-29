import '@/lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null }) => unknown) => selector({ currentOrgId: 'org-1' }),
}));
vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({ isPartnerScope: false, defaultOwnerScope: 'organization' }),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./CreateScanModal', () => ({ default: () => null }));

import DashboardTab from './DashboardTab';
import FindingsTab from './FindingsTab';
import PoliciesTab from './PoliciesTab';
import ScansTab from './ScansTab';
import RemediationModal from './RemediationModal';
import { fetchWithAuth } from '../../stores/auth';
import { humanizeRaw, sortByRisk } from './useSensitiveDataLabels';

const fetchMock = vi.mocked(fetchWithAuth);

const jsonRes = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  fetchMock.mockReset();
});

describe('Sensitive Data labels and icon buttons (#9928)', () => {
  it('orders the Risk Distribution legend by severity, not alphabetically', async () => {
    fetchMock.mockResolvedValue(
      jsonRes({
        data: {
          totals: { findings: 10, open: 10, criticalOpen: 4, remediated24h: 0, averageOpenAgeHours: 1 },
          byDataType: { pii: 10 },
          // API returns keys alphabetically; the legend must not follow that.
          byRisk: { critical: 4, high: 3, low: 1, medium: 2 },
        },
      }),
    );
    render(<DashboardTab />);
    const heading = await screen.findByText('Risk Distribution');
    const card = heading.parentElement as HTMLElement;
    const labels = ['Critical', 'High', 'Medium', 'Low'].map((l) => within(card).getByText(l));
    for (let i = 1; i < labels.length; i++) {
      // DOCUMENT_POSITION_FOLLOWING: labels[i] comes after labels[i-1]
      expect(labels[i - 1].compareDocumentPosition(labels[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('renders findings filter options and badges as translated labels, keyed by API value', async () => {
    fetchMock.mockResolvedValue(
      jsonRes({
        data: [
          {
            id: 'f1',
            deviceId: 'dev-1',
            deviceName: 'host-1',
            filePath: '/tmp/a',
            dataType: 'credential',
            patternId: 'aws_access_key',
            risk: 'critical',
            confidence: 0.9,
            status: 'false_positive',
            lastSeenAt: '2026-05-21T00:00:00Z',
            createdAt: '2026-05-21T00:00:00Z',
          },
        ],
        pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
      }),
    );
    render(<FindingsTab />);
    await screen.findByText('/tmp/a');

    const [, riskSelect, statusSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
    const optionPairs = (sel: HTMLSelectElement) =>
      Array.from(sel.options).slice(1).map((o) => [o.value, o.textContent]);
    expect(optionPairs(riskSelect)).toEqual([
      ['critical', 'Critical'],
      ['high', 'High'],
      ['medium', 'Medium'],
      ['low', 'Low'],
    ]);
    expect(optionPairs(statusSelect)).toEqual([
      ['open', 'Open'],
      ['remediated', 'Remediated'],
      ['accepted', 'Accepted'],
      ['false_positive', 'False Positive'],
    ]);

    const row = screen.getByText('/tmp/a').closest('tr') as HTMLElement;
    expect(within(row).getByText('Critical')).toBeInTheDocument();
    expect(within(row).getByText('False Positive')).toBeInTheDocument();

    // Choosing a translated option still sends the raw API value.
    fireEvent.change(statusSelect, { target: { value: 'false_positive' } });
    fireEvent.change(riskSelect, { target: { value: 'critical' } });
    await waitFor(() => {
      const lastUrl = String(fetchMock.mock.calls.at(-1)?.[0]);
      expect(lastUrl).toContain('status=false_positive');
      expect(lastUrl).toContain('risk=critical');
    });

    expect(screen.getByRole('button', { name: 'Previous page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeInTheDocument();
  });

  it('gives the policy row icon buttons and toggle accessible names', async () => {
    fetchMock.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      if (!init?.method && String(rawUrl) === '/sensitive-data/policies') {
        return jsonRes({
          data: [
            {
              id: 'sdp-1',
              orgId: 'org-1',
              name: 'Find credentials',
              detectionClasses: ['credential'],
              isActive: true,
              schedule: { type: 'manual' },
              createdAt: '2026-09-01T00:00:00.000Z',
              updatedAt: '2026-09-01T00:00:00.000Z',
            },
          ],
        });
      }
      return jsonRes({});
    });
    render(<PoliciesTab />);
    await screen.findByText('Find credentials');

    const edit = screen.getByRole('button', { name: 'Edit policy Find credentials' });
    expect(edit).toHaveAttribute('title', 'Edit policy Find credentials');
    const del = screen.getByRole('button', { name: 'Delete policy Find credentials' });
    expect(del).toHaveAttribute('title', 'Delete policy Find credentials');
    const toggle = screen.getByRole('switch', { name: 'Active: Find credentials' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('labels scan status badges', async () => {
    fetchMock.mockResolvedValue(
      jsonRes({
        data: [
          {
            id: 'scan-1234567',
            orgId: 'org-1',
            deviceId: 'dev-1',
            deviceName: 'host-a',
            policyId: null,
            status: 'cancelled',
            startedAt: null,
            completedAt: null,
            summary: {},
            createdAt: '2026-05-21T00:00:00Z',
          },
        ],
      }),
    );
    render(<ScansTab />);
    const row = (await screen.findByText('host-a')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Cancelled')).toBeInTheDocument();
  });

  it('labels the remediation modal close button', () => {
    render(<RemediationModal findingIds={['f1']} onClose={() => {}} onComplete={() => {}} />);
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});

describe('Sensitive Data label helpers (#9928)', () => {
  it('sorts unknown risk levels after low', () => {
    expect(sortByRisk([['unknown', 1], ['low', 2], ['critical', 3]]).map(([k]) => k)).toEqual([
      'critical',
      'low',
      'unknown',
    ]);
  });

  it('humanizes an unmapped enum value instead of rendering it raw', () => {
    expect(humanizeRaw('needs_review')).toBe('Needs review');
  });
});
