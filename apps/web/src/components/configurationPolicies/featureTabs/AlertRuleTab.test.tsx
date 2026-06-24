import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AlertRuleTab from './AlertRuleTab';

const saveMock = vi.fn();
const removeMock = vi.fn();
const clearErrorMock = vi.fn();

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: undefined,
    clearError: clearErrorMock,
  }),
}));

type SavedPayload = { inlineSettings: { items: Array<Record<string, unknown>> } };

function lastSavedItems(): Array<Record<string, unknown>> {
  const call = saveMock.mock.calls.at(-1) as [string | null, SavedPayload];
  return call[1].inlineSettings.items;
}

// Labels in this component are sibling text, not associated via htmlFor, so we
// locate the control by finding its label text and walking to the field below.
function controlForLabel(labelText: string): HTMLElement {
  const label = screen.getAllByText(labelText)[0]!;
  const control = label.parentElement?.querySelector('select, input');
  if (!control) throw new Error(`No control found for label "${labelText}"`);
  return control as HTMLElement;
}

function addFirstRule(): void {
  // Both the header and empty-state render an "Add Alert Rule" button; the
  // empty-state one only exists before any rule is added — click it.
  const addButtons = screen.getAllByRole('button', { name: /Add Alert Rule/i });
  fireEvent.click(addButtons[addButtons.length - 1]!);
}

describe('AlertRuleTab (issue #1857)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({
      id: 'link-1',
      featureType: 'alert_rule',
      featurePolicyId: null,
      inlineSettings: {},
    });
  });

  it('does not offer the dead "Network Usage" metric option', () => {
    render(
      <AlertRuleTab
        policyId="policy-1"
        existingLink={{
          id: 'link-1',
          featureType: 'alert_rule',
          featurePolicyId: null,
          inlineSettings: {
            items: [
              {
                name: 'CPU rule',
                severity: 'high',
                conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }],
                cooldownMinutes: 15,
                autoResolve: false,
              },
            ],
          },
        }}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    // Expand the rule so the metric dropdown renders.
    fireEvent.click(screen.getByText('CPU rule'));

    expect(screen.queryByRole('option', { name: 'Network Usage' })).toBeNull();
    expect(screen.getByRole('option', { name: 'CPU Usage' })).toBeTruthy();
  });

  it('migrates a legacy {type:"status", duration} rule to {type:"offline", durationMinutes} on save', async () => {
    render(
      <AlertRuleTab
        policyId="policy-1"
        existingLink={{
          id: 'link-1',
          featureType: 'alert_rule',
          featurePolicyId: null,
          inlineSettings: {
            items: [
              {
                name: 'Offline rule',
                severity: 'critical',
                conditions: [{ type: 'status', duration: 15 }],
                cooldownMinutes: 15,
                autoResolve: false,
              },
            ],
          },
        }}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const condition = lastSavedItems()[0]!.conditions as Array<Record<string, unknown>>;
    expect(condition[0]).toMatchObject({ type: 'offline', durationMinutes: 15 });
    expect(condition[0]).not.toHaveProperty('duration');
  });

  it('renders the offline-duration editor for a migrated legacy status rule', () => {
    render(
      <AlertRuleTab
        policyId="policy-1"
        existingLink={{
          id: 'link-1',
          featureType: 'alert_rule',
          featurePolicyId: null,
          inlineSettings: {
            items: [
              {
                name: 'Offline rule',
                severity: 'critical',
                conditions: [{ type: 'status', duration: 30 }],
                cooldownMinutes: 15,
                autoResolve: false,
              },
            ],
          },
        }}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('Offline rule'));

    // The migrated duration shows up in the "Offline Duration (min)" field.
    const durationInput = controlForLabel('Offline Duration (min)') as HTMLInputElement;
    expect(durationInput.value).toBe('30');
  });

  it('saves a newly-added Device Offline condition as {type:"offline", durationMinutes}', async () => {
    render(
      <AlertRuleTab
        policyId="policy-1"
        existingLink={undefined}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    // Add a rule, then switch its single condition's type to Device Offline.
    addFirstRule();

    const typeSelect = controlForLabel('Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'offline' } });

    const durationInput = controlForLabel('Offline Duration (min)') as HTMLInputElement;
    fireEvent.change(durationInput, { target: { value: '20' } });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const condition = lastSavedItems()[0]!.conditions as Array<Record<string, unknown>>;
    expect(condition[0]).toMatchObject({ type: 'offline', durationMinutes: 20 });
  });

  it('offers "Device Offline" (not the legacy "Status") in the condition type dropdown', () => {
    render(
      <AlertRuleTab
        policyId="policy-1"
        existingLink={undefined}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    addFirstRule();

    const typeSelect = controlForLabel('Type');
    expect(within(typeSelect).getByRole('option', { name: 'Device Offline' })).toBeTruthy();
    expect(within(typeSelect).queryByRole('option', { name: 'Status' })).toBeNull();
  });
});
