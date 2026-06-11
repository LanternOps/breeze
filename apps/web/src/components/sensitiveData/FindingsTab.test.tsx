import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import FindingsTab from './FindingsTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('./RemediationModal', () => ({
  default: ({ findingIds, onComplete }: { findingIds: string[]; onComplete: () => void }) => (
    <div data-testid="remediation-modal">
      modal with {findingIds.length} findings
      <button type="button" onClick={onComplete}>close</button>
    </div>
  ),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeFinding = (id: string, filePath: string) => ({
  id,
  deviceId: 'dev-1',
  deviceName: 'host-1',
  filePath,
  dataType: 'credential',
  patternId: 'aws_access_key',
  risk: 'high',
  confidence: 0.9,
  status: 'open',
  lastSeenAt: '2026-05-21T00:00:00Z',
  createdAt: '2026-05-21T00:00:00Z',
});

const FIVE_NPM_FINDINGS = [
  makeFinding('f1', '/home/u/.npm/cache/x'),
  makeFinding('f2', '/home/u/.npm/lock'),
  makeFinding('f3', '/home/u/.npm/log'),
  makeFinding('f4', '/home/u/.npm/registry'),
  makeFinding('f5', '/home/u/.npm/tmp'),
];

const TWENTY_OTHER_FINDINGS = Array.from({ length: 20 }, (_, i) =>
  makeFinding(`o${i}`, `/var/log/other-${i}.txt`)
);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('FindingsTab select-all (#809)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Initial fetch returns 25 findings (5 .npm + 20 other) in one page.
    fetchMock.mockImplementation(async () =>
      makeJsonResponse({
        data: [...FIVE_NPM_FINDINGS, ...TWENTY_OTHER_FINDINGS],
        pagination: { page: 1, limit: 25, total: 25, totalPages: 1 },
      })
    );
  });

  it('select-all without a filter selects every row on the page', async () => {
    render(<FindingsTab />);
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });

    const checkboxes = screen.getAllByRole('checkbox');
    const headerCheckbox = checkboxes[0];
    fireEvent.click(headerCheckbox);

    expect(screen.getByText(/Remediate \(25\)/)).toBeInTheDocument();
  });

  it('select-all with a search filter selects ONLY the visible filtered rows (#809 fix)', async () => {
    render(<FindingsTab />);
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });

    const searchInput = screen.getByPlaceholderText(/Search file paths/i);
    fireEvent.change(searchInput, { target: { value: '.npm' } });

    const checkboxes = screen.getAllByRole('checkbox');
    const headerCheckbox = checkboxes[0];
    fireEvent.click(headerCheckbox);

    // Should be 5, not 25. The bug was that select-all included
    // hidden/unfiltered rows.
    expect(screen.getByText(/Remediate \(5\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Remediate \(25\)/)).not.toBeInTheDocument();
  });

  it('clicking select-all a second time clears selection when all visible rows are already selected', async () => {
    render(<FindingsTab />);
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });

    const searchInput = screen.getByPlaceholderText(/Search file paths/i);
    fireEvent.change(searchInput, { target: { value: '.npm' } });

    const headerCheckbox = screen.getAllByRole('checkbox')[0];
    fireEvent.click(headerCheckbox);
    expect(screen.getByText(/Remediate \(5\)/)).toBeInTheDocument();

    fireEvent.click(headerCheckbox);
    expect(screen.queryByText(/Remediate \(/)).not.toBeInTheDocument();
  });

  // Adopted from saracmert@'s #811: changing the search term while a
  // selection exists clears it, so the user can't bulk-remediate rows
  // they're no longer looking at.
  it('changing the search term clears the existing selection', async () => {
    render(<FindingsTab />);
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });

    // Select all 25 first.
    const headerCheckbox = screen.getAllByRole('checkbox')[0];
    fireEvent.click(headerCheckbox);
    expect(screen.getByText(/Remediate \(25\)/)).toBeInTheDocument();

    // Now type into search — selection should drop to zero.
    const searchInput = screen.getByPlaceholderText(/Search file paths/i);
    fireEvent.change(searchInput, { target: { value: '.npm' } });

    expect(screen.queryByText(/Remediate \(/)).not.toBeInTheDocument();
  });

  // Empty-state row must render when a search filters out every row on
  // the page, not just when the raw page is empty. Otherwise a
  // matches-nothing search yields a body with zero rows AND no message
  // — looks like a broken render.
  it('shows "no findings on this page match your search" when the search filters everything out', async () => {
    render(<FindingsTab />);
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });

    const searchInput = screen.getByPlaceholderText(/Search file paths/i);
    fireEvent.change(searchInput, { target: { value: 'no-such-path-anywhere' } });

    expect(
      screen.getByText('No findings on this page match your search.')
    ).toBeInTheDocument();
  });
});
