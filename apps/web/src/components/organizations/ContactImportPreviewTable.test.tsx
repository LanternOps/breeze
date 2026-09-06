import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ContactImportPreviewTable, {
  bulkSelectableContactRows,
  defaultContactPreviewSelection,
  isContactRowSelectable,
  toContactCommitRow,
  type AnnotatedContactRow,
} from './ContactImportPreviewTable';

const ROWS: AnnotatedContactRow[] = [
  {
    index: 0, name: 'Ada Byron', email: 'ada@acme.test', site: 'HQ',
    annotation: 'create', organizationId: 'org-1', siteId: 'site-hq', contactId: null,
  },
  {
    index: 1, name: 'Grace H', email: 'grace@acme.test', externalId: 'cw-9',
    annotation: 'link-match', organizationId: 'org-1', siteId: null, contactId: 'c-grace',
    matchedContactName: 'Grace Hopper', matchedContactEmail: 'grace@acme.test',
  },
  {
    index: 2, name: 'Alan T', email: 'alan@acme.test',
    annotation: 'email-match', organizationId: 'org-1', siteId: null, contactId: 'c-alan',
    matchedContactName: 'Alan Turing', matchedContactEmail: 'alan@acme.test',
  },
  {
    index: 3, name: 'Katherine J',
    annotation: 'name-match', organizationId: 'org-1', siteId: null, contactId: 'c-kat',
    matchedContactName: 'Katherine Johnson',
  },
  {
    index: 4, email: 'shared@acme.test',
    annotation: 'conflict', organizationId: 'org-1', siteId: null, contactId: null,
    conflictReason: '3 contacts in Acme already use shared@acme.test',
  },
  {
    index: 5, name: 'Nobody', organization: 'Ghost Co',
    annotation: 'org-not-found', organizationId: null, siteId: null, contactId: null,
    conflictReason: 'No such organization under this partner',
  },
];

/**
 * A `create` row that ALSO carries a non-fatal warning: the address matched
 * several existing contacts, and the row was created anyway because it carries
 * its own external id. The row still applies exactly as annotated.
 */
const WARNED_ROW: AnnotatedContactRow = {
  index: 6,
  name: 'Ada Byron',
  email: 'shared@acme.test',
  externalId: 'cw-42',
  annotation: 'create',
  organizationId: 'org-1',
  siteId: null,
  contactId: null,
  warning: '3 existing contacts in Acme share shared@acme.test; creating another,'
    + ' because this row carries its own externalId',
};

function nextSelection(
  onSelectedChange: ReturnType<typeof vi.fn>,
  prev: Iterable<number>,
  callIndex = -1,
): Set<number> {
  const arg = onSelectedChange.mock.calls.at(callIndex)![0] as unknown;
  expect(typeof arg, 'setState must be called with a functional updater').toBe('function');
  return (arg as (p: Set<number>) => Set<number>)(new Set(prev));
}

function renderTable(
  overrides: Partial<React.ComponentProps<typeof ContactImportPreviewTable>> = {},
) {
  const onSelectedChange = vi.fn();
  render(
    <ContactImportPreviewTable
      rows={ROWS}
      selected={new Set<number>()}
      onSelectedChange={onSelectedChange}
      testIdPrefix="x-contacts"
      {...overrides}
    />,
  );
  return { onSelectedChange };
}

/** Host that owns the selection state, like BulkContactImport does. */
function StatefulTable({ rows, initial }: { rows: AnnotatedContactRow[]; initial?: Set<number> }) {
  const [selected, setSelected] = useState<Set<number>>(initial ?? new Set());
  return (
    <ContactImportPreviewTable
      rows={rows}
      selected={selected}
      onSelectedChange={setSelected}
      testIdPrefix="x-contacts"
    />
  );
}

describe('contact preview selection rules', () => {
  it('never lets a conflict or org-not-found row be selected', () => {
    expect(isContactRowSelectable(ROWS[0]!)).toBe(true);
    expect(isContactRowSelectable(ROWS[1]!)).toBe(true);
    expect(isContactRowSelectable(ROWS[2]!)).toBe(true);
    expect(isContactRowSelectable(ROWS[3]!)).toBe(true);
    expect(isContactRowSelectable(ROWS[4]!)).toBe(false);
    expect(isContactRowSelectable(ROWS[5]!)).toBe(false);
  });

  it('restricts select-all to create + link-match', () => {
    expect(bulkSelectableContactRows(ROWS).map((r) => r.index)).toEqual([0, 1]);
  });

  it('pre-checks only create + link-match, leaving fuzzy hints unticked', () => {
    expect([...defaultContactPreviewSelection(ROWS)].sort()).toEqual([0, 1]);
  });
});

describe('toContactCommitRow', () => {
  it('echoes the row fields plus the acknowledgement for a create row', () => {
    expect(toContactCommitRow(ROWS[0]!)).toEqual({
      organizationId: 'org-1',
      name: 'Ada Byron',
      email: 'ada@acme.test',
      site: 'HQ',
      expectedAnnotation: 'create',
    });
  });

  it('pins expectedContactId on a link-match', () => {
    expect(toContactCommitRow(ROWS[1]!)).toMatchObject({
      expectedAnnotation: 'link-match',
      expectedContactId: 'c-grace',
      externalId: 'cw-9',
    });
  });

  it('pins expectedContactId on an acknowledged email-match', () => {
    expect(toContactCommitRow(ROWS[2]!)).toMatchObject({
      expectedAnnotation: 'email-match',
      expectedContactId: 'c-alan',
    });
  });

  it('sends no acknowledgement at all for an unacknowledgeable annotation', () => {
    // `conflict` / `org-not-found` are not in the commit enum: sending one would
    // 400 the WHOLE batch, not just this row.
    expect(toContactCommitRow(ROWS[4]!).expectedAnnotation).toBeUndefined();
    expect(toContactCommitRow(ROWS[5]!).expectedAnnotation).toBeUndefined();
  });

  it('drops a fuzzy acknowledgement that has no contact to pin', () => {
    // The server REQUIRES expectedContactId whenever expectedAnnotation is
    // email-match/name-match, and rejects the entire request when it is absent.
    const unpinned: AnnotatedContactRow = { ...ROWS[3]!, contactId: null };
    const commit = toContactCommitRow(unpinned);
    expect(commit.expectedAnnotation).toBeUndefined();
    expect(commit.expectedContactId).toBeUndefined();
  });

  it('omits blank optional fields rather than sending empty strings', () => {
    const sparse: AnnotatedContactRow = {
      index: 9, name: 'Solo', annotation: 'create',
      organizationId: 'org-1', siteId: null, contactId: null,
    };
    expect(toContactCommitRow(sparse)).toEqual({
      organizationId: 'org-1',
      name: 'Solo',
      expectedAnnotation: 'create',
    });
  });
});

describe('ContactImportPreviewTable', () => {
  it('renders a badge per annotation', () => {
    renderTable();
    expect(screen.getByTestId('x-contacts-badge-0')).toHaveTextContent('New');
    expect(screen.getByTestId('x-contacts-badge-1')).toHaveTextContent('Already linked');
    expect(screen.getByTestId('x-contacts-badge-2')).toHaveTextContent('Email match');
    expect(screen.getByTestId('x-contacts-badge-3')).toHaveTextContent('Name match');
    expect(screen.getByTestId('x-contacts-badge-4')).toHaveTextContent('Conflict');
    expect(screen.getByTestId('x-contacts-badge-5')).toHaveTextContent('Organization not found');
  });

  it('disables the checkbox on rows that can never be committed', () => {
    renderTable();
    expect(screen.getByTestId('x-contacts-select-0')).toBeEnabled();
    expect(screen.getByTestId('x-contacts-select-2')).toBeEnabled();
    expect(screen.getByTestId('x-contacts-select-4')).toBeDisabled();
    expect(screen.getByTestId('x-contacts-select-5')).toBeDisabled();
  });

  it('shows the matched contact beside a fuzzy hint', () => {
    renderTable();
    expect(screen.getByTestId('x-contacts-match-2')).toHaveTextContent('Alan Turing');
    expect(screen.getByTestId('x-contacts-match-3')).toHaveTextContent('Katherine Johnson');
  });

  it('renders a conflict reason for a row that cannot be applied', () => {
    renderTable();
    expect(screen.getByTestId('x-contacts-conflict-4'))
      .toHaveTextContent('3 contacts in Acme already use shared@acme.test');
  });

  it('renders a non-fatal warning distinctly from a conflict reason', () => {
    render(
      <ContactImportPreviewTable
        rows={[WARNED_ROW]}
        selected={new Set([6])}
        onSelectedChange={vi.fn()}
        testIdPrefix="x-contacts"
      />,
    );
    const warning = screen.getByTestId('x-contacts-warning-6');
    expect(warning).toHaveTextContent('3 existing contacts in Acme share shared@acme.test');
    // A warning is advisory, not fatal: the row is still an applicable `create`.
    expect(screen.getByTestId('x-contacts-select-6')).toBeEnabled();
    expect(screen.getByTestId('x-contacts-badge-6')).toHaveTextContent('New');
    expect(screen.queryByTestId('x-contacts-conflict-6')).not.toBeInTheDocument();
    // Amber, not the destructive red the conflict reason uses.
    expect(warning.className).toContain('amber');
  });

  it('attributes an org-level row to the organization rather than a site', () => {
    renderTable();
    expect(screen.getByTestId('x-contacts-row-0')).toHaveTextContent('HQ');
    expect(screen.getByTestId('x-contacts-row-1')).toHaveTextContent('Organization');
  });

  it('toggles a row through a functional updater', () => {
    const { onSelectedChange } = renderTable();
    fireEvent.click(screen.getByTestId('x-contacts-select-2'));
    expect([...nextSelection(onSelectedChange, [0, 1])].sort()).toEqual([0, 1, 2]);
  });

  it('never adds an unselectable row even when its own checkbox fires', () => {
    const { onSelectedChange } = renderTable();
    // Row 4 is the `conflict` row. Its checkbox is disabled, so a real click
    // emits nothing — clear the disabled property to drive the row's OWN
    // onChange, which is what a stale or re-rendered host would reach.
    const conflictBox = screen.getByTestId('x-contacts-select-4') as HTMLInputElement;
    conflictBox.disabled = false;
    fireEvent.click(conflictBox);

    const updater = onSelectedChange.mock.calls.at(-1)![0] as (p: Set<number>) => Set<number>;
    // `conflict` is absent from the server's commit enum: acknowledging one
    // fails Zod and rejects the WHOLE batch, not just this row.
    expect([...updater(new Set([0, 1]))].sort()).toEqual([0, 1]);
  });

  it('always allows un-ticking an unselectable row a stale host handed it', () => {
    const { onSelectedChange } = renderTable();
    const orgMissingBox = screen.getByTestId('x-contacts-select-5') as HTMLInputElement;
    orgMissingBox.disabled = false;
    fireEvent.click(orgMissingBox);

    const updater = onSelectedChange.mock.calls.at(-1)![0] as (p: Set<number>) => Set<number>;
    expect([...updater(new Set([0, 5]))].sort()).toEqual([0]);
  });

  it('leaves select-all unchecked when no row is bulk-selectable', () => {
    const fuzzyOnly = ROWS.filter((r) => r.annotation === 'email-match' || r.annotation === 'conflict');
    render(<StatefulTable rows={fuzzyOnly} initial={new Set([2])} />);
    // An empty bulk set must not render as "everything is selected" — `every`
    // on an empty array is vacuously true.
    expect(screen.getByTestId('x-contacts-select-all')).not.toBeChecked();
  });

  it('select-all spans only create + link-match, leaving acknowledged hints alone', () => {
    render(<StatefulTable rows={ROWS} initial={new Set([2])} />);
    fireEvent.click(screen.getByTestId('x-contacts-select-all'));
    expect(screen.getByTestId('x-contacts-select-0')).toBeChecked();
    expect(screen.getByTestId('x-contacts-select-1')).toBeChecked();
    expect(screen.getByTestId('x-contacts-select-2')).toBeChecked(); // untouched opt-in
    expect(screen.getByTestId('x-contacts-select-3')).not.toBeChecked();
  });

  it('deselect-all clears only the bulk set, keeping explicit opt-ins', () => {
    render(<StatefulTable rows={ROWS} initial={new Set([0, 1, 3])} />);
    fireEvent.click(screen.getByTestId('x-contacts-select-all'));
    expect(screen.getByTestId('x-contacts-select-0')).not.toBeChecked();
    expect(screen.getByTestId('x-contacts-select-1')).not.toBeChecked();
    expect(screen.getByTestId('x-contacts-select-3')).toBeChecked();
  });
});
