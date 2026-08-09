import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import OrgImportPreviewTable, {
  bulkSelectableRows,
  defaultPreviewSelection,
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
    expect(onSelectedChange).toHaveBeenCalledWith(new Set([0, 1, 2]));

    fireEvent.click(screen.getByTestId('x-import-select-0'));
    expect(onSelectedChange).toHaveBeenLastCalledWith(new Set([1]));
  });

  it('select-all adds only the bulk set, leaving name-match and soft-deleted alone', () => {
    const { onSelectedChange } = renderTable({ selected: new Set() });
    fireEvent.click(screen.getByTestId('x-import-select-all'));
    expect(onSelectedChange).toHaveBeenCalledWith(new Set([0, 1]));
  });

  it('select-all clears only the bulk set, preserving explicit per-row opt-ins', () => {
    // Rows 2 (name-match) and 3 (soft-deleted reactivation) were ticked
    // deliberately — a bulk deselect must not silently drop those decisions,
    // and a later re-tick must not silently re-add them.
    const { onSelectedChange } = renderTable({ selected: new Set([0, 1, 2, 3]) });
    expect(screen.getByTestId('x-import-select-all')).toBeChecked();

    fireEvent.click(screen.getByTestId('x-import-select-all'));
    expect(onSelectedChange).toHaveBeenCalledWith(new Set([2, 3]));
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
