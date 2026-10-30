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

  it('marks a section whose read model failed instead of showing it empty', async () => {
    fetchWithAuth.mockImplementation(async (path: string) =>
      path.includes('/portal-users')
        ? json({ data: [] })
        : json({ data: { portalUser: null, readiness: [], sections: [
            { key: 'documents', enabled: true, previewAvailable: true, data: null, error: 'load_failed' },
          ] } }));
    render(<OrgPortalPreviewPanel orgId="org-1" />);
    expect(await screen.findByTestId('org-portal-preview-section-error-documents')).toBeInTheDocument();
  });

  it('renders a permission-withheld section as "not shown" with the needed permission, and no data/on-off/unavailable text', async () => {
    fetchWithAuth.mockImplementation(async (path: string) =>
      path.includes('/portal-users')
        ? json({ data: [] })
        : json({ data: { portalUser: null, readiness: [], sections: [
            { key: 'reports', enabled: true, previewAvailable: false, data: null, reason: 'permission', missingPermissions: ['reports:read'] },
          ] } }));
    render(<OrgPortalPreviewPanel orgId="org-1" />);
    const block = await screen.findByTestId('org-portal-preview-section-reports');
    const msg = await screen.findByTestId('org-portal-preview-section-permission-reports');
    expect(block).toContainElement(msg);
    expect(msg.textContent).toContain('orgPortalSettingsEditor.preview.permissionWithheld');
    expect(msg.textContent).toContain('reports:read');
    expect(block.textContent).not.toContain('orgPortalSettingsEditor.preview.notAvailable');
  });

  it('dashboard with omitted tiles shows the tiles-withheld message and keeps the rest', async () => {
    fetchWithAuth.mockImplementation(async (path: string) =>
      path.includes('/portal-users')
        ? json({ data: [] })
        : json({ data: { portalUser: null, readiness: [], sections: [
            { key: 'dashboard', enabled: true, previewAvailable: true, missingPermissions: ['backup:read'],
              data: { securityScore: { status: 'ok', score: 88 } } },
          ] } }));
    render(<OrgPortalPreviewPanel orgId="org-1" />);
    const msg = await screen.findByTestId('org-portal-preview-section-tiles-permission-dashboard');
    expect(msg.textContent).toContain('orgPortalSettingsEditor.preview.tilesWithheld');
    expect(msg.textContent).toContain('backup:read');
    expect(screen.queryByTestId('org-portal-preview-section-permission-dashboard')).toBeNull();
  });

  it('renders dashboard tiles through their labels, not raw DTO keys/fields (#9952)', async () => {
    render(<OrgPortalPreviewPanel orgId="org-1" />);
    const block = await screen.findByTestId('org-portal-preview-section-dashboard');
    const text = block.textContent ?? '';
    expect(text).toContain('settings:orgPortalSettingsEditor.preview.tiles.securityScore');
    expect(text).toContain('settings:orgPortalSettingsEditor.preview.tiles.awaitingYou');
    // The pre-fix generic renderer printed "securityScore" / "status: ok · score: 88".
    expect(text).not.toMatch(/(^|[^.])securityScore/);
    expect(text).not.toContain('status:');
    expect(text).not.toContain('score:');
  });

  it('falls back to the org-wide view when the selected portal user is gone (404)', async () => {
    render(<OrgPortalPreviewPanel orgId="org-1" />);
    await screen.findByTestId('org-portal-preview-section-dashboard');
    await waitFor(() => expect(screen.getByRole('option', { name: /pat@cust.example/ })).toBeInTheDocument());
    fetchWithAuth.mockImplementation(async (path: string) => {
      if (path.includes('/portal-users')) return json({ data: [] });
      return path.includes('portalUserId=') ? json({ error: 'gone' }, 404) : json(PREVIEW);
    });
    await userEvent.selectOptions(screen.getByTestId('org-portal-preview-user'), 'pu-1');
    await waitFor(() => expect((screen.getByTestId('org-portal-preview-user') as HTMLSelectElement).value).toBe(''));
    expect(await screen.findByTestId('org-portal-preview-section-dashboard')).toBeInTheDocument();
  });

  it('shows a retry affordance when the preview fails to load', async () => {
    fetchWithAuth.mockImplementation(async (path: string) =>
      path.includes('/portal-users') ? json({ data: [] }) : json({ error: 'boom' }, 500));
    render(<OrgPortalPreviewPanel orgId="org-1" />);
    expect(await screen.findByTestId('org-portal-preview-error')).toBeInTheDocument();
  });
});
