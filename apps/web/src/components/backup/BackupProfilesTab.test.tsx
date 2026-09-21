import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BackupProfilesTab from './BackupProfilesTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('BackupProfilesTab validation scroll (#6494)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom has no layout and so no scrollIntoView implementation; stub it
    // inline so the assignment keeps the prototype's own call signature
    // (assigning a separately-typed `ReturnType<typeof vi.fn>` variable here
    // loses that contextual typing and fails astro check's ts(2322)).
    HTMLElement.prototype.scrollIntoView = vi.fn();

    fetchMock.mockImplementation(async (input, init) => {
      void init;
      const url = String(input);
      if (url === '/backup/profiles?includeInactive=true') {
        return makeJsonResponse({ data: [] });
      }
      return makeJsonResponse({}, false, 404);
    });
  });

  it('scrolls to the name field when the blank template is saved with no name and no source', async () => {
    render(<BackupProfilesTab />);

    fireEvent.click(await screen.findByText('New profile'));
    fireEvent.click(await screen.findByText('Blank'));

    expect(await screen.findByPlaceholderText('e.g. Server')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Save'));

    // Both `name` and `sources` are invalid; FIELD_ERROR_ORDER puts `name`
    // first, so the scroll must target the name field, not the sources
    // section further down.
    expect(await screen.findByText('Profile name is required')).toBeInTheDocument();
    await waitFor(() =>
      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    );
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('scrolls to the sources section when only the source selection is invalid', async () => {
    render(<BackupProfilesTab />);

    fireEvent.click(await screen.findByText('New profile'));
    fireEvent.click(await screen.findByText('Blank'));

    const nameInput = await screen.findByPlaceholderText('e.g. Server');
    fireEvent.change(nameInput, { target: { value: 'Nightly desktops' } });

    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByText('Enable at least one data source')).toBeInTheDocument();
    await waitFor(() =>
      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    );
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
