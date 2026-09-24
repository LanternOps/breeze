import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyLocale, i18n } from '../../lib/i18n';

import OrgEventLogSettings from './OrgEventLogSettings';
import { fetchWithAuth } from '../../stores/auth';

// #3632: `t` gets a new identity on `languageChanged`, which fires after
// hydration on every page load for a user with a saved non-English locale.
// With `t` in the load effect's deps, that re-fetched the settings and wrote
// the server values back over whatever the user had already typed.
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: () => ({ currentOrgId: 'org-1' }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const SERVER_URL = 'https://es.server.test:9200';

const settingsRes = (): Response =>
  ({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      settings: {
        logForwarding: {
          enabled: true,
          elasticsearchUrl: SERVER_URL,
          elasticsearchApiKey: 'key',
          indexPrefix: 'breeze-logs',
        },
      },
    }),
  }) as unknown as Response;

describe('OrgEventLogSettings: a locale change must not reload the form', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => settingsRes());
    await act(() => i18n.changeLanguage('en'));
  });

  afterEach(async () => {
    await act(() => i18n.changeLanguage('en'));
  });

  it('keeps the user edit and does not GET again when the language changes', async () => {
    render(<OrgEventLogSettings />);

    const input = await screen.findByDisplayValue(SERVER_URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: 'https://es.edited.test:9200' } });

    // The real post-hydration path: load the bundle, then changeLanguage.
    await act(async () => {
      await applyLocale('fr-FR');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // UI text still follows the new language (JSX keeps the plain `t`).
    expect(screen.getByRole('button', { name: /Enregistrer les paramètres/ })).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue('https://es.edited.test:9200')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(SERVER_URL)).toBeNull();
  });

  it('still reports a load failure with a translated message', async () => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue('network down');
    render(<OrgEventLogSettings />);
    await waitFor(() =>
      expect(
        screen.getByText(i18n.t('settings:orgEventLogSettings.errors.load')),
      ).toBeInTheDocument(),
    );
  });
});
