import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ReportBuilder from './ReportBuilder';
import { fetchWithAuth } from '../../stores/auth';

// Issue #7154: at 1024px the outer `lg:grid-cols-[minmax(0,1fr)_420px]` split
// (ReportBuilder.tsx) leaves the form column only ~230px wide, but several
// inner grids still switched to multiple columns on `sm:`/`lg:` (the *screen*
// width), forcing two columns into that narrow space and overflowing card
// borders, chip bounds, and inputs. jsdom has no layout engine, so these
// assertions check the markup/classes that carry the fix rather than pixels:
// the multi-column breakpoints are pushed out to `xl:` (so they only apply
// once there is actually room), and the elements that were overflowing their
// containers (card titles, chip labels, format descriptions) get `min-w-0`
// + truncation so long content can't stretch its container.

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

describe('ReportBuilder responsive layout (#7154)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: { rows: [] } }));
  });

  it('does not force a screen-width breakpoint on the Report details grid', async () => {
    render(<ReportBuilder mode="builder" />);

    const nameInput = await screen.findByLabelText(/report name/i);
    const grid = nameInput.closest('.grid');
    expect(grid).not.toBeNull();
    expect(grid?.className).not.toMatch(/\bsm:grid-cols-2\b/);
    expect(grid?.className).toMatch(/\bxl:grid-cols-2\b/);
  });

  it('gives the Report details form column room to shrink instead of overflowing at narrow widths', async () => {
    render(<ReportBuilder mode="builder" />);

    const nameInput = await screen.findByLabelText(/report name/i);
    const formColumn = nameInput.closest('form')?.firstElementChild as HTMLElement | null;
    expect(formColumn).not.toBeNull();
    expect(formColumn?.className).toMatch(/\bmin-w-0\b/);
  });

  it('does not force the Report type cards into a screen-width two-column grid', async () => {
    render(<ReportBuilder mode="builder" />);

    const section = await screen.findByTestId('report-builder-generic-sections');
    const grid = section.querySelector('.grid');
    expect(grid).not.toBeNull();
    expect(grid?.className).not.toMatch(/\bsm:grid-cols-2\b/);
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

  it('does not force the export-format cards into a screen-width three-column grid and truncates their descriptions', async () => {
    render(<ReportBuilder mode="builder" />);

    const pdfLabels = await screen.findAllByText('PDF');
    const pdfLabel = pdfLabels.find(el => el.closest('button') !== null);
    const card = pdfLabel?.closest('button');
    const grid = card?.parentElement as HTMLElement | null;

    expect(grid).not.toBeNull();
    expect(grid?.className).not.toMatch(/\bsm:grid-cols-3\b/);
    expect(grid?.className).toMatch(/\bxl:grid-cols-3\b/);

    expect(card?.className).toMatch(/\bmin-w-0\b/);
    const description = card?.querySelector('span:last-child');
    expect(description?.className).toMatch(/\btruncate\b/);
  });
});
