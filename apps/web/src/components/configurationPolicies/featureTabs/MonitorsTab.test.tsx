import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MonitorsTab from './MonitorsTab';

// useFeatureLink wraps the save/remove API calls; stub it so we can assert the
// payload the tab submits without hitting the network.
const saveMock = vi.fn(async () => ({ id: 'link-1' }));
const removeMock = vi.fn(async () => true);

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

// The tab fetches the monitor catalog on mount (GET /monitor-definitions).
const { fetchWithAuthMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      data: [
        { id: 'm1', name: 'High CPU', kind: 'cpu', severity: 'warning', enabled: true },
        { id: 'm2', name: 'Disk full', kind: 'disk', severity: 'critical', enabled: true },
      ],
    }),
  })),
}));
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
}));

import type { FeatureTabProps } from './types';

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

function inlineSettingsFromCall(call: unknown[]): Record<string, unknown> | undefined {
  for (const arg of call) {
    if (arg && typeof arg === 'object' && 'inlineSettings' in (arg as object)) {
      return (arg as { inlineSettings: Record<string, unknown> }).inlineSettings;
    }
  }
  return undefined;
}

function clickSave() {
  const saveButton = screen
    .getAllByRole('button')
    .find((b) => /^save$/i.test((b.textContent ?? '').trim())) as HTMLButtonElement;
  fireEvent.click(saveButton);
}

beforeEach(() => {
  saveMock.mockClear();
  removeMock.mockClear();
  fetchWithAuthMock.mockClear();
  vi.mocked(baseProps.onLinkChanged).mockClear();
});

describe('MonitorsTab', () => {
  it('attaches an existing monitor from the picker and saves it', async () => {
    render(<MonitorsTab {...baseProps} />);

    const select = await screen.findByTestId('monitors-tab-attach-select');
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: 'm1' } });

    expect(await screen.findByTestId('monitors-tab-item-m1')).toBeTruthy();

    clickSave();

    expect(saveMock).toHaveBeenCalled();
    const inline = inlineSettingsFromCall(saveMock.mock.calls[0]);
    expect(inline?.items).toEqual([
      { monitorId: 'm1', enabled: true, overrides: undefined, sortOrder: 0 },
    ]);
    const call = saveMock.mock.calls[0] as unknown as [
      string | null,
      { featureType: string; featurePolicyId: string | null },
    ];
    expect(call[0]).toBeNull();
    expect(call[1].featureType).toBe('monitors');
    expect(call[1].featurePolicyId).toBeNull();
  });

  it('reflects a disabled toggle and a value override in the saved payload', async () => {
    render(<MonitorsTab {...baseProps} />);

    const select = await screen.findByTestId('monitors-tab-attach-select');
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: 'm1' } });
    await screen.findByTestId('monitors-tab-item-m1');

    fireEvent.click(screen.getByTestId('monitors-tab-item-enabled-m1'));
    fireEvent.change(screen.getByTestId('monitors-tab-item-override-m1'), {
      target: { value: '95' },
    });

    clickSave();

    expect(saveMock).toHaveBeenCalled();
    const inline = inlineSettingsFromCall(saveMock.mock.calls[0]);
    expect(inline?.items).toEqual([
      { monitorId: 'm1', enabled: false, overrides: { value: 95 }, sortOrder: 0 },
    ]);
  });

  // Regression for #6493: deleting a monitor definition that's attached to a
  // policy used to leave the Monitors tab rendering the orphaned item as a
  // bare UUID with no indication anything was wrong. Once the catalog fetch
  // finishes and an attached monitorId isn't in it, the row must render as an
  // explicit "deleted" state (not a bare UUID) with a working remove action.
  it('renders an attached monitor no longer in the catalog as deleted, not a bare UUID', async () => {
    const deletedMonitorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const existingLink = {
      id: 'link-1',
      featureType: 'monitors' as const,
      featurePolicyId: null,
      inlineSettings: { items: [{ monitorId: deletedMonitorId, enabled: true, sortOrder: 0 }] },
    };
    render(<MonitorsTab {...baseProps} existingLink={existingLink} />);

    const row = await screen.findByTestId(`monitors-tab-item-${deletedMonitorId}`);
    // The bug: the row used to fall back to rendering the raw UUID as its title.
    expect(row.textContent).not.toContain(deletedMonitorId);
    expect(row.textContent).toContain('Monitor deleted');
    expect(screen.getByTestId(`monitors-tab-item-deleted-${deletedMonitorId}`)).toBeTruthy();

    // Still removable via the existing detach control.
    fireEvent.click(screen.getByTestId(`monitors-tab-item-detach-${deletedMonitorId}`));
    clickSave();
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith('link-1'));
  });

  it('detaching the only attached monitor and saving removes the feature link', async () => {
    const existingLink = {
      id: 'link-1',
      featureType: 'monitors' as const,
      featurePolicyId: null,
      inlineSettings: { items: [{ monitorId: 'm1', enabled: true, sortOrder: 0 }] },
    };
    render(<MonitorsTab {...baseProps} existingLink={existingLink} />);

    await screen.findByTestId('monitors-tab-item-m1');
    fireEvent.click(screen.getByTestId('monitors-tab-item-detach-m1'));

    clickSave();

    await waitFor(() => expect(removeMock).toHaveBeenCalledWith('link-1'));
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('renders an inherited parent row as inherited without submitting it until Override is used', async () => {
    const parentLink = {
      id: 'parent-link-1',
      featureType: 'monitors' as const,
      featurePolicyId: null,
      inlineSettings: { items: [{ monitorId: 'm2', enabled: true, sortOrder: 0 }] },
    };
    render(<MonitorsTab {...baseProps} parentLink={parentLink} />);

    // Nothing is saved just by rendering the inherited state.
    expect(saveMock).not.toHaveBeenCalled();

    const row = await screen.findByTestId('monitors-tab-item-m2');
    expect(row.textContent).toContain('Inherited');

    // No Save button while fully inherited — only Override is available.
    expect(
      screen.queryAllByRole('button').find((b) => /^save$/i.test((b.textContent ?? '').trim())),
    ).toBeUndefined();

    const overrideButton = screen
      .getAllByRole('button')
      .find((b) => /override/i.test(b.textContent ?? '')) as HTMLButtonElement;
    fireEvent.click(overrideButton);

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const call = saveMock.mock.calls[0] as unknown as [string | null, unknown];
    expect(call[0]).toBeNull();
    const inline = inlineSettingsFromCall(saveMock.mock.calls[0]);
    expect(inline?.items).toEqual([
      { monitorId: 'm2', enabled: true, overrides: undefined, sortOrder: 0 },
    ]);
    expect(inline?.inheritance).toBe('cumulative');
  });

  it('sends featurePolicyId: null even when a linked config policy is set', async () => {
    render(<MonitorsTab {...baseProps} linkedPolicyId="parent-1" />);

    const select = await screen.findByTestId('monitors-tab-attach-select');
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: 'm1' } });
    await screen.findByTestId('monitors-tab-item-m1');

    clickSave();

    expect(saveMock).toHaveBeenCalled();
    const call = saveMock.mock.calls[0] as unknown as [unknown, { featurePolicyId: string | null }];
    expect(call[1].featurePolicyId).toBeNull();
  });
});

const monitoringLink = (over: Partial<{ id: string; inlineSettings: Record<string, unknown> }> = {}) => ({
  id: 'link-svc', featureType: 'monitoring' as const, featurePolicyId: null,
  inlineSettings: { checkIntervalSeconds: 60, watches: [{ watchType: 'service', name: 'Spooler' }] },
  ...over,
});
const ownMonitorsLink = { id: 'link-1', featureType: 'monitors' as const, featurePolicyId: null, inlineSettings: { items: [{ monitorId: 'm1', enabled: true }] } };

describe('MonitorsTab — check interval write-through (W05c2)', () => {
  it('PATCHes the existing monitoring link with the new interval and its watches untouched', async () => {
    render(<MonitorsTab {...baseProps} existingLink={ownMonitorsLink} siblingLinks={[ownMonitorsLink, monitoringLink()]} />);
    const input = (await screen.findByTestId('monitors-tab-check-interval')) as HTMLInputElement;
    expect(input.value).toBe('60');
    fireEvent.change(input, { target: { value: '120' } });
    clickSave();
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));
    const [linkId, payload] = saveMock.mock.calls[1] as unknown as [string | null, { featureType: string; inlineSettings: Record<string, unknown> }];
    expect(linkId).toBe('link-svc');
    expect(payload.featureType).toBe('monitoring');
    expect(payload.inlineSettings).toEqual({ checkIntervalSeconds: 120, watches: [{ watchType: 'service', name: 'Spooler' }] });
    expect(baseProps.onLinkChanged).toHaveBeenCalledWith(expect.objectContaining({ id: 'link-1' }), 'monitoring');
  });

  it('creates an empty-watch monitoring link when the policy has none', async () => {
    render(<MonitorsTab {...baseProps} existingLink={ownMonitorsLink} siblingLinks={[ownMonitorsLink]} />);
    fireEvent.change(await screen.findByTestId('monitors-tab-check-interval'), { target: { value: '30' } });
    clickSave();
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));
    const [linkId, payload] = saveMock.mock.calls[1] as unknown as [string | null, { inlineSettings: Record<string, unknown> }];
    expect(linkId).toBeNull();
    expect(payload.inlineSettings).toEqual({ checkIntervalSeconds: 30, watches: [] });
  });

  it('leaves the monitoring link alone when the interval did not change', async () => {
    render(<MonitorsTab {...baseProps} existingLink={ownMonitorsLink} siblingLinks={[ownMonitorsLink, monitoringLink()]} />);
    await screen.findByTestId('monitors-tab-check-interval');
    clickSave();
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
  });

  it('refuses an interval outside 10–3600 without saving anything', async () => {
    render(<MonitorsTab {...baseProps} existingLink={ownMonitorsLink} siblingLinks={[ownMonitorsLink]} />);
    fireEvent.change(await screen.findByTestId('monitors-tab-check-interval'), { target: { value: '5' } });
    clickSave();
    expect(await screen.findByText(/between 10 and 3600/i)).toBeInTheDocument();
    expect(saveMock).not.toHaveBeenCalled();
  });
});

describe('MonitorsTab — inheritance switch (W05c2)', () => {
  const parentLink = { id: 'link-parent', featureType: 'monitors' as const, featurePolicyId: null, inlineSettings: { items: [{ monitorId: 'm2', enabled: true }] } };

  it('defaults to cumulative and saves the choice with the items', async () => {
    render(<MonitorsTab {...baseProps} existingLink={ownMonitorsLink} />);
    const cumulative = (await screen.findByTestId('monitors-tab-inheritance-cumulative')) as HTMLInputElement;
    expect(cumulative.checked).toBe(true);
    fireEvent.click(screen.getByTestId('monitors-tab-inheritance-replace'));
    clickSave();
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(inlineSettingsFromCall(saveMock.mock.calls[0] as unknown[])).toEqual({
      items: [{ monitorId: 'm1', enabled: true, overrides: undefined, sortOrder: 0 }],
      inheritance: 'replace',
    });
  });

  it('saves an empty replacement so inherited monitors stay suppressed', async () => {
    render(<MonitorsTab {...baseProps} existingLink={{ ...ownMonitorsLink,
      inlineSettings: { items: [], inheritance: 'replace' } }} parentLink={parentLink} />);
    await screen.findByTestId('monitors-tab-inheritance-replace');
    clickSave();
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(inlineSettingsFromCall(saveMock.mock.calls[0])).toEqual({ items: [], inheritance: 'replace' });
    expect(removeMock).not.toHaveBeenCalled();
  });
  it('seeds the switch from the saved link', async () => {
    render(<MonitorsTab {...baseProps} existingLink={{ ...ownMonitorsLink, inlineSettings: { ...ownMonitorsLink.inlineSettings, inheritance: 'replace' } }} parentLink={parentLink} />);
    expect(((await screen.findByTestId('monitors-tab-inheritance-replace')) as HTMLInputElement).checked).toBe(true);
  });

  it('lists the parent monitors being ignored while replacing', async () => {
    render(<MonitorsTab {...baseProps} existingLink={{ ...ownMonitorsLink, inlineSettings: { ...ownMonitorsLink.inlineSettings, inheritance: 'replace' } }} parentLink={parentLink} />);
    const ignored = await screen.findByTestId('monitors-tab-ignored-inherited');
    await waitFor(() => expect(ignored.textContent).toContain('Disk full')); // m2's catalog name
  });

  it('shows no ignored list in cumulative mode', async () => {
    render(<MonitorsTab {...baseProps} existingLink={ownMonitorsLink} parentLink={parentLink} />);
    await screen.findByTestId('monitors-tab-inheritance-cumulative');
    expect(screen.queryByTestId('monitors-tab-ignored-inherited')).toBeNull();
  });
});

vi.mock('../../monitoring/conversion/NeedsConversionPanel', () => ({
  default: (p: { hasLegacyRows: boolean }) => <div data-testid="needs-conversion-panel" data-legacy={String(p.hasLegacyRows)} />,
}));
describe('MonitorsTab — Needs-conversion mount gate (W05c2)', () => {
  it('passes hasLegacyRows=true when the policy carries an alert_rule, a watch-bearing monitoring or an automation link', async () => {
    render(<MonitorsTab {...baseProps} siblingLinks={[{ id: 'l1', featureType: 'alert_rule', featurePolicyId: null, inlineSettings: { items: [{ name: 'x' }] } }]} />);
    expect((await screen.findByTestId('needs-conversion-panel')).getAttribute('data-legacy')).toBe('true');
  });
  it('includes an automation-only policy using the canonical singular feature type', async () => {
    render(<MonitorsTab {...baseProps} siblingLinks={[{ id: 'workflow', featureType: 'automation', featurePolicyId: null,
      inlineSettings: { items: [{ triggerType: 'event', eventType: 'alert.triggered' }] } }]} />);
    expect(await screen.findByTestId('needs-conversion-panel')).toHaveAttribute('data-legacy', 'true');
  });
  it('passes hasLegacyRows=false for a monitoring link with no watches (the Check-interval carrier)', async () => {
    render(<MonitorsTab {...baseProps} siblingLinks={[{ id: 'l1', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { checkIntervalSeconds: 60, watches: [] } }]} />);
    expect((await screen.findByTestId('needs-conversion-panel')).getAttribute('data-legacy')).toBe('false');
  });
});
