import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import LogSearch from './LogSearch';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe('LogSearch', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    fetchWithAuthMock.mockResolvedValue(
      makeResponse({ results: [], total: 0 }),
    );
  });

  // #7158: search/source/start/end datetime inputs each had a sibling
  // <label> that was never linked via htmlFor, so they had no accessible
  // name. Assert the labels now resolve the inputs.
  it('links the search, source, and date range labels to their inputs', async () => {
    render(<LogSearch />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());

    expect(screen.getByLabelText('Search')).toBeInTheDocument();
    expect(screen.getByLabelText('Source')).toBeInTheDocument();
    expect(screen.getByLabelText('Start')).toBeInTheDocument();
    expect(screen.getByLabelText('End')).toBeInTheDocument();
  });
});
