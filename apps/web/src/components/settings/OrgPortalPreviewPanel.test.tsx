import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({ fetchWithAuth }));
vi.mock('@/lib/i18n', () => ({}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      const { defaultValue: _d, ...rest } = (vars ?? {}) as Record<string, unknown>;
      return Object.keys(rest).length ? `${key}:${JSON.stringify(rest)}` : key;
    },
  }),
}));

import OrgPortalPreviewPanel from './OrgPortalPreviewPanel';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PREVIEW = {
  data: {
    portalUser: null,
    sections: [
      { key: 'dashboard', enabled: true, previewAvailable: true, note: 'x',
        data: { securityScore: { status: 'ok', score: 88 }, awaitingYou: { proposals: 1, invoices: 2 } } },
      { key: 'documents', enabled: true, previewAvailable: true,
        data: { groups: [{ category: 'runbook', documents: [{ id: 'd1', title: 'Onboarding runbook' }] }] } },
      { key: 'backups', enabled: false, previewAvailable: true, data: null },
      { key: 'hardwareHealth', enabled: true, previewAvailable: false, data: null },
      { key: 'ticketUsage', enabled: false, previewAvailable: false, data: null },
    ],
    readiness: [
      { code: 'documents_empty', message: 'Documents is on but empty', fixTab: 'documents' },
      { code: 'branding_unset', message: 'No branding', fixTab: 'portal' },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchWithAuth.mockImplementation(async (path: string) => {
    if (path.includes('/portal-users')) {
      return json({ data: [{ id: 'pu-1', email: 'pat@cust.example', name: 'Pat' }] });
    }
    return json(PREVIEW);
  });
});

describe('OrgPortalPreviewPanel (#9350)', () => {
  it('renders one testid\'d block per section and the readiness list', async () => {
    render(<OrgPortalPreviewPanel orgId="org-1" />);
    expect(await screen.findByTestId('org-portal-preview-section-dashboard')).toBeInTheDocument();
    for (const key of ['documents', 'backups', 'hardwareHealth']) {
      expect(screen.getByTestId(`org-portal-preview-section-${key}`)).toBeInTheDocument();
    }
    // Route-level gate rows that are not customer-facing sections are not shown.
    expect(screen.queryByTestId('org-portal-preview-section-ticketUsage')).not.toBeInTheDocument();
    expect(screen.getByTestId('org-portal-preview-readiness-documents_empty')).toBeInTheDocument();
    expect(screen.getByTestId('org-portal-preview-readiness-branding_unset')).toBeInTheDocument();
    expect(screen.getByText('Onboarding runbook')).toBeInTheDocument();
  });

  it('deep-links only the readiness checks that have an org-record tab', async () => {
    render(<OrgPortalPreviewPanel orgId="org-1" />);
    const docs = await screen.findByTestId('org-portal-preview-readiness-documents_empty');
    expect(docs.querySelector('a')?.getAttribute('href')).toBe('/organizations/org-1#documents');
    expect(screen.getByTestId('org-portal-preview-readiness-branding_unset').querySelector('a')).toBeNull();
  });

  it('is read-only: only GETs are issued, and picking a portal user re-queries with portalUserId', async () => {
    render(<OrgPortalPreviewPanel orgId="org-1" />);
    await screen.findByTestId('org-portal-preview-section-dashboard');
    await waitFor(() => expect(screen.getByRole('option', { name: /pat@cust.example/ })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByTestId('org-portal-preview-user'), 'pu-1');
    await waitFor(() =>
      expect(fetchWithAuth.mock.calls.some((c) => String(c[0]).includes('portalUserId=pu-1'))).toBe(true));
    for (const call of fetchWithAuth.mock.calls) {
      const init = call[1] as { method?: string } | undefined;
      expect(init?.method ?? 'GET').toBe('GET');
    }
  });

  it('shows a retry affordance when the preview fails to load', async () => {
    fetchWithAuth.mockImplementation(async (path: string) =>
      path.includes('/portal-users') ? json({ data: [] }) : json({ error: 'boom' }, 500));
    render(<OrgPortalPreviewPanel orgId="org-1" />);
    expect(await screen.findByTestId('org-portal-preview-error')).toBeInTheDocument();
  });
});
