import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ORG_IMPORT_CAPABLE_PSA_PROVIDERS, PSA_PROVIDERS } from '@breeze/shared';
import PsaCompanyImport from './PsaCompanyImport';
import PsaConnectionList from './PsaConnectionList';

const fetchWithAuthMock = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a),
}));

// runAction surfaces success/error toasts via showToast from ../shared/Toast.
const showToastMock = vi.fn();
vi.mock('../shared/Toast', () => ({
  showToast: (...a: unknown[]) => showToastMock(...a),
}));

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

const CONNECTION = { id: 'conn-1', name: 'Acme ConnectWise', provider: 'connectwise' as const };

const PREVIEW_ROWS = [
  { index: 0, organization: 'Acme', site: 'HQ', externalId: 'cw-1', annotation: 'create', slug: 'acme', organizationId: null },
  { index: 1, organization: 'Widget', externalId: 'cw-2', annotation: 'link-match', slug: null, organizationId: 'org-w' },
  { index: 2, organization: 'Old Co', externalId: 'cw-3', annotation: 'name-match', slug: null, organizationId: 'org-o', matchedOrganizationName: 'Old Co' },
];

async function fetchCompanies(body: unknown = { rows: PREVIEW_ROWS, truncated: false }) {
  fetchWithAuthMock.mockReturnValueOnce(jsonResponse(body));
  fireEvent.click(screen.getByTestId('psa-company-import-preview'));
  await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PsaCompanyImport provider capability gate', () => {
  it('excludes jira from the capable provider list', () => {
    expect(ORG_IMPORT_CAPABLE_PSA_PROVIDERS).not.toContain('jira');
    // Every implemented provider is an explicit capable/not-capable decision:
    // adding one to @breeze/shared without classifying it fails here.
    expect([...ORG_IMPORT_CAPABLE_PSA_PROVIDERS, 'jira'].sort()).toEqual([...PSA_PROVIDERS].sort());
  });

  it('renders nothing for an import-incapable provider', () => {
    const { container } = render(
      <PsaCompanyImport
        connection={{ id: 'c-jira', name: 'Jira Prod', provider: 'jira' }}
        onClose={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('renders the modal for a capable provider', () => {
    render(<PsaCompanyImport connection={CONNECTION} onClose={vi.fn()} />);
    expect(screen.getByTestId('psa-company-import-modal')).toBeInTheDocument();
  });

  it('offers the list action only for capable connections', () => {
    render(
      <PsaConnectionList
        connections={[
          { id: 'c-jira', provider: 'jira', name: 'Jira Prod', status: 'active' },
          { id: 'c-cw', provider: 'connectwise', name: 'Acme CW', status: 'active' },
        ]}
        onImportCompanies={vi.fn()}
      />,
    );
    // Two rows rendered, but only the ConnectWise one gets the action.
    expect(screen.getAllByTestId('psa-connection-edit')).toHaveLength(2);
    expect(screen.getAllByTestId('psa-connection-import-companies')).toHaveLength(1);
  });

  it('renders no list action at all when the host passes no handler', () => {
    render(
      <PsaConnectionList
        connections={[{ id: 'c-cw', provider: 'connectwise', name: 'Acme CW', status: 'active' }]}
      />,
    );
    expect(screen.queryByTestId('psa-connection-import-companies')).toBeNull();
  });
});

describe('PsaCompanyImport truncation warning', () => {
  it('shows the prominent warning when the company list was capped', async () => {
    render(<PsaCompanyImport connection={CONNECTION} onClose={vi.fn()} />);
    await fetchCompanies({ rows: PREVIEW_ROWS, truncated: true });

    const warning = await screen.findByTestId('psa-company-import-truncated');
    expect(warning).toHaveAttribute('role', 'alert');
    // The copy must name the cap and say the import will be partial.
    expect(warning).toHaveTextContent('1000');
    expect(warning).toHaveTextContent(/incomplete/i);
  });

  it('does not show the warning when the whole list was fetched', async () => {
    render(<PsaCompanyImport connection={CONNECTION} onClose={vi.fn()} />);
    await fetchCompanies({ rows: PREVIEW_ROWS, truncated: false });

    await screen.findByTestId('psa-company-import-table');
    expect(screen.queryByTestId('psa-company-import-truncated')).toBeNull();
  });
});

describe('PsaCompanyImport preview → commit', () => {
  it('POSTs an EMPTY preview body to the connection-scoped route', async () => {
    render(<PsaCompanyImport connection={CONNECTION} onClose={vi.fn()} />);
    await fetchCompanies();

    const call = fetchWithAuthMock.mock.calls[0]!;
    expect(call[0]).toBe('/psa/connections/conn-1/import/preview');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    // The connection id in the path is the whole input — the client picks
    // neither the companies nor the cap.
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('renders the shared preview table with the default selection', async () => {
    render(<PsaCompanyImport connection={CONNECTION} onClose={vi.fn()} />);
    await fetchCompanies();

    await screen.findByTestId('psa-company-import-table');
    expect(screen.getByTestId('psa-company-import-badge-0')).toHaveTextContent('New');
    expect(screen.getByTestId('psa-company-import-select-0')).toBeChecked();
    expect(screen.getByTestId('psa-company-import-select-1')).toBeChecked();
    // name-match must be acknowledged deliberately.
    expect(screen.getByTestId('psa-company-import-select-2')).not.toBeChecked();
  });

  it('commits the acknowledged rows WITHOUT externalSystem (the server forces it)', async () => {
    const onImported = vi.fn();
    render(<PsaCompanyImport connection={CONNECTION} onClose={vi.fn()} onImported={onImported} />);
    await fetchCompanies();
    await screen.findByTestId('psa-company-import-table');

    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({
      imported: [{ index: 0, organization: 'Acme', organizationId: 'org-a' }],
      updated: [],
      skipped: [{ index: 1, organization: 'Widget', reason: 'already_linked' }],
      errors: [],
    }));
    fireEvent.click(screen.getByTestId('psa-company-import-submit'));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    const call = fetchWithAuthMock.mock.calls[1]!;
    expect(call[0]).toBe('/psa/connections/conn-1/import');
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.mode).toBe('skip');
    expect(body.rows).toEqual([
      { organization: 'Acme', site: 'HQ', externalId: 'cw-1', expectedAnnotation: 'create' },
      { organization: 'Widget', externalId: 'cw-2', expectedAnnotation: 'link-match', expectedOrganizationId: 'org-w' },
    ]);
    for (const row of body.rows) {
      expect(row).not.toHaveProperty('externalSystem');
    }

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })),
    );
    expect(onImported).toHaveBeenCalled();
  });

  it('sends reactivate:true only when a soft-deleted match is ticked', async () => {
    render(<PsaCompanyImport connection={CONNECTION} onClose={vi.fn()} />);
    await fetchCompanies({
      rows: [
        { index: 0, organization: 'Dead Co', externalId: 'cw-9', annotation: 'matched-soft-deleted', slug: null, organizationId: 'org-dead' },
      ],
      truncated: false,
    });
    await screen.findByTestId('psa-company-import-table');

    expect(screen.getByTestId('psa-company-import-select-0')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('psa-company-import-select-0'));

    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({
      imported: [], updated: [{ index: 0, organization: 'Dead Co', organizationId: 'org-dead' }], skipped: [], errors: [],
    }));
    fireEvent.click(screen.getByTestId('psa-company-import-submit'));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse((fetchWithAuthMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.rows).toEqual([
      {
        organization: 'Dead Co',
        externalId: 'cw-9',
        expectedAnnotation: 'matched-soft-deleted',
        expectedOrganizationId: 'org-dead',
        reactivate: true,
      },
    ]);
  });

  it('switches the commit to update mode', async () => {
    render(<PsaCompanyImport connection={CONNECTION} onClose={vi.fn()} />);
    await fetchCompanies();
    await screen.findByTestId('psa-company-import-table');

    fireEvent.change(screen.getByTestId('psa-company-import-mode'), { target: { value: 'update' } });
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ imported: [], updated: [], skipped: [], errors: [] }));
    fireEvent.click(screen.getByTestId('psa-company-import-submit'));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse((fetchWithAuthMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.mode).toBe('update');
  });

  it('renders an empty-state instead of a table when the PSA has no companies', async () => {
    render(<PsaCompanyImport connection={CONNECTION} onClose={vi.fn()} />);
    await fetchCompanies({ rows: [], truncated: false });

    expect(await screen.findByTestId('psa-company-import-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('psa-company-import-table')).toBeNull();
  });
});

describe('PsaCompanyImport failure surfacing', () => {
  it('toasts an error when the preview request fails', async () => {
    render(<PsaCompanyImport connection={CONNECTION} onClose={vi.fn()} />);
    // A PSA that errors mid-listing surfaces as a 502 from the route.
    fetchWithAuthMock.mockReturnValueOnce(
      jsonResponse({ error: 'PSA returned an error while listing companies' }, 502),
    );
    fireEvent.click(screen.getByTestId('psa-company-import-preview'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
    );
    expect(screen.queryByTestId('psa-company-import-table')).toBeNull();
  });

  it('toasts an error and lists failures when every row fails', async () => {
    render(<PsaCompanyImport connection={CONNECTION} onClose={vi.fn()} />);
    await fetchCompanies();
    await screen.findByTestId('psa-company-import-table');

    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({
      imported: [], updated: [], skipped: [],
      errors: [
        { index: 0, organization: 'Acme', error: 'boom' },
        { index: 1, organization: 'Widget', error: 'kaput' },
      ],
    }));
    fireEvent.click(screen.getByTestId('psa-company-import-submit'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
    );
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(await screen.findByTestId('psa-company-import-failure-0')).toHaveTextContent('boom');
    expect(screen.getByTestId('psa-company-import-failure-1')).toHaveTextContent('kaput');
  });

  it('toasts a warning on partial success', async () => {
    render(<PsaCompanyImport connection={CONNECTION} onClose={vi.fn()} />);
    await fetchCompanies();
    await screen.findByTestId('psa-company-import-table');

    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({
      imported: [{ index: 0, organization: 'Acme', organizationId: 'org-a' }],
      updated: [], skipped: [],
      errors: [{ index: 1, organization: 'Widget', error: 'boom' }],
    }));
    fireEvent.click(screen.getByTestId('psa-company-import-submit'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })),
    );
  });

  it('surfaces a failed commit request through runAction', async () => {
    render(<PsaCompanyImport connection={CONNECTION} onClose={vi.fn()} />);
    await fetchCompanies();
    await screen.findByTestId('psa-company-import-table');

    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ error: 'rate limited' }, 429));
    fireEvent.click(screen.getByTestId('psa-company-import-submit'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
    );
    // The preview stays on screen so the acknowledged selection is not lost.
    expect(screen.getByTestId('psa-company-import-table')).toBeInTheDocument();
  });

  it('leaves a 401 to the auth redirect instead of toasting', async () => {
    const onUnauthorized = vi.fn();
    render(
      <PsaCompanyImport connection={CONNECTION} onClose={vi.fn()} onUnauthorized={onUnauthorized} />,
    );
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ error: 'unauthorized' }, 401));
    fireEvent.click(screen.getByTestId('psa-company-import-preview'));

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
    expect(showToastMock).not.toHaveBeenCalled();
  });
});

describe('PsaCompanyImport modal chrome', () => {
  it('calls onClose from the close button', () => {
    const onClose = vi.fn();
    render(<PsaCompanyImport connection={CONNECTION} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('psa-company-import-close'));
    expect(onClose).toHaveBeenCalled();
  });
});
