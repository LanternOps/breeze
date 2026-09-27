import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ReportBuilder from './ReportBuilder';
import { fetchWithAuth } from '../../stores/auth';

// Issue #7154: at 1024px the outer `lg:grid-cols-[minmax(0,1fr)_420px]` split
// (ReportBuilder.tsx) leaves the form column only ~230px wide, but several
// inner grids still switched to multiple columns on `sm:`/`lg:` (the *screen*
// width), forcing two/three/four columns into that narrow space and
// overflowing card borders, chip bounds, and inputs.
//
// jsdom has no layout engine, so these assertions check the markup/classes
// that carry the fix rather than pixels:
//   - each grid keeps its `sm:` (or `lg:`) multi-column class for widths
//     below the outer split (there is no narrow-column problem there), but
//     gains `lg:grid-cols-1` to collapse to one column for exactly the
//     1024-1279px window where the sidebar+preview squeeze applies, then
//     `xl:grid-cols-N` restores multiple columns once there is room again.
//   - elements that were overflowing their containers (card titles, chip
//     labels, format descriptions) get `min-w-0` + `truncate`. A `truncate`
//     on a flex-col cross-axis child only clips if something also bounds its
//     width (`w-full`) — a flex-col item sized by `align-items` otherwise
//     renders at its natural content width and `truncate` is a no-op, which
//     is asserted for directly below.
const COLLAPSES_AT_SQUEEZE = /\blg:grid-cols-1\b/;

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn()
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn()
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const findSectionGrid = async (headingName: string | RegExp) => {
  const heading = await screen.findByRole('heading', { name: headingName });
  const section = heading.closest('.rounded-lg');
  const grid = section?.querySelector('.grid') ?? null;
  return { section, grid: grid as HTMLElement | null };
};

describe('ReportBuilder responsive layout (#7154)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: { rows: [] } }));
  });

  it('collapses the Report details grid only in the 1024-1279px squeeze window, not below it', async () => {
    render(<ReportBuilder mode="builder" />);

    const nameInput = await screen.findByLabelText(/report name/i);
    const grid = nameInput.closest('.grid');
    expect(grid).not.toBeNull();
    expect(grid?.className).toMatch(/\bsm:grid-cols-2\b/);
    expect(grid?.className).toMatch(COLLAPSES_AT_SQUEEZE);
    expect(grid?.className).toMatch(/\bxl:grid-cols-2\b/);
  });

  it('gives the Report details form column room to shrink instead of overflowing at narrow widths', async () => {
    render(<ReportBuilder mode="builder" />);

    const nameInput = await screen.findByLabelText(/report name/i);
    const formColumn = nameInput.closest('form')?.firstElementChild as HTMLElement | null;
    expect(formColumn).not.toBeNull();
    expect(formColumn?.className).toMatch(/\bmin-w-0\b/);
  });

  it('collapses the Report type cards grid only in the squeeze window, not below it', async () => {
    render(<ReportBuilder mode="builder" />);

    const section = await screen.findByTestId('report-builder-generic-sections');
    const grid = section.querySelector('.grid');
    expect(grid).not.toBeNull();
    expect(grid?.className).toMatch(/\bsm:grid-cols-2\b/);
    expect(grid?.className).toMatch(COLLAPSES_AT_SQUEEZE);
    expect(grid?.className).toMatch(/\bxl:grid-cols-2\b/);
  });

  it('truncates Report type card titles so they cannot run past the card border', async () => {
    render(<ReportBuilder mode="builder" />);

    const section = await screen.findByTestId('report-builder-generic-sections');
    const cardButtons = section.querySelectorAll('button');
    expect(cardButtons.length).toBeGreaterThan(0);

    for (const button of Array.from(cardButtons)) {
      const labelRow = button.firstElementChild as HTMLElement | null;
      const label = labelRow?.querySelector('span:last-child');
      expect(labelRow?.className).toMatch(/\bmin-w-0\b/);
      // The row is `flex items-center` (row direction), so a shrinkable,
      // min-w-0 flex item is enough for `truncate` to take effect here.
      expect(label?.className).toMatch(/\btruncate\b/);
    }
  });

  it('collapses the Data source grid only in the squeeze window and lets its fields shrink', async () => {
    render(<ReportBuilder mode="builder" />);

    const { grid } = await findSectionGrid('Data source');
    expect(grid).not.toBeNull();
    expect(grid?.className).toMatch(/\bsm:grid-cols-2\b/);
    expect(grid?.className).toMatch(COLLAPSES_AT_SQUEEZE);
    expect(grid?.className).toMatch(/\bxl:grid-cols-2\b/);

    const fieldWrappers = grid?.children ?? [];
    expect(fieldWrappers.length).toBeGreaterThan(0);
    for (const wrapper of Array.from(fieldWrappers)) {
      expect((wrapper as HTMLElement).className).toMatch(/\bmin-w-0\b/);
    }
  });

  it('collapses the Grouping and aggregation grid only in the squeeze window', async () => {
    render(<ReportBuilder mode="builder" />);

    const { grid } = await findSectionGrid('Grouping and aggregation');
    expect(grid).not.toBeNull();
    expect(grid?.className).toMatch(/\bsm:grid-cols-2\b/);
    expect(grid?.className).toMatch(COLLAPSES_AT_SQUEEZE);
    expect(grid?.className).toMatch(/\bxl:grid-cols-2\b/);
  });

  it('collapses the Chart type grid only in the squeeze window, and its labels actually truncate', async () => {
    render(<ReportBuilder mode="builder" />);

    const { grid } = await findSectionGrid('Chart type');
    expect(grid).not.toBeNull();
    expect(grid?.className).toMatch(/\bsm:grid-cols-4\b/);
    expect(grid?.className).toMatch(COLLAPSES_AT_SQUEEZE);
    expect(grid?.className).toMatch(/\bxl:grid-cols-4\b/);

    const cardButtons = grid?.querySelectorAll('button') ?? [];
    expect(cardButtons.length).toBeGreaterThan(0);
    for (const button of Array.from(cardButtons)) {
      expect((button as HTMLElement).className).toMatch(/\bmin-w-0\b/);
      const label = button.querySelector('span');
      // These buttons are `flex-col items-center`: on that cross axis,
      // `truncate` alone does not create a bounded box to clip against
      // (align-items sizes the label to its own content). Without `w-full`
      // here the label can still overflow the button even with `truncate`
      // present in its class list.
      expect(label?.className).toMatch(/\bw-full\b/);
      expect(label?.className).toMatch(/\btruncate\b/);
    }
  });

  it('truncates a selected-field chip label so its remove button stays inside the chip', async () => {
    render(<ReportBuilder mode="builder" />);

    // Default state always has at least one selected field, so the
    // "Selected fields" list is populated on first render.
    const removeButtons = await screen.findAllByRole('button', { name: '' });
    const chipRow = removeButtons
      .map(button => button.closest('[draggable="true"]'))
      .find((row): row is HTMLElement => row !== null);
    expect(chipRow).toBeTruthy();

    const labelWrap = chipRow?.querySelector('.flex.items-center.gap-2');
    const label = labelWrap?.querySelector('span');
    expect(labelWrap?.className).toMatch(/\bmin-w-0\b/);
    expect(label?.className).toMatch(/\btruncate\b/);
  });

  it('collapses the export-format cards grid only in the squeeze window, and truncates their label and description', async () => {
    render(<ReportBuilder mode="builder" />);

    const pdfLabels = await screen.findAllByText('PDF');
    const pdfLabel = pdfLabels.find(el => el.closest('button') !== null);
    const card = pdfLabel?.closest('button');
    const grid = card?.parentElement as HTMLElement | null;

    expect(grid).not.toBeNull();
    expect(grid?.className).toMatch(/\bsm:grid-cols-3\b/);
    expect(grid?.className).toMatch(COLLAPSES_AT_SQUEEZE);
    expect(grid?.className).toMatch(/\bxl:grid-cols-3\b/);

    expect(card?.className).toMatch(/\bmin-w-0\b/);

    // The card is `flex-col items-start`, so (as with the chart-type card
    // above) each span needs its own `w-full` for `truncate` to bound
    // anything — checking for `truncate` alone would pass even if it were
    // a no-op.
    const label = pdfLabel as HTMLElement;
    expect(label.className).toMatch(/\bw-full\b/);
    expect(label.className).toMatch(/\btruncate\b/);

    const description = card?.querySelector('span:last-child');
    expect(description?.className).toMatch(/\bw-full\b/);
    expect(description?.className).toMatch(/\btruncate\b/);
  });
});
