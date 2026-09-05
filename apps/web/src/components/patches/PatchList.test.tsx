import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@/lib/i18n';

import PatchList, { type Patch } from './PatchList';

function makePatch(overrides: Partial<Patch> = {}): Patch {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Example Patch',
    severity: 'important',
    source: 'third_party',
    os: 'windows',
    releaseDate: '2026-02-07',
    approvalStatus: 'pending',
    ...overrides,
  };
}

// Build N patches with distinct, sortable titles (Patch 001 … Patch NNN).
function makePatches(count: number): Patch[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    return makePatch({
      id: `00000000-0000-0000-0000-${n.padStart(12, '0')}`,
      title: `Patch ${n}`,
    });
  });
}

// Body data rows (excludes the header row). Each row's second <td> holds the
// patch title in a font-medium div.
function bodyRows(): HTMLElement[] {
  return screen.getAllByRole('row').slice(1);
}

function rowTitle(row: HTMLElement): string {
  const cells = within(row).getAllByRole('cell');
  // cells[0] = checkbox, cells[1] = title block.
  const titleEl = cells[1]?.querySelector('.font-medium');
  return titleEl?.textContent?.trim() ?? '';
}

// Titles rendered in the current page, in DOM order.
function renderedTitles(): string[] {
  return bodyRows().map(rowTitle);
}

describe('PatchList CVE chips', () => {
  it('renders one chip per cveId (up to 3)', () => {
    const patch = makePatch({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      cveIds: ['CVE-2024-1234', 'CVE-2024-5678'],
    });

    render(<PatchList patches={[patch]} />);

    // Both the desktop table and the mobile cards render (the sm: breakpoint is
    // CSS-only in jsdom), so scope row assertions to the desktop surface.
    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    expect(desktop.getByTestId(`patch-row-${patch.id}-cve-CVE-2024-1234`)).toBeTruthy();
    expect(desktop.getByTestId(`patch-row-${patch.id}-cve-CVE-2024-5678`)).toBeTruthy();
  });

  it('caps visible CVEs at 3 and shows a "+N more" suffix', () => {
    const patch = makePatch({
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      cveIds: ['CVE-2024-1', 'CVE-2024-2', 'CVE-2024-3', 'CVE-2024-4', 'CVE-2024-5'],
    });

    render(<PatchList patches={[patch]} />);

    const desktop = within(screen.getByTestId('responsive-table-desktop'));
    expect(desktop.getByTestId(`patch-row-${patch.id}-cve-CVE-2024-1`)).toBeTruthy();
    expect(desktop.getByTestId(`patch-row-${patch.id}-cve-CVE-2024-2`)).toBeTruthy();
    expect(desktop.getByTestId(`patch-row-${patch.id}-cve-CVE-2024-3`)).toBeTruthy();
    expect(desktop.queryByTestId(`patch-row-${patch.id}-cve-CVE-2024-4`)).toBeNull();
    expect(desktop.getByText('+2 more')).toBeTruthy();
  });

  it('renders no CVE chips when cveIds is empty or missing', () => {
    const empty = makePatch({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', cveIds: [] });
    const missing = makePatch({ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd' });

    const { container, rerender } = render(<PatchList patches={[empty]} />);
    expect(container.querySelector('[data-testid^="patch-row-"][data-testid*="-cve-"]')).toBeNull();

    rerender(<PatchList patches={[missing]} />);
    expect(container.querySelector('[data-testid^="patch-row-"][data-testid*="-cve-"]')).toBeNull();
  });
});

describe('PatchList severity (#3758)', () => {
  it('renders an Unrated badge with a will-not-auto-approve note for a null-severity patch', () => {
    const patch = makePatch({
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      title: 'KB5000001',
      severity: 'unrated',
    });

    render(<PatchList patches={[patch]} />);

    expect(screen.getAllByText('Unrated').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/will not auto-approve/i).length).toBeGreaterThan(0);
  });

  it('does not render the will-not-auto-approve note for a rated patch', () => {
    const patch = makePatch({
      id: '99999999-9999-9999-9999-999999999999',
      title: 'KB6000001',
      severity: 'critical',
    });

    render(<PatchList patches={[patch]} />);

    expect(screen.queryByText(/will not auto-approve/i)).toBeNull();
  });

  it('offers "Unrated" as a severity filter option', () => {
    render(<PatchList patches={[]} />);

    const filter = screen.getByDisplayValue(/all severities/i) as HTMLSelectElement;
    const optionLabels = Array.from(filter.options).map(o => o.textContent);
    expect(optionLabels).toContain('Unrated');
  });
});

describe('PatchList page-size selector', () => {
  it('defaults to 25 rows per page', () => {
    render(<PatchList patches={makePatches(40)} />);
    expect((screen.getByTestId('patch-page-size') as HTMLSelectElement).value).toBe('25');
    expect(renderedTitles()).toHaveLength(25);
  });

  it('changes the number of visible rows when a larger page size is chosen', () => {
    render(<PatchList patches={makePatches(120)} />);

    expect(renderedTitles()).toHaveLength(25);

    fireEvent.change(screen.getByTestId('patch-page-size'), { target: { value: '100' } });

    expect(renderedTitles()).toHaveLength(100);
  });

  it('resets to page 1 when the page size changes', () => {
    render(<PatchList patches={makePatches(60)} />);

    // Move to page 2 (25 per page → 3 pages).
    fireEvent.click(screen.getByText('Page 1 of 3').parentElement!.querySelectorAll('button')[1]);
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();

    // Raising page size to 100 collapses to a single page starting at 1.
    fireEvent.change(screen.getByTestId('patch-page-size'), { target: { value: '100' } });

    expect(renderedTitles()[0]).toBe('Patch 001');
    expect(renderedTitles()).toHaveLength(60);
  });

  it('offers 25, 50, 100, and 200 options', () => {
    render(<PatchList patches={makePatches(5)} />);
    const options = Array.from(
      (screen.getByTestId('patch-page-size') as HTMLSelectElement).options
    ).map(o => o.value);
    expect(options).toEqual(['25', '50', '100', '200']);
  });
});

describe('PatchList header sorting', () => {
  it('sorts by Patch title ascending then descending on repeated header clicks', () => {
    render(
      <PatchList
        patches={[
          makePatch({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title: 'Zeta Update' }),
          makePatch({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', title: 'Alpha Update' }),
          makePatch({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', title: 'Mango Update' }),
        ]}
      />
    );

    // Unsorted: original order.
    expect(renderedTitles()).toEqual(['Zeta Update', 'Alpha Update', 'Mango Update']);

    fireEvent.click(screen.getByTestId('patch-sort-title'));
    expect(renderedTitles()).toEqual(['Alpha Update', 'Mango Update', 'Zeta Update']);

    fireEvent.click(screen.getByTestId('patch-sort-title'));
    expect(renderedTitles()).toEqual(['Zeta Update', 'Mango Update', 'Alpha Update']);
  });

  it('sorts by severity using priority order (critical first) ascending', () => {
    render(
      <PatchList
        patches={[
          makePatch({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title: 'Low One', severity: 'low' }),
          makePatch({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', title: 'Crit One', severity: 'critical' }),
          makePatch({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', title: 'Mod One', severity: 'moderate' }),
        ]}
      />
    );

    fireEvent.click(screen.getByTestId('patch-sort-severity'));
    expect(renderedTitles()).toEqual(['Crit One', 'Mod One', 'Low One']);
  });

  it('sorts unrated severity last, after low (#3758)', () => {
    render(
      <PatchList
        patches={[
          makePatch({ id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', title: 'Unrated One', severity: 'unrated' }),
          makePatch({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', title: 'Crit One', severity: 'critical' }),
          makePatch({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title: 'Low One', severity: 'low' }),
        ]}
      />
    );

    fireEvent.click(screen.getByTestId('patch-sort-severity'));
    expect(renderedTitles()).toEqual(['Crit One', 'Low One', 'Unrated One']);
  });

  it('marks the active sort header via aria-sort', () => {
    render(<PatchList patches={makePatches(3)} />);

    const titleHeader = screen.getByTestId('patch-sort-title').closest('th') as HTMLElement;
    expect(titleHeader.getAttribute('aria-sort')).toBe('none');

    fireEvent.click(screen.getByTestId('patch-sort-title'));
    expect(titleHeader.getAttribute('aria-sort')).toBe('ascending');

    fireEvent.click(screen.getByTestId('patch-sort-title'));
    expect(titleHeader.getAttribute('aria-sort')).toBe('descending');
  });

  it('resets to page 1 when a new sort is applied', () => {
    render(<PatchList patches={makePatches(60)} />);

    fireEvent.click(screen.getByText('Page 1 of 3').parentElement!.querySelectorAll('button')[1]);
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();

    fireEvent.click(screen.getByTestId('patch-sort-title'));
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();
  });
});

// #3157: the header checkbox only ever covers the visible page. With a
// catalog spanning many pages that meant one select-all click per page before
// a bulk approve could cover everything, so the toolbar offers a single
// "select all N matching" action over the full filtered set.
describe('PatchList select-all across pages (#3157)', () => {
  const selectAllHeader = () =>
    within(screen.getByTestId('responsive-table-desktop')).getByRole('button', {
      name: 'Select all patches',
    });

  it('offers "select all matching" once the filtered set spans more than one page', () => {
    // 60 patches at the default page size of 25 => 3 pages.
    render(<PatchList patches={makePatches(60)} onBulkApprove={async () => {}} />);

    // No selection yet — the toolbar (and the action) are hidden.
    expect(screen.queryByTestId('patch-select-all-matching')).toBeNull();

    fireEvent.click(selectAllHeader());
    expect(screen.getByText('25 selected')).toBeTruthy();

    fireEvent.click(screen.getByTestId('patch-select-all-matching'));
    expect(screen.getByText('60 selected')).toBeTruthy();
    // Every matching patch is now selected, so the action retires itself.
    expect(screen.queryByTestId('patch-select-all-matching')).toBeNull();
  });

  it('passes every selected id to the bulk approve handler, not just the visible page', async () => {
    const approved: string[][] = [];
    render(
      <PatchList patches={makePatches(60)} onBulkApprove={async (ids) => { approved.push(ids); }} />
    );

    fireEvent.click(selectAllHeader());
    fireEvent.click(screen.getByTestId('patch-select-all-matching'));
    fireEvent.click(screen.getByTestId('patch-bulk-approve'));

    await waitFor(() => expect(approved).toHaveLength(1));
    expect(approved[0]).toHaveLength(60);
  });

  it('does not offer the action when everything already fits on one page', () => {
    render(<PatchList patches={makePatches(10)} onBulkApprove={async () => {}} />);

    fireEvent.click(selectAllHeader());
    expect(screen.getByText('10 selected')).toBeTruthy();
    expect(screen.queryByTestId('patch-select-all-matching')).toBeNull();
  });

  it('scopes "select all matching" to the active filter, not the whole catalog', () => {
    const patches = [
      ...makePatches(40),
      ...Array.from({ length: 30 }, (_, i) =>
        makePatch({
          id: `11111111-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
          title: `Critical ${i + 1}`,
          severity: 'critical',
        })
      ),
    ];
    render(<PatchList patches={patches} onBulkApprove={async () => {}} />);

    // The severity <select> owns the "All severities" option.
    const severitySelect = screen
      .getByRole('option', { name: 'All Severities' })
      .closest('select') as HTMLSelectElement;
    fireEvent.change(severitySelect, { target: { value: 'critical' } });
    fireEvent.click(selectAllHeader());
    fireEvent.click(screen.getByTestId('patch-select-all-matching'));

    // 30 criticals, not all 70 patches.
    expect(screen.getByText('30 selected')).toBeTruthy();
  });
});
