import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AutomationTab from './AutomationTab';
import { fetchWithAuth } from '../../../stores/auth';
import { applyLocale, i18n } from '@/lib/i18n';

const saveMock = vi.fn();
const removeMock = vi.fn();
const clearErrorMock = vi.fn();

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: undefined,
    clearError: clearErrorMock,
  }),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const CATALOG = [
  { id: 'cat-1', name: 'Google Chrome', vendor: 'Google' },
  { id: 'cat-2', name: 'Firefox', vendor: 'Mozilla' },
];

function renderTab() {
  return render(
    <AutomationTab
      policyId="policy-1"
      existingLink={undefined}
      linkedPolicyId={null}
      onLinkChanged={vi.fn()}
    />,
  );
}

describe('AutomationTab — deploy_software action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(makeJsonResponse({ data: CATALOG }));
  });

  afterEach(() => i18n.changeLanguage('en'));

  it('updates mounted action options when the locale changes', async () => {
    renderTab();
    fireEvent.click(screen.getAllByRole('button', { name: /Add Automation/i })[0]);
    expect(screen.getByRole('option', { name: 'Deploy Software' })).toBeInTheDocument();

    await act(async () => {
      await applyLocale('pt-BR');
    });

    expect(screen.getByRole('option', { name: 'Implantar software' })).toBeInTheDocument();
  });

  it('renders a catalog picker + helper text and emits { type:"deploy_software", catalogId }', async () => {
    renderTab();

    // Create + expand a new automation (the empty-state button auto-expands it).
    // Both the header and empty-state share the "Add Automation" label; either works.
    fireEvent.click(screen.getAllByRole('button', { name: /Add Automation/i })[0]);

    // Switch the (single, default) action to Deploy Software.
    const actionTypeSelect = screen.getByDisplayValue('Run Script');
    fireEvent.change(actionTypeSelect, { target: { value: 'deploy_software' } });

    // Helper text + catalog picker label appear.
    expect(
      screen.getByText(/Installs the latest version of the selected software/i),
    ).toBeTruthy();
    expect(screen.getByText('Software')).toBeTruthy();

    // The catalog endpoint is the same one the Software Catalog page uses.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/software/catalog?limit=100'),
    );

    // Open the picker dropdown and select an entry.
    fireEvent.click(screen.getByText('Select software...'));
    fireEvent.click(await screen.findByText('Google Chrome'));

    // Persist and assert the emitted action shape.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const payload = saveMock.mock.calls[0][1];
    const action = payload.inlineSettings.items[0].actions[0];
    expect(action).toEqual({ type: 'deploy_software', catalogId: 'cat-1' });
  });
});
