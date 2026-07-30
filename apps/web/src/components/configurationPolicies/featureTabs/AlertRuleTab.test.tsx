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

// The metric <select> is the one carrying the "CPU Usage" option — "Metric" as
// a label string is ambiguous (the condition-type dropdown has a "Metric" option).
function metricSelect(): HTMLSelectElement {
  const cpuOption = screen.getByRole('option', { name: 'CPU Usage' });
  const select = cpuOption.closest('select');
  if (!select) throw new Error('No metric select found');
  return select as HTMLSelectElement;
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

  it('normalizes an aliased metric name onto the dropdown option and keeps durationMinutes', async () => {
    // AI-authored rows use METRIC_NAME_MAP aliases ("cpuPercent"). The dropdown
    // only offers cpu/ram/disk, so an un-normalized alias would leave the select
    // showing "CPU Usage" while holding a value with no matching option.
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
                name: 'Sustained CPU',
                severity: 'high',
                conditions: [
                  { type: 'metric', metric: 'cpuPercent', operator: 'gt', value: 90, durationMinutes: 15 },
                ],
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

    fireEvent.click(screen.getByText('Sustained CPU'));
    expect(metricSelect().value).toBe('cpu');

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const conditions = lastSavedItems()[0]!.conditions as Array<Record<string, unknown>>;
    // durationMinutes is honoured by the threshold evaluator — it must survive.
    expect(conditions[0]).toMatchObject({ type: 'metric', metric: 'cpu', durationMinutes: 15 });
  });

  it('renders a metric with no dropdown entry (processCount) without silently rewriting it', async () => {
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
                name: 'Too many processes',
                severity: 'medium',
                conditions: [{ type: 'metric', metric: 'processCount', operator: 'gt', value: 400 }],
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

    fireEvent.click(screen.getByText('Too many processes'));
    expect(metricSelect().value).toBe('processCount');

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const conditions = lastSavedItems()[0]!.conditions as Array<Record<string, unknown>>;
    expect(conditions[0]).toMatchObject({ metric: 'processCount' });
  });

  it('drops the dead `duration` (seconds) field from a metric condition on load', async () => {
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
                name: 'Legacy duration',
                severity: 'high',
                conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80, duration: 300 }],
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

    const conditions = lastSavedItems()[0]!.conditions as Array<Record<string, unknown>>;
    expect(conditions[0]).not.toHaveProperty('duration');
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

  it('clamps an offline duration above the 24h re-eval horizon to 1440 (issue #1982)', async () => {
    render(
      <AlertRuleTab
        policyId="policy-1"
        existingLink={undefined}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    addFirstRule();

    const typeSelect = controlForLabel('Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'offline' } });

    const durationInput = controlForLabel('Offline Duration (min)') as HTMLInputElement;
    fireEvent.change(durationInput, { target: { value: '10080' } });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const condition = lastSavedItems()[0]!.conditions as Array<Record<string, unknown>>;
    expect(condition[0]).toMatchObject({ type: 'offline', durationMinutes: 1440 });
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

// The 2026-07-30 consolidation moved event log alert rules out of the Monitoring
// feature and into ordinary alert-rule conditions, and dropped `custom` (which
// the API evaluator never had a handler for and the write schema now rejects).
describe('AlertRuleTab condition types after the alert consolidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({
      id: 'link-1',
      featureType: 'alert_rule',
      featurePolicyId: null,
      inlineSettings: {},
    });
  });

  function renderEmpty() {
    render(
      <AlertRuleTab
        policyId="policy-1"
        existingLink={undefined}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );
  }

  function renderWithItems(items: Array<Record<string, unknown>>) {
    render(
      <AlertRuleTab
        policyId="policy-1"
        existingLink={{
          id: 'link-1',
          featureType: 'alert_rule',
          featurePolicyId: null,
          inlineSettings: { items },
        }}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );
  }

  it('offers exactly metric, offline and event_log — never the dead "custom" type', () => {
    renderEmpty();
    addFirstRule();

    const typeSelect = controlForLabel('Type');
    const values = within(typeSelect)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(['metric', 'offline', 'event_log']);
    expect(within(typeSelect).queryByRole('option', { name: 'Custom' })).toBeNull();
  });

  it('seeds schema-valid defaults when a condition is switched to Event Log', async () => {
    renderEmpty();
    addFirstRule();

    fireEvent.change(controlForLabel('Type') as HTMLSelectElement, {
      target: { value: 'event_log' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const conditions = lastSavedItems()[0]!.conditions as Array<Record<string, unknown>>;
    expect(conditions[0]).toEqual({
      type: 'event_log',
      category: 'security',
      level: 'error',
      countThreshold: 1,
      windowMinutes: 15,
    });
    // No leftovers from the metric shape it was switched away from.
    expect(conditions[0]).not.toHaveProperty('metric');
    expect(conditions[0]).not.toHaveProperty('operator');
  });

  it('round-trips event_log condition edits through form state', async () => {
    renderEmpty();
    addFirstRule();

    fireEvent.change(controlForLabel('Type') as HTMLSelectElement, {
      target: { value: 'event_log' },
    });

    fireEvent.change(controlForLabel('Event category') as HTMLSelectElement, {
      target: { value: 'application' },
    });
    fireEvent.change(controlForLabel('Minimum level') as HTMLSelectElement, {
      target: { value: 'critical' },
    });
    fireEvent.change(controlForLabel('Source pattern (optional)') as HTMLInputElement, {
      target: { value: 'sshd' },
    });
    fireEvent.change(controlForLabel('Message pattern (optional)') as HTMLInputElement, {
      target: { value: 'failed login' },
    });
    fireEvent.change(controlForLabel('Count threshold') as HTMLInputElement, {
      target: { value: '5' },
    });
    fireEvent.change(controlForLabel('Window (minutes)') as HTMLInputElement, {
      target: { value: '60' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const conditions = lastSavedItems()[0]!.conditions as Array<Record<string, unknown>>;
    expect(conditions[0]).toEqual({
      type: 'event_log',
      category: 'application',
      level: 'critical',
      sourcePattern: 'sshd',
      messagePattern: 'failed login',
      countThreshold: 5,
      windowMinutes: 60,
    });
  });

  it('clamps event_log count/window to the schema bounds', async () => {
    renderEmpty();
    addFirstRule();

    fireEvent.change(controlForLabel('Type') as HTMLSelectElement, {
      target: { value: 'event_log' },
    });
    fireEvent.change(controlForLabel('Count threshold') as HTMLInputElement, {
      target: { value: '99999' },
    });
    fireEvent.change(controlForLabel('Window (minutes)') as HTMLInputElement, {
      target: { value: '99999' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const conditions = lastSavedItems()[0]!.conditions as Array<Record<string, unknown>>;
    expect(conditions[0]).toMatchObject({ countThreshold: 10000, windowMinutes: 1440 });
  });

  it('renders a saved event_log condition (post-migration data) back into its editor', () => {
    renderWithItems([
      {
        name: 'Security errors',
        severity: 'high',
        conditions: [
          {
            type: 'event_log',
            category: 'security',
            level: 'warning',
            sourcePattern: 'EventLog',
            messagePattern: 'denied',
            countThreshold: 3,
            windowMinutes: 30,
          },
        ],
        cooldownMinutes: 15,
        autoResolve: false,
      },
    ]);

    fireEvent.click(screen.getByText('Security errors'));

    expect((controlForLabel('Type') as HTMLSelectElement).value).toBe('event_log');
    expect((controlForLabel('Event category') as HTMLSelectElement).value).toBe('security');
    expect((controlForLabel('Minimum level') as HTMLSelectElement).value).toBe('warning');
    expect((controlForLabel('Source pattern (optional)') as HTMLInputElement).value).toBe(
      'EventLog'
    );
    expect((controlForLabel('Message pattern (optional)') as HTMLInputElement).value).toBe(
      'denied'
    );
    expect((controlForLabel('Count threshold') as HTMLInputElement).value).toBe('3');
    expect((controlForLabel('Window (minutes)') as HTMLInputElement).value).toBe('30');
  });
});

describe('AlertRuleTab legacy condition types the editor no longer offers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({
      id: 'link-1',
      featureType: 'alert_rule',
      featurePolicyId: null,
      inlineSettings: {},
    });
  });

  const legacyItem = {
    name: 'Legacy rule',
    severity: 'high',
    conditions: [
      { type: 'metric', metric: 'cpu', operator: 'gt', value: 80 },
      { type: 'bandwidth_high', networkDirection: 'total', value: 100, durationMinutes: 5 },
    ],
    cooldownMinutes: 15,
    autoResolve: false,
  };

  function renderLegacy() {
    render(
      <AlertRuleTab
        policyId="policy-1"
        existingLink={{
          id: 'link-1',
          featureType: 'alert_rule',
          featurePolicyId: null,
          inlineSettings: { items: [legacyItem] },
        }}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );
  }

  it('renders an unknown condition type read-only instead of crashing', () => {
    renderLegacy();
    fireEvent.click(screen.getByText('Legacy rule'));

    // The retired condition row shows its raw type as text and offers no
    // controls at all; the editable sibling row still has its selects.
    const legacyRow = screen.getByTestId('alert-rule-0-condition-1');
    expect(within(legacyRow).getByText('bandwidth_high')).toBeTruthy();
    expect(within(legacyRow).queryAllByRole('combobox')).toHaveLength(0);
    expect(within(legacyRow).queryAllByRole('spinbutton')).toHaveLength(0);
    expect(within(legacyRow).getByText(/no longer editable/i)).toBeTruthy();
    const metricRow = screen.getByTestId('alert-rule-0-condition-0');
    expect(within(metricRow).getAllByRole('combobox').length).toBeGreaterThan(0);
  });

  it('warns on the rule rather than blocking the whole tab', () => {
    renderLegacy();

    // Flagged while collapsed, explained once expanded.
    expect(screen.getByTestId('alert-rule-legacy-flag-0')).toBeTruthy();
    fireEvent.click(screen.getByText('Legacy rule'));
    expect(screen.getByTestId('alert-rule-legacy-warning-0').textContent).toContain(
      'bandwidth_high'
    );
    // The rest of the tab still works — Save is not disabled.
    expect(
      (screen.getByRole('button', { name: /^Save$/i }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it('preserves the retired condition verbatim when an adjacent condition is edited', async () => {
    renderLegacy();
    fireEvent.click(screen.getByText('Legacy rule'));

    // Edit the sibling metric condition.
    fireEvent.change(controlForLabel('Value (%)') as HTMLInputElement, {
      target: { value: '95' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const conditions = lastSavedItems()[0]!.conditions as Array<Record<string, unknown>>;
    expect(conditions).toHaveLength(2);
    expect(conditions[0]).toMatchObject({ type: 'metric', value: 95 });
    expect(conditions[1]).toEqual({
      type: 'bandwidth_high',
      networkDirection: 'total',
      value: 100,
      durationMinutes: 5,
    });
  });
});

// The rule-card header wraps a delete button, so it cannot itself be a native
// <button>: React logs "In HTML, <button> cannot be a descendant of <button>.
// This will cause a hydration error." on every expand. It is a role="button"
// disclosure with an explicit keydown handler instead — the pattern
// MonitoringTab's WatchCard already uses (disclosureKeyboard.ts).
describe('AlertRuleTab rule-card header is a non-nesting disclosure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({
      id: 'link-1',
      featureType: 'alert_rule',
      featurePolicyId: null,
      inlineSettings: {},
    });
  });

  function renderOneRule() {
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
    return screen.getByTestId('alert-rule-card-header-0');
  }

  it('renders no nested native button inside the header', () => {
    const header = renderOneRule();

    expect(header.tagName).toBe('DIV');
    expect(header.getAttribute('role')).toBe('button');
    expect(header.getAttribute('tabindex')).toBe('0');
    // The delete control is a real <button> and must not sit inside another one.
    expect(header.querySelectorAll('button').length).toBeGreaterThan(0);
    expect(header.closest('button')).toBeNull();
  });

  it('toggles the rule open and closed on click', () => {
    const header = renderOneRule();

    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');

    const panelId = header.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId!)).not.toBeNull();

    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(panelId!)).toBeNull();
  });

  it('toggles on Enter and on Space, preventing the Space page-scroll', () => {
    const header = renderOneRule();

    fireEvent.keyDown(header, { key: 'Enter' });
    expect(header.getAttribute('aria-expanded')).toBe('true');

    const spaceEvent = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    fireEvent(header, spaceEvent);
    expect(spaceEvent.defaultPrevented).toBe(true);
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  it('ignores keys other than Enter and Space', () => {
    const header = renderOneRule();

    fireEvent.keyDown(header, { key: 'a' });
    fireEvent.keyDown(header, { key: 'ArrowDown' });

    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  it('does not toggle when a keydown originates from the nested delete button', () => {
    const header = renderOneRule();
    const deleteButton = header.querySelector('button')!;

    fireEvent.keyDown(deleteButton, { key: 'Enter' });

    expect(header.getAttribute('aria-expanded')).toBe('false');
  });
});
