import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MonitorsTab from './MonitorsTab';

// Ledger requests and lifecycle behavior are covered by ConversionLedger.test.tsx.
vi.mock('../../monitoring/conversion/ConversionLedger', () => ({ default: () => null }));

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
    expect(inline).not.toHaveProperty('checkIntervalSeconds');
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
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith('link-1', expect.objectContaining({
      inlineSettings: { items: [], inheritance: 'cumulative' },
    })));
    expect(removeMock).not.toHaveBeenCalled();
  });

  it.each(['cumulative', 'replace'] as const)('last detachment saves an empty %s link', async (inheritance) => {
    render(<MonitorsTab {...baseProps} existingLink={{ id: 'link-1', featureType: 'monitors',
      featurePolicyId: null, inlineSettings: {
        items: [{ monitorId: 'm1', enabled: true, sortOrder: 0 }], inheritance, checkIntervalSeconds: 60,
      } }} />);
    await screen.findByTestId('monitors-tab-item-m1');
    fireEvent.click(screen.getByTestId('monitors-tab-item-detach-m1'));
    clickSave();
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith('link-1', {
      featureType: 'monitors', featurePolicyId: null,
      inlineSettings: { items: [], inheritance },
    }));
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('renders an inherited parent row as inherited without submitting it until Override is used', async () => {
    const parentLink = {
      id: 'parent-link-1',
      featureType: 'monitors' as const,
      featurePolicyId: null,
      inlineSettings: { items: [{ monitorId: 'm2', enabled: true, sortOrder: 0 }], checkIntervalSeconds: 90 },
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
    expect(inline).not.toHaveProperty('checkIntervalSeconds');
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

const ownMonitorsLink = { id: 'link-1', featureType: 'monitors' as const, featurePolicyId: null, inlineSettings: { items: [{ monitorId: 'm1', enabled: true }], checkIntervalSeconds: 60 } };

describe('MonitorsTab — check interval on monitors (W05d)', () => {
  it('saves the check interval on a new monitors link exactly once', async () => {
    render(<MonitorsTab {...baseProps} />);
    fireEvent.change(await screen.findByTestId('monitors-tab-check-interval'), { target: { value: '120' } });
    clickSave();
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith(null, {
      featureType: 'monitors', featurePolicyId: null,
      inlineSettings: { items: [], inheritance: 'cumulative', checkIntervalSeconds: 120 },
    }));
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('reads the existing monitors interval and saves it with attachments', async () => {
    render(<MonitorsTab {...baseProps} existingLink={{ ...ownMonitorsLink,
      inlineSettings: { ...ownMonitorsLink.inlineSettings, checkIntervalSeconds: 45 } }} />);
    const input = await screen.findByTestId('monitors-tab-check-interval') as HTMLInputElement;
    expect(input.value).toBe('45');
    fireEvent.change(input, { target: { value: '120' } });
    clickSave();
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith('link-1', {
      featureType: 'monitors', featurePolicyId: null,
      inlineSettings: { items: [{ monitorId: 'm1', enabled: true, overrides: undefined, sortOrder: 0 }],
        inheritance: 'cumulative', checkIntervalSeconds: 120 },
    });
  });

  it.each(['cumulative', 'replace'] as const)('Save preserves an already-empty %s link and its settings', async inheritance => {
    render(<MonitorsTab {...baseProps} existingLink={{ id: 'link-1', featureType: 'monitors',
      featurePolicyId: null, inlineSettings: { items: [], inheritance, checkIntervalSeconds: 60 } }} />);
    await screen.findByTestId('monitors-tab-check-interval');
    clickSave();
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith('link-1', {
      featureType: 'monitors', featurePolicyId: null,
      inlineSettings: { items: [], inheritance },
    }));
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('does not create an absent empty cumulative link at the default interval', async () => {
    render(<MonitorsTab {...baseProps} />);
    await screen.findByTestId('monitors-tab-check-interval');
    clickSave();
    expect(saveMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it.each(['cumulative', 'replace'] as const)('Remove clears %s attachments and returns to cumulative without pinning the interval', async inheritance => {
    render(<MonitorsTab {...baseProps} existingLink={{ ...ownMonitorsLink,
      inlineSettings: { ...ownMonitorsLink.inlineSettings, inheritance, checkIntervalSeconds: 45 } }} />);
    await screen.findByTestId('monitors-tab-item-m1');
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    fireEvent.click(await screen.findByTestId('feature-tab-remove-confirm'));
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith('link-1', {
      featureType: 'monitors', featurePolicyId: null,
      inlineSettings: { items: [], inheritance: 'cumulative' },
    }));
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();
    expect(baseProps.onLinkChanged).toHaveBeenCalledWith({ id: 'link-1' }, 'monitors');
    expect(screen.queryByTestId('monitors-tab-item-m1')).toBeNull();
  });

  it('Remove validates the interval before clearing attachments', async () => {
    render(<MonitorsTab {...baseProps} existingLink={ownMonitorsLink} />);
    fireEvent.change(await screen.findByTestId('monitors-tab-check-interval'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    fireEvent.click(await screen.findByTestId('feature-tab-remove-confirm'));
    expect(await screen.findByText(/between 10 and 3600/i)).toBeInTheDocument();
    expect(saveMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('monitors-tab-item-m1')).toBeInTheDocument();
  });

  it('Override does not pin or validate an unedited inherited interval', async () => {
    render(<MonitorsTab {...baseProps} parentLink={{ ...ownMonitorsLink,
      inlineSettings: { ...ownMonitorsLink.inlineSettings, checkIntervalSeconds: 5 } }} />);
    await screen.findByTestId('monitors-tab-check-interval');
    fireEvent.click(screen.getByRole('button', { name: /override/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(inlineSettingsFromCall(saveMock.mock.calls[0])).not.toHaveProperty('checkIntervalSeconds');
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('shows parent interval as inherited despite an own replacement attachment link', async () => {
    render(<MonitorsTab {...baseProps} existingLink={{ ...ownMonitorsLink,
      inlineSettings: { items: [], inheritance: 'replace' } }} parentLink={{ ...ownMonitorsLink,
      id: 'parent-link', inlineSettings: { items: [], checkIntervalSeconds: 30 } }} />);
    expect(await screen.findByTestId('monitors-tab-check-interval')).toHaveValue(30);
    expect(screen.getByTestId('monitors-tab-check-interval-inherited')).toHaveTextContent('Inherited');
    clickSave();
    expect(inlineSettingsFromCall(saveMock.mock.calls[0])).not.toHaveProperty('checkIntervalSeconds');
  });

  it('gives an explicit own interval precedence over the parent interval', async () => {
    render(<MonitorsTab {...baseProps} existingLink={ownMonitorsLink} parentLink={{ ...ownMonitorsLink,
      id: 'parent-link', inlineSettings: { items: [], checkIntervalSeconds: 30 } }} />);
    expect(await screen.findByTestId('monitors-tab-check-interval')).toHaveValue(60);
    expect(screen.queryByTestId('monitors-tab-check-interval-inherited')).toBeNull();
  });

  it('can pin the inherited interval by editing away and back to the shown value', async () => {
    render(<MonitorsTab {...baseProps} existingLink={{ ...ownMonitorsLink,
      inlineSettings: { items: [] } }} parentLink={{ ...ownMonitorsLink,
      id: 'parent-link', inlineSettings: { items: [], checkIntervalSeconds: 30 } }} />);
    const input = await screen.findByTestId('monitors-tab-check-interval');
    fireEvent.change(input, { target: { value: '31' } });
    fireEvent.change(input, { target: { value: '30' } });
    clickSave();
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(inlineSettingsFromCall(saveMock.mock.calls[0])).toHaveProperty('checkIntervalSeconds', 30);
    clickSave();
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));
    expect(inlineSettingsFromCall(saveMock.mock.calls[1])).not.toHaveProperty('checkIntervalSeconds');
  });

  it('can pin the default interval on an empty new link after editing', async () => {
    render(<MonitorsTab {...baseProps} />);
    const input = await screen.findByTestId('monitors-tab-check-interval');
    fireEvent.change(input, { target: { value: '61' } });
    fireEvent.change(input, { target: { value: '60' } });
    clickSave();
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(inlineSettingsFromCall(saveMock.mock.calls[0])).toHaveProperty('checkIntervalSeconds', 60);
  });

  it.each([true, false])('Revert reflects whether the server retained the interval link (%s)', async kept => {
    const retained = { ...ownMonitorsLink, inlineSettings: { items: [], inheritance: 'cumulative', checkIntervalSeconds: 30 } };
    fetchWithAuthMock.mockImplementationOnce((async () => ({ ok: true, json: async () => ({ data: [] }) })) as never)
      .mockImplementationOnce((async () => ({ ok: true, json: async () => ({ data: kept ? [retained] : [] }) })) as never);
    const view = render(<MonitorsTab {...baseProps} existingLink={retained} linkedPolicyId="parent-policy" />);
    fireEvent.change(await screen.findByTestId('monitors-tab-check-interval'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: /revert to parent/i }));
    fireEvent.click(await screen.findByTestId('feature-tab-revert-confirm'));
    await waitFor(() => expect(baseProps.onLinkChanged).toHaveBeenCalledWith(kept ? retained : null, 'monitors'));
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/configuration-policies/policy-1/features');
    if (kept) expect(baseProps.onLinkChanged).not.toHaveBeenCalledWith(null, 'monitors');
    view.rerender(<MonitorsTab {...baseProps} existingLink={kept ? { ...retained } : undefined} linkedPolicyId="parent-policy" />);
    expect(screen.getByTestId('monitors-tab-check-interval')).toHaveValue(kept ? 30 : 60);
    clickSave();
    if (kept) expect(inlineSettingsFromCall(saveMock.mock.calls[0])).not.toHaveProperty('checkIntervalSeconds');
    else expect(saveMock).not.toHaveBeenCalled();
  });

  it.each(['5', '3601', '60.5', ''])('refuses invalid interval %s without saving anything', async value => {
    render(<MonitorsTab {...baseProps} existingLink={ownMonitorsLink} />);
    fireEvent.change(await screen.findByTestId('monitors-tab-check-interval'), { target: { value } });
    clickSave();
    expect(await screen.findByText(/between 10 and 3600/i)).toBeInTheDocument();
    expect(saveMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
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
  default: (p: { hasLegacyRows: boolean; onChanged: () => void }) => (
    <div data-testid="needs-conversion-panel" data-legacy={String(p.hasLegacyRows)}>
      <button type="button" data-testid="needs-conversion-panel-changed" onClick={p.onChanged}>changed</button>
    </div>
  ),
}));
describe('MonitorsTab — conversion after legacy feature retirement', () => {
  it('checks conversion state even when retired feature links are absent', async () => {
    render(<MonitorsTab {...baseProps} siblingLinks={[]} />);
    expect(await screen.findByTestId('needs-conversion-panel')).toHaveAttribute('data-legacy', 'true');
  });

  it('includes an automation-only policy using the canonical singular feature type', async () => {
    render(<MonitorsTab {...baseProps} siblingLinks={[{ id: 'workflow', featureType: 'automation', featurePolicyId: null,
      inlineSettings: { items: [{ triggerType: 'event', eventType: 'alert.triggered' }] } }]} />);
    expect(await screen.findByTestId('needs-conversion-panel')).toHaveAttribute('data-legacy', 'true');
  });

  it('refetches active policy links after conversion and clears removed automation links', async () => {
    const monitorsAfter = { id: 'link-new', featureType: 'monitors', featurePolicyId: null, inlineSettings: { items: [] } };
    fetchWithAuthMock
      .mockImplementationOnce((async () => ({ ok: true, json: async () => ({ data: [] }) })) as never)
      .mockImplementationOnce((async (url: string) => ({
        ok: true,
        json: async () => ({ data: url === '/configuration-policies/policy-1/features' ? [monitorsAfter] : [] }),
      })) as never);
    render(<MonitorsTab {...baseProps} siblingLinks={[]} />);
    fireEvent.click(await screen.findByTestId('needs-conversion-panel-changed'));
    await waitFor(() => expect(baseProps.onLinkChanged).toHaveBeenCalledTimes(2));
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/configuration-policies/policy-1/features');
    expect(baseProps.onLinkChanged).toHaveBeenCalledWith(monitorsAfter, 'monitors');
    expect(baseProps.onLinkChanged).toHaveBeenCalledWith(null, 'automation');
  });
});
