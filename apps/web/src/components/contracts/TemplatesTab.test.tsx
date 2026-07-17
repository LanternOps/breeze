import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// fetchWithAuth is called directly to load the org picker options.
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

// Partner scope by default so the ownerScope selector renders.
type Claims = { scope: string | null; orgId: string | null; partnerId: string | null };
const getJwtClaims = vi.fn<() => Claims>(() => ({ scope: 'partner', orgId: null, partnerId: 'p1' }));
vi.mock('@/lib/authScope', () => ({ getJwtClaims: () => getJwtClaims() }));

const api = vi.hoisted(() => ({
  listContractTemplates: vi.fn(),
  createContractTemplate: vi.fn(),
  archiveContractTemplate: vi.fn(),
}));
vi.mock('../../lib/api/contractTemplates', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/api/contractTemplates')>();
  return { ...orig, ...api };
});

// TemplateEditor is exercised in its own test; stub it so opening one is inert.
vi.mock('./TemplateEditor', () => ({ default: () => <div data-testid="contract-template-editor-stub" /> }));

import TemplatesTab from './TemplatesTab';

const resp = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const PARTNER_TEMPLATE = {
  id: '11111111-1111-1111-1111-111111111111',
  ownerScope: 'partner',
  orgId: null,
  partnerId: 'p1',
  name: 'MSA (All orgs)',
  description: null,
  status: 'active',
  createdBy: 'u1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  latestVersion: {
    id: 'v1',
    templateId: '11111111-1111-1111-1111-111111111111',
    ownerScope: 'partner',
    orgId: null,
    partnerId: 'p1',
    versionNumber: 2,
    status: 'published',
    sourceType: 'authored',
    bodyHtml: '<p>Hi {{client.name}}</p>',
    mime: null,
    byteSize: null,
    sha256: 'abc',
    declaredVariables: [{ name: 'client.name', kind: 'auto' }],
    publishedAt: '2026-01-02T00:00:00Z',
    createdBy: 'u1',
    createdAt: '2026-01-02T00:00:00Z',
  },
};

const ORG_TEMPLATE = {
  id: '22222222-2222-2222-2222-222222222222',
  ownerScope: 'organization',
  orgId: 'org-1',
  partnerId: null,
  name: 'Acme SOW',
  description: 'Statement of work',
  status: 'active',
  createdBy: 'u1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  latestVersion: null,
};

describe('TemplatesTab — library list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    getJwtClaims.mockReturnValue({ scope: 'partner', orgId: null, partnerId: 'p1' });
    fetchWithAuth.mockResolvedValue(resp({ data: [{ id: 'org-1', name: 'Acme' }] }));
    api.listContractTemplates.mockResolvedValue(resp({ data: [PARTNER_TEMPLATE, ORG_TEMPLATE] }));
    api.createContractTemplate.mockResolvedValue(resp({ data: { id: 'new-1' } }));
    api.archiveContractTemplate.mockResolvedValue(resp({ data: { ok: true } }));
  });

  it('renders a row per template with an "All orgs" badge on partner-owned ones', async () => {
    render(<TemplatesTab />);
    await screen.findByTestId('contract-templates-tab');

    const rows = await screen.findAllByTestId('contract-template-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('MSA (All orgs)')).toBeInTheDocument();
    expect(screen.getByText('Acme SOW')).toBeInTheDocument();

    // Partner-owned row shows the "All orgs" badge; org-owned one does not.
    const partnerRow = within(rows[0]);
    expect(partnerRow.getByTestId('contract-template-all-orgs-badge')).toBeInTheDocument();
    expect(within(rows[1]).queryByTestId('contract-template-all-orgs-badge')).not.toBeInTheDocument();
  });

  it('does not call createContractTemplate when org-scoped create has no org selected', async () => {
    render(<TemplatesTab />);
    await screen.findByTestId('contract-templates-tab');

    fireEvent.click(screen.getByTestId('contract-templates-create-btn'));
    await screen.findByTestId('contract-template-create-dialog');

    fireEvent.change(screen.getByTestId('contract-template-name'), { target: { value: 'New template' } });
    fireEvent.click(screen.getByTestId('contract-template-owner-org')); // organization scope, no org picked
    fireEvent.click(screen.getByTestId('contract-template-create-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('contract-template-create-error')).toBeInTheDocument();
    });
    expect(api.createContractTemplate).not.toHaveBeenCalled();
  });

  it('creates an org-owned template with orgId once an org is picked', async () => {
    render(<TemplatesTab />);
    await screen.findByTestId('contract-templates-tab');

    fireEvent.click(screen.getByTestId('contract-templates-create-btn'));
    await screen.findByTestId('contract-template-create-dialog');
    fireEvent.change(screen.getByTestId('contract-template-name'), { target: { value: 'New template' } });
    fireEvent.click(screen.getByTestId('contract-template-owner-org'));

    const orgSelect = screen.getByTestId('contract-template-org');
    await within(orgSelect).findByRole('option', { name: 'Acme' });
    fireEvent.change(orgSelect, { target: { value: 'org-1' } });
    fireEvent.click(screen.getByTestId('contract-template-create-submit'));

    await waitFor(() => expect(api.createContractTemplate).toHaveBeenCalled());
    expect(api.createContractTemplate.mock.calls[0][0]).toMatchObject({
      name: 'New template',
      ownerScope: 'organization',
      orgId: 'org-1',
    });
  });

  it('creates a partner-wide template with no orgId', async () => {
    render(<TemplatesTab />);
    await screen.findByTestId('contract-templates-tab');

    fireEvent.click(screen.getByTestId('contract-templates-create-btn'));
    await screen.findByTestId('contract-template-create-dialog');
    fireEvent.change(screen.getByTestId('contract-template-name'), { target: { value: 'Partner MSA' } });
    fireEvent.click(screen.getByTestId('contract-template-owner-partner'));
    fireEvent.click(screen.getByTestId('contract-template-create-submit'));

    await waitFor(() => expect(api.createContractTemplate).toHaveBeenCalled());
    const body = api.createContractTemplate.mock.calls[0][0];
    expect(body).toMatchObject({ name: 'Partner MSA', ownerScope: 'partner' });
    expect(body.orgId).toBeUndefined();
  });

  it('hides the ownerScope selector for org-scoped users', async () => {
    getJwtClaims.mockReturnValue({ scope: 'organization', orgId: 'org-1', partnerId: null });
    render(<TemplatesTab />);
    await screen.findByTestId('contract-templates-tab');

    fireEvent.click(screen.getByTestId('contract-templates-create-btn'));
    await screen.findByTestId('contract-template-create-dialog');
    expect(screen.queryByTestId('contract-template-owner-partner')).not.toBeInTheDocument();
  });
});
