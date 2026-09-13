import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AlertTemplateEditor from './AlertTemplateEditor';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/authScope', async () => {
  const actual = await vi.importActual<typeof import('@/lib/authScope')>('@/lib/authScope');
  return { ...actual, getJwtClaims: () => ({ scope: 'partner', partnerId: 'p-1', orgId: null }) };
});
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: () => ({ partners: [], organizations: [{ id: 'org-1', name: 'Acme' }] }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const baseTemplate = {
  id: 't-1',
  name: 'Disk pressure',
  category: 'Capacity',
  severity: 'medium',
  orgId: 'org-1',
  partnerId: 'p-1',
  isBuiltIn: false,
  conditions: {},
};

beforeEach(() => {
  vi.clearAllMocks();
});

// #5287 — a template compiled from a monitor definition is read-only in the
// editor, same treatment as AutomationEditPage's monitor-managed banner.
describe('AlertTemplateEditor monitor-managed templates (#5287)', () => {
  it('renders a read-only banner with a link to the monitor instead of the form', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/alert-templates/templates/t-1') {
        return json({ data: { ...baseTemplate, managedByMonitorId: 'monitor-1' } });
      }
      return json({ data: [] });
    });

    render(<AlertTemplateEditor templateId="t-1" />);

    expect(await screen.findByTestId('alert-template-managed-notice')).toBeInTheDocument();
    const link = screen.getByTestId('alert-template-managed-link');
    expect(link).toHaveAttribute('href', '/alerts/monitors/monitor-1');

    // The form (e.g. the metadata card) must not render alongside the banner.
    expect(screen.queryByText('Template metadata')).toBeNull();
  });

  it('disables Save for a monitor-managed template', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/alert-templates/templates/t-1') {
        return json({ data: { ...baseTemplate, managedByMonitorId: 'monitor-1' } });
      }
      return json({ data: [] });
    });

    render(<AlertTemplateEditor templateId="t-1" />);

    await waitFor(() => expect(screen.getByTestId('alert-template-managed-notice')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /save template/i })).toBeDisabled();
  });

  it('renders the normal editable form for a template without managedByMonitorId', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/alert-templates/templates/t-1') {
        return json({ data: { ...baseTemplate, managedByMonitorId: null } });
      }
      return json({ data: [] });
    });

    render(<AlertTemplateEditor templateId="t-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /save template/i })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /save template/i })).not.toBeDisabled();
    expect(screen.queryByTestId('alert-template-managed-notice')).toBeNull();
  });
});
