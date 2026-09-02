import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BulkContactImport from './BulkContactImport';
import type { AnnotatedContactRow } from './ContactImportPreviewTable';

const fetchWithAuthMock = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a),
}));

const showToastMock = vi.fn();
vi.mock('../shared/Toast', () => ({
  showToast: (...a: unknown[]) => showToastMock(...a),
}));

const ORG_ID = '11111111-1111-4111-8111-111111111111';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

const CSV = [
  'Full Name,Email Address,Phone,Mobile,Job Title,Roles,Site,Contact ID',
  'Ada Byron,ada@acme.test,555-0100,555-0199,CTO,"billing,Technical",HQ,cw-1',
  'Grace H,grace@acme.test,,,,,,cw-2',
  'Alan T,alan@acme.test,,,,,,',
  'Katherine J,,555-0111,,,,,',
  ',,,,,,,',
].join('\n') + '\n';

async function uploadCsv(csv = CSV) {
  const file = new File([csv], 'contacts.csv', { type: 'text/csv' });
  if (typeof file.text !== 'function') {
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
  }
  fireEvent.change(screen.getByTestId('bulk-contact-import-file-input'), {
    target: { files: [file] },
  });
  await waitFor(() =>
    expect(screen.getByTestId('bulk-contact-import-map-name')).toBeInTheDocument(),
  );
}

/** Uploads a file without waiting for the mapping grid — for files that produce none. */
function uploadRaw(csv: string, name = 'contacts.csv') {
  const file = new File([csv], name, { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
  fireEvent.change(screen.getByTestId('bulk-contact-import-file-input'), {
    target: { files: [file] },
  });
}

/** A file whose `text()` rejects, the way a revoked/renamed local file does. */
function uploadUnreadableFile() {
  const file = new File(['x'], 'contacts.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'text', {
    value: () => Promise.reject(new Error('NotReadableError')),
  });
  fireEvent.change(screen.getByTestId('bulk-contact-import-file-input'), {
    target: { files: [file] },
  });
}

const PREVIEW_ROWS: AnnotatedContactRow[] = [
  {
    index: 0, name: 'Ada Byron', email: 'ada@acme.test', site: 'HQ', externalId: 'cw-1',
    annotation: 'create', organizationId: ORG_ID, siteId: 'site-hq', contactId: null,
  },
  {
    index: 1, name: 'Grace H', email: 'grace@acme.test', externalId: 'cw-2',
    annotation: 'link-match', organizationId: ORG_ID, siteId: null, contactId: 'c-grace',
    matchedContactName: 'Grace Hopper',
  },
  {
    index: 2, name: 'Alan T', email: 'alan@acme.test',
    annotation: 'email-match', organizationId: ORG_ID, siteId: null, contactId: 'c-alan',
    matchedContactName: 'Alan Turing', matchedContactEmail: 'alan@acme.test',
  },
  {
    index: 3, name: 'Katherine J', phone: '555-0111',
    annotation: 'conflict', organizationId: ORG_ID, siteId: null, contactId: null,
    conflictReason: '2 contacts in Acme are named "Katherine J"',
  },
];

async function uploadAndPreview(rows: AnnotatedContactRow[] = PREVIEW_ROWS) {
  await uploadCsv();
  fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ rows }));
  fireEvent.click(screen.getByTestId('bulk-contact-import-preview'));
  await waitFor(() =>
    expect(screen.getByTestId('bulk-contact-import-table')).toBeInTheDocument(),
  );
}

function commitBody(callIndex = -1) {
  const call = fetchWithAuthMock.mock.calls.at(callIndex)!;
  return JSON.parse((call[1] as RequestInit).body as string);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BulkContactImport', () => {
  it('auto-guesses the column mapping from CSV headers', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadCsv();
    expect(screen.getByTestId('bulk-contact-import-map-name')).toHaveValue('Full Name');
    expect(screen.getByTestId('bulk-contact-import-map-email')).toHaveValue('Email Address');
    expect(screen.getByTestId('bulk-contact-import-map-phone')).toHaveValue('Phone');
    expect(screen.getByTestId('bulk-contact-import-map-mobile')).toHaveValue('Mobile');
    expect(screen.getByTestId('bulk-contact-import-map-title')).toHaveValue('Job Title');
    expect(screen.getByTestId('bulk-contact-import-map-roles')).toHaveValue('Roles');
    expect(screen.getByTestId('bulk-contact-import-map-site')).toHaveValue('Site');
    expect(screen.getByTestId('bulk-contact-import-map-externalId')).toHaveValue('Contact ID');
  });

  it('pins every row to this organization and drops rows with no identifier', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadAndPreview();

    const call = fetchWithAuthMock.mock.calls[0]!;
    expect(call[0]).toBe('/orgs/contacts/import/preview');
    expect((call[1] as RequestInit).method).toBe('POST');
    const body = commitBody(0);
    // The trailing all-blank CSV line satisfies no identifier; sending it would
    // 400 the WHOLE request, so it never leaves the browser.
    expect(body.rows).toHaveLength(4);
    for (const row of body.rows) expect(row.organizationId).toBe(ORG_ID);
    expect(body.rows[0]).toEqual({
      organizationId: ORG_ID,
      name: 'Ada Byron',
      email: 'ada@acme.test',
      phone: '555-0100',
      mobile: '555-0199',
      title: 'CTO',
      roles: ['billing', 'technical'],
      site: 'HQ',
      externalId: 'cw-1',
    });
    // Blank cells are omitted, not sent as empty strings.
    expect(body.rows[2]).toEqual({
      organizationId: ORG_ID,
      name: 'Alan T',
      email: 'alan@acme.test',
    });
  });

  it('renders a badge per annotation and pre-checks only create + link-match', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadAndPreview();

    expect(screen.getByTestId('bulk-contact-import-badge-0')).toHaveTextContent('New');
    expect(screen.getByTestId('bulk-contact-import-badge-1')).toHaveTextContent('Already linked');
    expect(screen.getByTestId('bulk-contact-import-badge-2')).toHaveTextContent('Email match');
    expect(screen.getByTestId('bulk-contact-import-badge-3')).toHaveTextContent('Conflict');

    expect(screen.getByTestId('bulk-contact-import-select-0')).toBeChecked();
    expect(screen.getByTestId('bulk-contact-import-select-1')).toBeChecked();
    // A fuzzy hint needs a deliberate human tick.
    expect(screen.getByTestId('bulk-contact-import-select-2')).not.toBeChecked();
    // A conflict can never be committed at all.
    expect(screen.getByTestId('bulk-contact-import-select-3')).toBeDisabled();
  });

  it('leaves a fuzzy row unticked when select-all is used', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadAndPreview();
    // Clear the default selection, then select-all: the fuzzy row must not be
    // swept in by a bulk toggle.
    fireEvent.click(screen.getByTestId('bulk-contact-import-select-all'));
    fireEvent.click(screen.getByTestId('bulk-contact-import-select-all'));
    expect(screen.getByTestId('bulk-contact-import-select-0')).toBeChecked();
    expect(screen.getByTestId('bulk-contact-import-select-1')).toBeChecked();
    expect(screen.getByTestId('bulk-contact-import-select-2')).not.toBeChecked();
  });

  it('renders a non-fatal warning on a row that still imports', async () => {
    const warned: AnnotatedContactRow = {
      index: 0, name: 'Ada Byron', email: 'shared@acme.test', externalId: 'cw-1',
      annotation: 'create', organizationId: ORG_ID, siteId: null, contactId: null,
      warning: '3 existing contacts in Acme share shared@acme.test; creating another,'
        + ' because this row carries its own externalId',
    };
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadAndPreview([warned]);
    expect(screen.getByTestId('bulk-contact-import-warning-0'))
      .toHaveTextContent('3 existing contacts in Acme share shared@acme.test');
    expect(screen.getByTestId('bulk-contact-import-select-0')).toBeChecked();
  });

  it('commits the acknowledged rows with mode and the fuzzy match pin', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadAndPreview();

    // Acknowledge the email-match deliberately, and ask for update mode.
    fireEvent.click(screen.getByTestId('bulk-contact-import-select-2'));
    fireEvent.change(screen.getByTestId('bulk-contact-import-mode'), {
      target: { value: 'update' },
    });

    fetchWithAuthMock.mockReturnValueOnce(
      jsonResponse({
        imported: [{ index: 0, organizationId: ORG_ID, contactId: 'c-ada', name: 'Ada Byron', createdLink: true }],
        updated: [{ index: 1, organizationId: ORG_ID, contactId: 'c-grace', name: 'Grace H', createdLink: false }],
        skipped: [],
        errors: [],
      }),
    );
    fireEvent.click(screen.getByTestId('bulk-contact-import-submit'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalled());

    const call = fetchWithAuthMock.mock.calls.at(-1)!;
    expect(call[0]).toBe('/orgs/contacts/import');
    const body = commitBody();
    expect(body.mode).toBe('update');
    expect(body.rows).toHaveLength(3); // create + link-match + acknowledged email-match
    expect(body.rows.map((r: { expectedAnnotation: string }) => r.expectedAnnotation))
      .toEqual(['create', 'link-match', 'email-match']);
    const fuzzy = body.rows[2];
    expect(fuzzy.expectedAnnotation).toBe('email-match');
    // Required by the server whenever the acknowledgement is fuzzy.
    expect(fuzzy.expectedContactId).toBe('c-alan');
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' }),
    );
  });

  it('defaults mode to skip', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadAndPreview();
    expect(screen.getByTestId('bulk-contact-import-mode')).toHaveValue('skip');

    fetchWithAuthMock.mockReturnValueOnce(
      jsonResponse({ imported: [], updated: [], skipped: [], errors: [] }),
    );
    fireEvent.click(screen.getByTestId('bulk-contact-import-submit'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    expect(commitBody().mode).toBe('skip');
  });

  it('warns and lists per-row failures on a partial import', async () => {
    const onImported = vi.fn();
    render(<BulkContactImport orgId={ORG_ID} onImported={onImported} />);
    await uploadAndPreview();

    fetchWithAuthMock.mockReturnValueOnce(
      jsonResponse({
        imported: [{ index: 0, organizationId: ORG_ID, contactId: 'c-ada', name: 'Ada Byron', createdLink: true }],
        updated: [],
        skipped: [{ index: 1, organizationId: ORG_ID, contactId: 'c-grace', reason: 'already_linked' }],
        errors: [
          { index: 1, error: 'Match changed since preview', code: 'match-changed' },
        ],
      }),
    );
    fireEvent.click(screen.getByTestId('bulk-contact-import-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('bulk-contact-import-failures')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('bulk-contact-import-failure-1'))
      .toHaveTextContent('Match changed since preview');
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning' }),
    );
    // A partial success still wrote something, so the host refetches.
    expect(onImported).toHaveBeenCalled();
  });

  it('reports an all-failed commit as an error rather than a success', async () => {
    const onImported = vi.fn();
    render(<BulkContactImport orgId={ORG_ID} onImported={onImported} />);
    await uploadAndPreview();

    fetchWithAuthMock.mockReturnValueOnce(
      jsonResponse({
        imported: [],
        updated: [],
        skipped: [],
        errors: [
          { index: 0, error: 'Annotation changed since preview', code: 'annotation-changed' },
          { index: 1, error: 'Site does not belong to this organization', code: 'site-not-in-org' },
        ],
      }),
    );
    fireEvent.click(screen.getByTestId('bulk-contact-import-submit'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(onImported).not.toHaveBeenCalled();
  });

  it('surfaces a failed preview through runAction and shows no table', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadCsv();
    fetchWithAuthMock.mockReturnValueOnce(
      jsonResponse({ error: 'Access to this site denied' }, 403),
    );
    fireEvent.click(screen.getByTestId('bulk-contact-import-preview'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Access to this site denied' }),
      ),
    );
    expect(screen.queryByTestId('bulk-contact-import-table')).not.toBeInTheDocument();
  });

  it('routes a 401 to the host rather than toasting it', async () => {
    const onUnauthorized = vi.fn();
    render(<BulkContactImport orgId={ORG_ID} onUnauthorized={onUnauthorized} />);
    await uploadCsv();
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ error: 'Unauthorized' }, 401));
    fireEvent.click(screen.getByTestId('bulk-contact-import-preview'));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('refuses to preview a file with no identifier column mapped', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadCsv('Site,Contact ID\nHQ,cw-1\n');
    expect(screen.getByTestId('bulk-contact-import-preview')).toBeDisabled();
    expect(screen.getByTestId('bulk-contact-import-identifier-hint')).toBeInTheDocument();
  });
});

describe('BulkContactImport failure attribution', () => {
  it('names the contact the server actually refused, not the row at that preview index', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadAndPreview();

    // Drop the first pre-checked row and opt the fuzzy row in, so the SUBMITTED
    // array is [Grace H, Alan T] — preview indexes 1 and 2, submitted 0 and 1.
    fireEvent.click(screen.getByTestId('bulk-contact-import-select-0'));
    fireEvent.click(screen.getByTestId('bulk-contact-import-select-2'));

    fetchWithAuthMock.mockReturnValueOnce(
      jsonResponse({
        imported: [{ index: 0, organizationId: ORG_ID, contactId: 'c-grace', name: 'Grace H', createdLink: false }],
        updated: [],
        skipped: [],
        // Submitted position 1 is Alan T, NOT the preview row with index 1.
        errors: [{ index: 1, error: 'Match changed since preview', code: 'match-changed' }],
      }),
    );
    fireEvent.click(screen.getByTestId('bulk-contact-import-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('bulk-contact-import-failure-1')).toBeInTheDocument(),
    );
    const failure = screen.getByTestId('bulk-contact-import-failure-1');
    expect(failure).toHaveTextContent('Alan T');
    expect(failure).not.toHaveTextContent('Grace H');
  });
});

describe('BulkContactImport dropped rows', () => {
  it('says how many rows were dropped for having no identifier', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadCsv();
    // The trailing all-comma line satisfies no identifier and never leaves the
    // browser; silently shrinking the count is how an operator loses a row.
    expect(screen.getByTestId('bulk-contact-import-dropped')).toHaveTextContent('1 row');
    expect(screen.getByTestId('bulk-contact-import-dropped')).toHaveTextContent('no name');
  });

  it('explains a file whose every row was dropped rather than offering "Check 0 rows"', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadCsv('Full Name,Site\n,HQ\n,Depot\n');
    expect(screen.getByTestId('bulk-contact-import-preview')).toBeDisabled();
    expect(screen.getByTestId('bulk-contact-import-dropped')).toHaveTextContent('2 rows');
  });

  it('shows no dropped notice when every row carries an identifier', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadCsv('Full Name,Email Address\nAda,ada@acme.test\n');
    expect(screen.queryByTestId('bulk-contact-import-dropped')).not.toBeInTheDocument();
  });

  it('refuses to preview a file past the server row cap', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => `Person ${i},p${i}@acme.test`);
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadCsv(['Full Name,Email Address', ...rows].join('\n') + '\n');
    expect(screen.getByTestId('bulk-contact-import-too-many')).toHaveTextContent('1000');
    expect(screen.getByTestId('bulk-contact-import-preview')).toBeDisabled();
  });
});

describe('BulkContactImport file failures', () => {
  it('toasts a file that cannot be read instead of going silent', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    uploadUnreadableFile();
    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
    );
    // The panel resets rather than keeping a half-loaded file on screen.
    expect(screen.queryByTestId('bulk-contact-import-map-name')).not.toBeInTheDocument();
  });

  it('explains a file that parses to no columns at all', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    uploadRaw('\n\n');
    await waitFor(() =>
      expect(screen.getByTestId('bulk-contact-import-no-columns')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('bulk-contact-import-map-name')).not.toBeInTheDocument();
  });
});

describe('BulkContactImport commit outcomes', () => {
  it('does not call a commit that wrote nothing a success', async () => {
    const onImported = vi.fn();
    render(<BulkContactImport orgId={ORG_ID} onImported={onImported} />);
    await uploadAndPreview();

    // The default re-import path: link-match rows are pre-ticked and skip mode
    // leaves them alone, so the server writes nothing at all.
    fetchWithAuthMock.mockReturnValueOnce(
      jsonResponse({
        imported: [],
        updated: [],
        skipped: [
          { index: 0, organizationId: ORG_ID, contactId: 'c-ada', reason: 'already_linked' },
          { index: 1, organizationId: ORG_ID, contactId: 'c-grace', reason: 'already_linked' },
        ],
        errors: [],
      }),
    );
    fireEvent.click(screen.getByTestId('bulk-contact-import-submit'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalled());

    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Nothing imported') }),
    );
    expect(onImported).not.toHaveBeenCalled();
  });

  it('lists every skipped row with its contact and a translated reason', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadAndPreview();

    fetchWithAuthMock.mockReturnValueOnce(
      jsonResponse({
        imported: [{ index: 0, organizationId: ORG_ID, contactId: 'c-ada', name: 'Ada Byron', createdLink: true }],
        updated: [],
        // Submitted position 1 is Grace H (the pre-ticked link-match).
        skipped: [{ index: 1, organizationId: ORG_ID, contactId: 'c-grace', reason: 'already_linked' }],
        errors: [],
      }),
    );
    fireEvent.click(screen.getByTestId('bulk-contact-import-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('bulk-contact-import-skipped')).toBeInTheDocument(),
    );
    const row = screen.getByTestId('bulk-contact-import-skipped-1');
    expect(row).toHaveTextContent('Grace H');
    expect(row).toHaveTextContent('already linked to an existing contact');
    // The raw server token is never the thing the operator reads.
    expect(row).not.toHaveTextContent('already_linked');
  });

  it('translates a server error code and keeps the server text as detail', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadAndPreview();

    fetchWithAuthMock.mockReturnValueOnce(
      jsonResponse({
        imported: [{ index: 0, organizationId: ORG_ID, contactId: 'c-ada', name: 'Ada Byron', createdLink: true }],
        updated: [],
        skipped: [],
        errors: [{
          index: 1,
          error: 'expectedContactId is required for an email-match acknowledgement',
          code: 'match-unconfirmed',
        }],
      }),
    );
    fireEvent.click(screen.getByTestId('bulk-contact-import-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('bulk-contact-import-failure-1')).toBeInTheDocument(),
    );
    const failure = screen.getByTestId('bulk-contact-import-failure-1');
    // The remedy the operator can act on, not the server's field name.
    expect(failure).toHaveTextContent('Tick the row and import again');
    // Nothing is lost: the server's own words stay available as detail.
    expect(screen.getByTestId('bulk-contact-import-failure-detail-1'))
      .toHaveTextContent('expectedContactId is required');
  });

  it('falls back to the server text for a code it does not know', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadAndPreview();

    fetchWithAuthMock.mockReturnValueOnce(
      jsonResponse({
        imported: [],
        updated: [],
        skipped: [],
        errors: [{ index: 0, error: 'Something new went wrong', code: 'brand-new-code' }],
      }),
    );
    fireEvent.click(screen.getByTestId('bulk-contact-import-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('bulk-contact-import-failure-0')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('bulk-contact-import-failure-0'))
      .toHaveTextContent('Something new went wrong');
  });
});

describe('parseRoles normalisation', () => {
  it('accepts comma, semicolon and pipe separators and normalises the labels', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadCsv('Full Name,Roles\nAda,"After Hours;portal|billing"\n');
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ rows: [] }));
    fireEvent.click(screen.getByTestId('bulk-contact-import-preview'));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(commitBody(0).rows[0].roles).toEqual(['after_hours', 'portal', 'billing']);
  });

  it('sends an unrecognised role through untouched rather than guessing a near one', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadCsv('Full Name,Roles\nAda,Chief Vibes\n');
    fetchWithAuthMock.mockReturnValueOnce(jsonResponse({ rows: [] }));
    fireEvent.click(screen.getByTestId('bulk-contact-import-preview'));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(commitBody(0).rows[0].roles).toEqual(['chief_vibes']);
  });
});

describe('BulkContactImport preview lifecycle', () => {
  it('clears a stale preview when the mapping changes', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadAndPreview();
    expect(screen.getByTestId('bulk-contact-import-table')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('bulk-contact-import-map-title'), {
      target: { value: '' },
    });
    expect(screen.queryByTestId('bulk-contact-import-table')).not.toBeInTheDocument();
  });

  it('clears the preview after a successful commit and leaves a summary line', async () => {
    render(<BulkContactImport orgId={ORG_ID} />);
    await uploadAndPreview();

    fetchWithAuthMock.mockReturnValueOnce(
      jsonResponse({
        imported: [{ index: 0, organizationId: ORG_ID, contactId: 'c-ada', name: 'Ada Byron', createdLink: true }],
        updated: [],
        skipped: [],
        errors: [],
      }),
    );
    fireEvent.click(screen.getByTestId('bulk-contact-import-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('bulk-contact-import-summary')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('bulk-contact-import-table')).not.toBeInTheDocument();
  });
});
