import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import OrgImportPreviewTable, {
  bulkSelectableRows,
  defaultPreviewSelection,
  isMatchAlreadyLinked,
  isRowSelectable,
  toCommitRow,
  type AnnotatedRow,
} from './OrgImportPreviewTable';

const ROWS: AnnotatedRow[] = [
  { index: 0, organization: 'Acme', site: 'HQ', externalId: '1', annotation: 'create', slug: 'acme', organizationId: null },
  { index: 1, organization: 'Widget', site: 'Depot', externalId: '2', annotation: 'link-match', slug: null, organizationId: 'org-w' },
  { index: 2, organization: 'Old Co', annotation: 'name-match', slug: null, organizationId: 'org-o', matchedOrganizationName: 'Old Co' },
  { index: 3, organization: 'Dead Co', annotation: 'matched-soft-deleted', slug: null, organizationId: 'org-dead' },
  { index: 4, organization: 'Broken', annotation: 'conflict', slug: null, organizationId: null, conflictReason: 'boom conflict' },
];

/**
 * The org this row matched by NAME is already linked to the same external
 * system under a DIFFERENT id — confirming it would write a second link row and
 * collapse two source companies onto one tenant.
 */
const ALREADY_LINKED: AnnotatedRow = {
  index: 5,
  organization: 'Contoso Ltd',
  externalSystem: 'connectwise',
  externalId: 'cw-77',
  annotation: 'name-match',
  slug: null,
  organizationId: 'org-contoso',
  matchedOrganizationName: 'Contoso',
  matchedOrganizationLinkedToSystem: true,
};

/**
 * The table drives selection with a FUNCTIONAL updater (two toggles in one tick
 * must not drop an update), so assertions resolve the updater against a known
 * previous set rather than comparing to a literal.
 */
function nextSelection(
  onSelectedChange: ReturnType<typeof vi.fn>,
  prev: Iterable<number>,
  callIndex = -1,
): Set<number> {
  const calls = onSelectedChange.mock.calls;
  const arg = calls.at(callIndex)![0] as unknown;
  expect(typeof arg, 'setState must be called with a functional updater').toBe('function');
  return (arg as (p: Set<number>) => Set<number>)(new Set(prev));
}

function renderTable(
  overrides: Partial<React.ComponentProps<typeof OrgImportPreviewTable>> = {},
) {
  const onSelectedChange = vi.fn();
  const props = {
    rows: ROWS,
    selected: new Set<number>(),
    onSelectedChange,
    testIdPrefix: 'x-import',
    ...overrides,
  };
  render(<OrgImportPreviewTable {...props} />);
  return { onSelectedChange };
}

/** Host that owns the selection state, like BulkOrgImport / PsaCompanyImport. */
function StatefulTable({ rows, initial }: { rows: AnnotatedRow[]; initial?: Set<number> }) {
  const [selected, setSelected] = useState<Set<number>>(initial ?? defaultPreviewSelection(rows));
  return (
    <>
      <span data-testid="selection">{[...selected].sort((a, b) => a - b).join(',')}</span>
      <OrgImportPreviewTable
        rows={rows}
        selected={selected}
        onSelectedChange={setSelected}
        testIdPrefix="x-import"
      />
    </>
  );
}

describe('OrgImportPreviewTable selection rules', () => {
  it('preselects only create + link-match rows', () => {
    expect([...defaultPreviewSelection(ROWS)]).toEqual([0, 1]);
    expect(bulkSelectableRows(ROWS).map((r) => r.index)).toEqual([0, 1]);
  });

  it('never lets a conflict row be selected', () => {
    renderTable();
    expect(screen.getByTestId('x-import-select-4')).toBeDisabled();
  });

  it('toggles a single row without touching the others', () => {
    const { onSelectedChange } = renderTable({ selected: new Set([0, 1]) });

    fireEvent.click(screen.getByTestId('x-import-select-2'));
    expect(nextSelection(onSelectedChange, [0, 1])).toEqual(new Set([0, 1, 2]));

    fireEvent.click(screen.getByTestId('x-import-select-0'));
    expect(nextSelection(onSelectedChange, [0, 1, 2])).toEqual(new Set([1, 2]));
  });

  it('derives every selection change from the PREVIOUS state, not the rendered prop', () => {
    // Two toggles in one tick: the second updater must see the first one's
    // result. Passing a plain Set built from the `selected` prop would drop the
    // earlier toggle (both would be computed from the same stale snapshot).
    render(<StatefulTable rows={ROWS} initial={new Set()} />);

    fireEvent.click(screen.getByTestId('x-import-select-2'));
    fireEvent.click(screen.getByTestId('x-import-select-3'));
    expect(screen.getByTestId('selection')).toHaveTextContent('2,3');
  });

  it('select-all adds only the bulk set, leaving name-match and soft-deleted alone', () => {
    const { onSelectedChange } = renderTable({ selected: new Set() });
    fireEvent.click(screen.getByTestId('x-import-select-all'));
    expect(nextSelection(onSelectedChange, [])).toEqual(new Set([0, 1]));
  });

  it('select-all clears only the bulk set, preserving explicit per-row opt-ins', () => {
    // Rows 2 (name-match) and 3 (soft-deleted reactivation) were ticked
    // deliberately — a bulk deselect must not silently drop those decisions,
    // and a later re-tick must not silently re-add them.
    const { onSelectedChange } = renderTable({ selected: new Set([0, 1, 2, 3]) });
    expect(screen.getByTestId('x-import-select-all')).toBeChecked();

    fireEvent.click(screen.getByTestId('x-import-select-all'));
    expect(nextSelection(onSelectedChange, [0, 1, 2, 3])).toEqual(new Set([2, 3]));
  });

  it('leaves select-all unchecked when there is nothing bulk-selectable', () => {
    render(
      <OrgImportPreviewTable
        rows={[ROWS[4]!]}
        selected={new Set()}
        onSelectedChange={vi.fn()}
        testIdPrefix="x-import"
      />,
    );
    expect(screen.getByTestId('x-import-select-all')).not.toBeChecked();
  });
});

describe('OrgImportPreviewTable already-linked match guard', () => {
  const rows = [...ROWS, ALREADY_LINKED];

  it('classifies the row as unselectable', () => {
    expect(isMatchAlreadyLinked(ALREADY_LINKED)).toBe(true);
    expect(isRowSelectable(ALREADY_LINKED)).toBe(false);
    expect(isMatchAlreadyLinked(ROWS[2]!)).toBe(false);
  });

  it('disables the confirm checkbox', () => {
    renderTable({ rows });
    expect(screen.getByTestId('x-import-select-5')).toBeDisabled();
    // The ordinary name-match beside it stays confirmable.
    expect(screen.getByTestId('x-import-select-2')).toBeEnabled();
  });

  it('explains WHY, naming the organization it collides with', () => {
    renderTable({ rows });
    const note = screen.getByTestId('x-import-already-linked-5');
    expect(note).toHaveTextContent('Contoso');
    expect(note).toHaveTextContent(/already linked/i);
    expect(note).toHaveTextContent(/merge/i);
    // The reassuring "matches X" hint is REPLACED, not stacked on top of the
    // refusal — the ordinary name-match row is the one that still gets it.
    expect(screen.getByTestId('x-import-row-5')).not.toHaveTextContent(/matches/i);
    expect(screen.getByTestId('x-import-row-2')).toHaveTextContent(/matches/i);
  });

  it('is excluded from the default selection and from select-all', () => {
    expect([...defaultPreviewSelection(rows)]).toEqual([0, 1]);
    expect(bulkSelectableRows(rows).map((r) => r.index)).toEqual([0, 1]);

    const { onSelectedChange } = renderTable({ rows, selected: new Set() });
    fireEvent.click(screen.getByTestId('x-import-select-all'));
    expect(nextSelection(onSelectedChange, [])).toEqual(new Set([0, 1]));
  });

  it('is excluded even when the annotation itself is bulk-selectable', () => {
    // Belt to the server's braces: a link-match carrying the flag must not be
    // pre-ticked just because its annotation is normally safe.
    const forged: AnnotatedRow = { ...ALREADY_LINKED, annotation: 'link-match' };
    expect([...defaultPreviewSelection([forged])]).toEqual([]);
  });

  it('cannot be ticked — a click on it changes nothing', () => {
    render(<StatefulTable rows={rows} />);
    expect(screen.getByTestId('selection')).toHaveTextContent('0,1');

    fireEvent.click(screen.getByTestId('x-import-select-5'));
    expect(screen.getByTestId('selection')).toHaveTextContent('0,1');
    expect(screen.getByTestId('x-import-select-5')).not.toBeChecked();

    // Selecting everything the user legitimately can still never reaches it.
    fireEvent.click(screen.getByTestId('x-import-select-2'));
    fireEvent.click(screen.getByTestId('x-import-select-3'));
    fireEvent.click(screen.getByTestId('x-import-select-all'));
    expect(screen.getByTestId('selection')).toHaveTextContent('2,3');
  });

  it('toCommitRow emits NO acknowledgement for it', () => {
    const commit = toCommitRow(ALREADY_LINKED);
    expect(commit).not.toHaveProperty('expectedAnnotation');
    expect(commit).not.toHaveProperty('expectedOrganizationId');
    expect(commit).not.toHaveProperty('reactivate');
    // The row's own data still travels — only the confirmation is withheld.
    expect(commit).toEqual({
      organization: 'Contoso Ltd',
      externalId: 'cw-77',
      externalSystem: 'connectwise',
    });
  });

  it('toCommitRow withholds reactivate on an already-linked soft-deleted match', () => {
    const commit = toCommitRow({ ...ALREADY_LINKED, annotation: 'matched-soft-deleted' });
    expect(commit).not.toHaveProperty('reactivate');
    expect(commit).not.toHaveProperty('expectedAnnotation');
  });
});

describe('OrgImportPreviewTable rendering', () => {
  it('renders a badge per annotation plus the match/reactivate/conflict detail', () => {
    renderTable();
    expect(screen.getByTestId('x-import-badge-0')).toHaveTextContent('New');
    expect(screen.getByTestId('x-import-badge-1')).toHaveTextContent('Already linked');
    expect(screen.getByTestId('x-import-badge-2')).toHaveTextContent('Name match — confirm');
    expect(screen.getByTestId('x-import-badge-3')).toHaveTextContent('Deleted org match');
    expect(screen.getByTestId('x-import-badge-4')).toHaveTextContent('Conflict');

    expect(screen.getByTestId('x-import-row-2')).toHaveTextContent('Old Co');
    expect(screen.getByTestId('x-import-row-3')).toHaveTextContent('reactivate');
    expect(screen.getByTestId('x-import-row-4')).toHaveTextContent('boom conflict');
  });

  it('namespaces every test id under the caller-supplied prefix', () => {
    render(
      <OrgImportPreviewTable
        rows={ROWS}
        selected={new Set()}
        onSelectedChange={vi.fn()}
        testIdPrefix="other-source"
      />,
    );
    expect(screen.getByTestId('other-source-table')).toBeInTheDocument();
    expect(screen.getByTestId('other-source-select-all')).toBeInTheDocument();
    expect(screen.getByTestId('other-source-row-0')).toBeInTheDocument();
    expect(screen.queryByTestId('x-import-table')).toBeNull();
  });

  it('renders an em dash for a missing site or external id', () => {
    renderTable();
    expect(screen.getByTestId('x-import-row-2')).toHaveTextContent('—');
  });
});

describe('toCommitRow', () => {
  it('carries the acknowledged annotation and pins the matched organization', () => {
    expect(toCommitRow(ROWS[1]!)).toEqual({
      organization: 'Widget',
      site: 'Depot',
      externalId: '2',
      expectedAnnotation: 'link-match',
      expectedOrganizationId: 'org-w',
    });
  });

  it('sets reactivate only for a soft-deleted match', () => {
    expect(toCommitRow(ROWS[3]!)).toEqual({
      organization: 'Dead Co',
      expectedAnnotation: 'matched-soft-deleted',
      expectedOrganizationId: 'org-dead',
      reactivate: true,
    });
    expect(toCommitRow(ROWS[0]!)).not.toHaveProperty('reactivate');
  });

  it('omits externalSystem when the server owns it', () => {
    const row: AnnotatedRow = { ...ROWS[0]!, externalSystem: 'connectwise', timezone: 'UTC' };
    expect(toCommitRow(row)).toMatchObject({ externalSystem: 'connectwise', timezone: 'UTC' });
    expect(toCommitRow(row, { includeExternalSystem: false })).not.toHaveProperty('externalSystem');
    // Only externalSystem is dropped — the rest of the row is untouched.
    expect(toCommitRow(row, { includeExternalSystem: false })).toMatchObject({ timezone: 'UTC' });
  });
});
