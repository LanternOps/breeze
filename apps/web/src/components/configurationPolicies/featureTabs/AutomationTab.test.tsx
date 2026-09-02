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
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(makeJsonResponse({ data: CATALOG }));
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

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

    // Open the picker dropdown and select an entry. findByText: the picker
    // shows "Loading..." until the catalog fetch resolves — the waitFor above
    // only proves the fetch was CALLED, not that the state update flushed.
    fireEvent.click(await screen.findByText('Select software...'));
    fireEvent.click(await screen.findByText('Google Chrome'));

    // Persist and assert the emitted action shape.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const payload = saveMock.mock.calls[0][1];
    const action = payload.inlineSettings.items[0].actions[0];
    expect(action).toEqual({ type: 'deploy_software', catalogId: 'cat-1' });
  });
});

// Issue #3361: the schedule trigger shipped its own 9-entry hardcoded timezone
// list (the same defect #2856 fixed for sites/orgs/partners), so an automation
// could not be scheduled in e.g. Asia/Dubai. Asserted on the OUTCOME — the
// chosen zone reaching the save payload — not on TimezoneSelect's internals.
describe('AutomationTab — schedule timezone picker', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(makeJsonResponse({ data: CATALOG }));
  });

  // The timezone control only exists under the (default) "schedule" trigger,
  // and the empty-state button both creates and expands the automation.
  const addAutomation = () => {
    renderTab();
    fireEvent.click(screen.getAllByRole('button', { name: /Add Automation/i })[0]);
  };

  it('offers zones that were absent from the old hardcoded list', () => {
    addAutomation();
    fireEvent.click(screen.getByTestId('automation-timezone-0-trigger'));
    fireEvent.change(screen.getByTestId('automation-timezone-0-search'), {
      target: { value: 'dubai' },
    });
    expect(screen.getByTestId('automation-timezone-0-option-Asia/Dubai')).toBeTruthy();
  });

  it('saves a zone picked from the full IANA list', async () => {
    addAutomation();
    fireEvent.click(screen.getByTestId('automation-timezone-0-trigger'));
    fireEvent.change(screen.getByTestId('automation-timezone-0-search'), {
      target: { value: 'sao paulo' },
    });
    fireEvent.click(screen.getByTestId('automation-timezone-0-option-America/Sao_Paulo'));

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const payload = saveMock.mock.calls[0][1];
    expect(payload.inlineSettings.items[0].timezone).toBe('America/Sao_Paulo');
  });

  // The picker is scoped to the schedule trigger. Pinned because it is now a
  // mounted combobox rather than an inert <select>: leaking it into the event /
  // manual branches would put a focusable popup in a form where the timezone is
  // meaningless.
  it('renders no timezone picker for non-schedule triggers', () => {
    addAutomation();
    expect(screen.getByTestId('automation-timezone-0-trigger')).toBeTruthy();

    for (const trigger of ['event', 'manual']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${trigger}$`, 'i') }));
      expect(screen.queryByTestId('automation-timezone-0-trigger')).toBeNull();
    }
  });

  /**
   * #3990 — the row's delete control used to be a <button> NESTED inside the
   * row's expand <button>.
   *
   * Three things were wrong and only one of them was cosmetic: invalid HTML
   * React flags as a hydration hazard; a click on delete bubbling to the expand
   * handler so removing a row also toggled it; and nested interactive controls
   * that keyboard and screen-reader users cannot reach reliably.
   *
   * The bubbling was masked by an `e.stopPropagation()` in the delete handler,
   * which made the symptom invisible while leaving the invalid markup — so this
   * asserts the STRUCTURE, not just the behaviour. A test that only clicked
   * delete and checked the row vanished would pass with the nesting restored
   * and stopPropagation back in place.
   */
  it('renders the expand and delete controls as siblings, not nested', () => {
    addAutomation();

    const del = screen.getAllByRole('button', { name: /^Delete:/i })[0];
    // Walk up from the PARENT. `del.closest('button')` matches the delete
    // button itself, so it can never fail — that version of this assertion
    // passed with the nesting fully restored.
    expect(del.parentElement?.closest('button')).toBeNull();
  });

  /**
   * Deleting a COLLAPSED row must not disturb the expanded one.
   *
   * The sequence matters, and an earlier version of this test got it wrong in a
   * way that made it a false positive: it expanded row 0 implicitly, added a
   * second row, deleted row 0, and counted the survivors. That passes with the
   * nesting restored — `deleteItem` shifts `expandedIndex` from 1 to 0 when the
   * row below is removed, and a LEAKED row-0 expand handler also sets 0, so the
   * two outcomes are indistinguishable. It only went red in the control because
   * the old markup had no `aria-expanded` for the query to find, i.e. for the
   * wrong reason entirely.
   *
   * Expanding row 0 and deleting the COLLAPSED row 1 separates them: with
   * correct code `expandedIndex` stays 0 and row 0 keeps its form mounted; with
   * bubbling, the delete click first toggles row 1 open (setting the index to
   * 1), and `deleteItem(1)` then clears it to null — so the survivor collapses.
   */
  it('deleting a collapsed row leaves the expanded row expanded', () => {
    addAutomation();                                   // row 0, auto-expanded
    fireEvent.click(screen.getAllByRole('button', { name: /Add Automation/i })[0]); // row 1, now expanded

    // Put the expansion back on row 0, leaving row 1 collapsed.
    const expandControls = screen.getAllByRole('button', { expanded: false });
    fireEvent.click(expandControls[0]);
    expect(screen.getAllByRole('button', { expanded: true }).length).toBe(1);

    // Delete the COLLAPSED row (row 1) — its delete button is the second one.
    const deletes = screen.getAllByRole('button', { name: /^Delete:/i });
    expect(deletes.length).toBe(2);
    fireEvent.click(deletes[1]);

    // One row left, still expanded, and its form is still mounted.
    expect(screen.getAllByRole('button', { name: /^Delete:/i }).length).toBe(1);
    expect(screen.getAllByRole('button', { expanded: true }).length).toBe(1);
    expect(screen.getByTestId('automation-timezone-0-trigger')).toBeTruthy();
  });

  it('defaults to UTC and leaves it intact when untouched', async () => {
    addAutomation();
    expect(screen.getByTestId('automation-timezone-0-trigger').textContent).toContain('UTC');

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const payload = saveMock.mock.calls[0][1];
    expect(payload.inlineSettings.items[0].timezone).toBe('UTC');
  });
});
