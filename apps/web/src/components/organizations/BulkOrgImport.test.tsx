import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BulkOrgImport from './BulkOrgImport';

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

const CSV = 'organization,site,external id\nAcme,HQ,1\nWidget,Depot,2\nOld Co,Main,3\nBroken,,4\n';

async function uploadCsv(csv = CSV) {
  const file = new File([csv], 'orgs.csv', { type: 'text/csv' });
  // jsdom File lacks .text() in some versions — polyfill defensively.
  if (typeof file.text !== 'function') {
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
  }
  const input = screen.getByTestId('bulk-org-import-file-input');
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() =>
    expect(screen.getByTestId('bulk-org-import-map-organization')).toBeInTheDocument(),
  );
}

const PREVIEW_ROWS = [
  { index: 0, organization: 'Acme', site: 'HQ', externalId: '1', annotation: 'create', slug: 'acme', organizationId: null },
  { index: 1, organization: 'Widget', site: 'Depot', externalId: '2', annotation: 'link-match', slug: null, organizationId: 'org-w' },
  { index: 2, organization: 'Old Co', site: 'Main', externalId: '3', annotation: 'name-match', slug: null, organizationId: 'org-o', matchedOrganizationName: 'Old Co' },
  { index: 3, organization: 'Broken', externalId: '4', annotation: 'conflict', slug: null, organizationId: null, conflictReason: 'boom conflict' },
];

async function uploadAndPreview() {
  await uploadCsv();
  fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ rows: PREVIEW_ROWS }));
  fireEvent.click(screen.getByTestId('bulk-org-import-preview'));
  await waitFor(() =>
    expect(screen.getByTestId('bulk-org-import-table')).toBeInTheDocument(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BulkOrgImport', () => {
  it('auto-guesses the column mapping from CSV headers', async () => {
    render(<BulkOrgImport />);
    await uploadCsv();
    expect(screen.getByTestId('bulk-org-import-map-organization')).toHaveValue('organization');
    expect(screen.getByTestId('bulk-org-import-map-site')).toHaveValue('site');
    expect(screen.getByTestId('bulk-org-import-map-externalId')).toHaveValue('external id');
  });

  it('previews rows with per-annotation badges and default selection', async () => {
    render(<BulkOrgImport />);
    await uploadAndPreview();

    // Preview POST carried the parsed+mapped rows.
    const previewCall = fetchWithAuthMock.mock.calls[0]!;
    expect(previewCall[0]).toBe('/orgs/import/preview');
    const body = JSON.parse((previewCall[1] as RequestInit).body as string);
    expect(body.rows[0]).toEqual({ organization: 'Acme', site: 'HQ', externalId: '1' });
    expect(body.rows[3]).toEqual({ organization: 'Broken', externalId: '4' }); // empty site omitted

    // Badges.
    expect(screen.getByTestId('bulk-org-import-badge-0')).toHaveTextContent('New');
    expect(screen.getByTestId('bulk-org-import-badge-1')).toHaveTextContent('Already linked');
    expect(screen.getByTestId('bulk-org-import-badge-2')).toHaveTextContent('Name match — confirm');
    expect(screen.getByTestId('bulk-org-import-badge-3')).toHaveTextContent('Conflict');
    expect(screen.getByTestId('bulk-org-import-row-3')).toHaveTextContent('boom conflict');

    // Default selection: create + link-match checked, name-match unchecked,
    // conflict disabled.
    expect(screen.getByTestId('bulk-org-import-select-0')).toBeChecked();
    expect(screen.getByTestId('bulk-org-import-select-1')).toBeChecked();
    expect(screen.getByTestId('bulk-org-import-select-2')).not.toBeChecked();
    expect(screen.getByTestId('bulk-org-import-select-3')).toBeDisabled();
  });

  it('select-all only toggles create/link-match rows — never acknowledges name-matches or reactivates soft-deleted matches', async () => {
    render(<BulkOrgImport />);
    await uploadCsv();
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({
      rows: [
        { index: 0, organization: 'Acme', annotation: 'create', slug: 'acme', organizationId: null },
        { index: 1, organization: 'Old Co', annotation: 'name-match', slug: null, organizationId: 'org-o', matchedOrganizationName: 'Old Co' },
        { index: 2, organization: 'Dead Co', annotation: 'matched-soft-deleted', slug: null, organizationId: 'org-dead' },
      ],
    }));
    fireEvent.click(screen.getByTestId('bulk-org-import-preview'));
    await waitFor(() =>
      expect(screen.getByTestId('bulk-org-import-select-all')).toBeInTheDocument(),
    );

    // create pre-selected → select-all reads checked; clicking it clears only
    // the bulk set, then clicking again re-adds only the bulk set.
    fireEvent.click(screen.getByTestId('bulk-org-import-select-all'));
    expect(screen.getByTestId('bulk-org-import-select-0')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('bulk-org-import-select-all'));
    expect(screen.getByTestId('bulk-org-import-select-0')).toBeChecked();
    expect(screen.getByTestId('bulk-org-import-select-1')).not.toBeChecked();
    expect(screen.getByTestId('bulk-org-import-select-2')).not.toBeChecked();
  });

  it('refuses to confirm a name match whose org is already linked to the same system', async () => {
    // The link table is unique on (partner, system, external id), so confirming
    // this match would write a SECOND link row and collapse two source records
    // onto one tenant. The guard lives in the shared preview table, so the CSV
    // importer inherits it — the API refuses it too (match-already-linked).
    render(<BulkOrgImport />);
    await uploadCsv();
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({
      rows: [
        { index: 0, organization: 'Acme', annotation: 'create', slug: 'acme', organizationId: null },
        {
          index: 1, organization: 'Contoso Ltd', externalId: '77', externalSystem: 'datto_rmm',
          annotation: 'name-match', slug: null, organizationId: 'org-contoso',
          matchedOrganizationName: 'Contoso', matchedOrganizationLinkedToSystem: true,
        },
      ],
    }));
    fireEvent.click(screen.getByTestId('bulk-org-import-preview'));
    await waitFor(() =>
      expect(screen.getByTestId('bulk-org-import-table')).toBeInTheDocument(),
    );

    expect(screen.getByTestId('bulk-org-import-select-1')).toBeDisabled();
    expect(screen.getByTestId('bulk-org-import-select-1')).not.toBeChecked();
    expect(screen.getByTestId('bulk-org-import-already-linked-1'))
      .toHaveTextContent(/Contoso.*already linked/i);

    // Round-tripping select-all (create row is pre-selected, so the first click
    // clears the bulk set and the second re-adds it) must not sneak it in.
    fireEvent.click(screen.getByTestId('bulk-org-import-select-all'));
    fireEvent.click(screen.getByTestId('bulk-org-import-select-all'));
    expect(screen.getByTestId('bulk-org-import-select-0')).toBeChecked();
    expect(screen.getByTestId('bulk-org-import-select-1')).not.toBeChecked();

    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({
      imported: [{ index: 0, organization: 'Acme', organizationId: 'org-a' }],
      updated: [], skipped: [], errors: [],
    }));
    fireEvent.click(screen.getByTestId('bulk-org-import-submit'));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse((fetchWithAuthMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.rows).toEqual([
      { organization: 'Acme', expectedAnnotation: 'create' },
    ]);
  });

  it('commits selected rows with expectedAnnotation and shows a success toast', async () => {
    render(<BulkOrgImport />);
    await uploadAndPreview();

    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({
      imported: [{ index: 0, organization: 'Acme', organizationId: 'org-a' }],
      updated: [],
      skipped: [{ index: 1, organization: 'Widget', reason: 'already_linked' }],
      errors: [],
    }));
    fireEvent.click(screen.getByTestId('bulk-org-import-submit'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })),
    );
    const commitCall = fetchWithAuthMock.mock.calls[1]!;
    expect(commitCall[0]).toBe('/orgs/import');
    const body = JSON.parse((commitCall[1] as RequestInit).body as string);
    expect(body.mode).toBe('skip');
    // Only the two default-selected rows, each carrying its preview annotation.
    expect(body.rows).toEqual([
      { organization: 'Acme', site: 'HQ', externalId: '1', expectedAnnotation: 'create' },
      // Matched rows pin the acknowledged org identity for the commit re-check.
      { organization: 'Widget', site: 'Depot', externalId: '2', expectedAnnotation: 'link-match', expectedOrganizationId: 'org-w' },
    ]);
  });

  it('sends reactivate: true when a soft-deleted match is deliberately selected', async () => {
    render(<BulkOrgImport />);
    await uploadCsv();
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({
      rows: [
        { index: 0, organization: 'Acme', annotation: 'matched-soft-deleted', slug: null, organizationId: 'org-dead' },
      ],
    }));
    fireEvent.click(screen.getByTestId('bulk-org-import-preview'));
    await waitFor(() =>
      expect(screen.getByTestId('bulk-org-import-select-0')).toBeInTheDocument(),
    );

    // Soft-deleted rows are NOT selected by default; ticking is the opt-in.
    expect(screen.getByTestId('bulk-org-import-select-0')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('bulk-org-import-select-0'));

    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({
      imported: [], updated: [{ index: 0, organization: 'Acme', organizationId: 'org-dead' }], skipped: [], errors: [],
    }));
    fireEvent.click(screen.getByTestId('bulk-org-import-submit'));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse((fetchWithAuthMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.rows).toEqual([
      { organization: 'Acme', expectedAnnotation: 'matched-soft-deleted', expectedOrganizationId: 'org-dead', reactivate: true },
    ]);
  });

  it('shows an ERROR toast and lists failures when every row fails', async () => {
    render(<BulkOrgImport />);
    await uploadAndPreview();

    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({
      imported: [], updated: [], skipped: [],
      errors: [
        { index: 0, organization: 'Acme', error: 'boom' },
        { index: 1, organization: 'Widget', error: 'kaput' },
      ],
    }));
    fireEvent.click(screen.getByTestId('bulk-org-import-submit'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
    );
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    await waitFor(() =>
      expect(screen.getByTestId('bulk-org-import-failure-0')).toHaveTextContent('boom'),
    );
    expect(screen.getByTestId('bulk-org-import-failure-1')).toHaveTextContent('kaput');
  });

  it('shows a WARNING toast on partial failure', async () => {
    render(<BulkOrgImport />);
    await uploadAndPreview();

    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({
      imported: [{ index: 0, organization: 'Acme', organizationId: 'org-a' }],
      updated: [], skipped: [],
      errors: [{ index: 1, organization: 'Widget', error: 'boom' }],
    }));
    fireEvent.click(screen.getByTestId('bulk-org-import-submit'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })),
    );
  });

  it('calls onImported after a commit that created orgs', async () => {
    const onImported = vi.fn();
    render(<BulkOrgImport onImported={onImported} />);
    await uploadAndPreview();

    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({
      imported: [{ index: 0, organization: 'Acme', organizationId: 'org-a' }],
      updated: [], skipped: [], errors: [],
    }));
    fireEvent.click(screen.getByTestId('bulk-org-import-submit'));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });

  it('shows an error toast when the preview request fails', async () => {
    render(<BulkOrgImport />);
    await uploadCsv();
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ error: 'nope' }, 500));
    fireEvent.click(screen.getByTestId('bulk-org-import-preview'));
    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
    );
  });

  it('mode selector switches the commit to update', async () => {
    render(<BulkOrgImport />);
    await uploadAndPreview();

    fireEvent.change(screen.getByTestId('bulk-org-import-mode'), { target: { value: 'update' } });
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ imported: [], updated: [], skipped: [], errors: [] }));
    fireEvent.click(screen.getByTestId('bulk-org-import-submit'));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse((fetchWithAuthMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.mode).toBe('update');
  });
});
