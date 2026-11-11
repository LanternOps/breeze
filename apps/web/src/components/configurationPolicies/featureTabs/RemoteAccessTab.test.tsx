import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RemoteAccessTab from './RemoteAccessTab';

// useFeatureLink wraps the save/remove API calls; stub it so we can assert the
// payload the tab submits without hitting the network. We capture the `save`
// calls so the test can inspect the inlineSettings the toggles produce.
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

import type { FeatureTabProps } from './types';

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

// Find the inlineSettings object regardless of save()'s exact arg order.
function inlineSettingsFromCall(call: unknown[]): Record<string, unknown> | undefined {
  for (const arg of call) {
    if (arg && typeof arg === 'object' && 'inlineSettings' in (arg as object)) {
      return (arg as { inlineSettings: Record<string, unknown> }).inlineSettings;
    }
  }
  return undefined;
}

describe('RemoteAccessTab — clipboard policy toggles', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
  });

  it('renders both clipboard direction toggles', () => {
    render(<RemoteAccessTab {...baseProps} />);
    expect(
      screen.getByText('Clipboard: remote → viewer (copy from remote)'),
    ).toBeTruthy();
    expect(
      screen.getByText('Clipboard: viewer → remote (paste to remote)'),
    ).toBeTruthy();
  });

  it('notes the host→viewer direction is the data-egress one', () => {
    render(<RemoteAccessTab {...baseProps} />);
    expect(screen.getByText(/data-egress direction/i)).toBeTruthy();
  });

  it('saves both clipboard fields with the rest of the settings', async () => {
    render(<RemoteAccessTab {...baseProps} />);

    // Turn OFF the egress direction so we can assert the value is wired through.
    const egressLabel = screen.getByText(
      'Clipboard: remote → viewer (copy from remote)',
    );
    const row = egressLabel.closest('div')?.parentElement as HTMLElement;
    const toggleButton = row.querySelector('button') as HTMLButtonElement;
    fireEvent.click(toggleButton);

    // Click the Save action (FeatureTabShell renders a Save button).
    const saveButton = screen
      .getAllByRole('button')
      .find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(saveButton).toBeTruthy();
    fireEvent.click(saveButton);

    expect(saveMock).toHaveBeenCalled();
    const settings = inlineSettingsFromCall(saveMock.mock.calls[0]);
    expect(settings).toBeDefined();
    expect(settings).toMatchObject({
      clipboardHostToViewer: false, // toggled off above
      clipboardViewerToHost: true, // default on
    });
  });
});

// #10422: a new policy's idle timeout starts at the same 30 min as the
// no-policy baseline, so linking the feature (e.g. to turn VNC on) does not
// silently cut the idle timeout back to 5 min.
describe('RemoteAccessTab — idle timeout default (#10422)', () => {
  beforeEach(() => {
    saveMock.mockClear();
  });

  it('saves a 30-minute idle timeout for a new policy left at its defaults', () => {
    render(<RemoteAccessTab {...baseProps} />);
    const saveButton = screen
      .getAllByRole('button')
      .find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    fireEvent.click(saveButton);
    expect(saveMock).toHaveBeenCalled();
    expect(inlineSettingsFromCall(saveMock.mock.calls[0])).toMatchObject({
      idleTimeoutMinutes: 30,
      maxSessionDurationHours: 8,
    });
  });
});

// #5080: Remote Access gains the same isInherited/effectiveLink/Override/
// Revert treatment as the other inline-settings tabs (mirrors PamTab.tsx).
describe('RemoteAccessTab inheritance (#5080)', () => {
  const onLinkChanged = vi.fn();
  const inheritedProps: FeatureTabProps = { ...baseProps, onLinkChanged };

  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
    onLinkChanged.mockClear();
  });

  function parentLinkWith(overrides: Record<string, unknown>) {
    return {
      id: 'link-parent',
      featureType: 'remote_access' as const,
      featurePolicyId: null,
      inlineSettings: { maxConcurrentTunnels: 5, ...overrides },
    };
  }

  it('shows Configured (inherited) and seeds the form from parentLink when only a parent link exists', () => {
    render(<RemoteAccessTab {...inheritedProps} parentLink={parentLinkWith({ maxConcurrentTunnels: 12 })} />);

    expect(screen.getByText(/Configured \(inherited\)/i)).toBeTruthy();
    // maxConcurrentTunnels defaults to 5; the parent link's distinctive
    // override (12) must be reflected in the (read-only) field.
    expect((screen.getByDisplayValue('12') as HTMLInputElement).value).toBe('12');
  });

  it("Override saves a copy of the inherited settings as the policy's own link", () => {
    render(<RemoteAccessTab {...inheritedProps} parentLink={parentLinkWith({ maxConcurrentTunnels: 12 })} />);

    fireEvent.click(screen.getByRole('button', { name: /override/i }));

    expect(saveMock).toHaveBeenCalled();
    const [existingId, payload] = saveMock.mock.calls[0] as unknown as [
      string | null,
      { featureType: string; featurePolicyId: string | null; inlineSettings: Record<string, unknown> },
    ];
    expect(existingId).toBeNull();
    expect(payload.featureType).toBe('remote_access');
    expect(payload.featurePolicyId).toBeNull();
    expect(payload.inlineSettings).toMatchObject({ maxConcurrentTunnels: 12 });
  });

  it('Revert to Parent removes the override', async () => {
    const existingLink = {
      id: 'link-own',
      featureType: 'remote_access' as const,
      featurePolicyId: null,
      inlineSettings: { maxConcurrentTunnels: 8 },
    };
    render(
      <RemoteAccessTab
        {...inheritedProps}
        existingLink={existingLink}
        parentLink={parentLinkWith({ maxConcurrentTunnels: 12 })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /revert to parent/i }));
    // #5314: Revert to Parent now asks for confirmation first.
    fireEvent.click(screen.getByTestId('feature-tab-revert-confirm'));

    expect(removeMock).toHaveBeenCalledWith('link-own');
    // The detail page's own featureLinks state must be told the override is
    // gone (#5080) — otherwise it stays stale after a successful revert.
    await waitFor(() => expect(onLinkChanged).toHaveBeenCalledWith(null, 'remote_access'));
  });
});

describe('RemoteAccessTab — consent-mode help', () => {
  function selectConsent() {
    const select = screen.getByTestId('remote-access-session-prompt-mode') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'consent' } });
  }

  it('describes every case the unavailable-behavior setting covers today', () => {
    render(<RemoteAccessTab {...baseProps} />);
    selectConsent();
    const help = screen.getByTestId('remote-access-consent-unavailable-help').textContent ?? '';
    expect(help).toMatch(/no one is signed in/i);
    expect(help).toMatch(/can't be shown/i);
    expect(help).toMatch(/doesn't answer/i);
  });

  it('tells the admin that VNC is refused while consent is required', () => {
    render(<RemoteAccessTab {...baseProps} />);
    expect(screen.queryByTestId('remote-access-consent-vnc-note')).toBeNull();
    selectConsent();
    expect(screen.getByTestId('remote-access-consent-vnc-note').textContent).toMatch(/VNC/);
  });
});

describe('RemoteAccessTab saves allowUserEndSession (#10190)', () => {
  beforeEach(() => {
    saveMock.mockClear();
  });

  function clickSave() {
    const saveButton = screen
      .getAllByRole('button')
      .find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    fireEvent.click(saveButton);
  }

  it('defaults to true and is saved with the rest of the settings', () => {
    render(<RemoteAccessTab {...baseProps} />);
    clickSave();
    expect(inlineSettingsFromCall(saveMock.mock.calls[0])).toMatchObject({ allowUserEndSession: true });
  });

  it('saves false after the toggle is switched off', () => {
    render(<RemoteAccessTab {...baseProps} />);
    const label = screen.getByText('Let the user end the session');
    const toggle = label.closest('div')?.parentElement?.querySelector('button') as HTMLButtonElement;
    fireEvent.click(toggle);
    clickSave();
    expect(inlineSettingsFromCall(saveMock.mock.calls[0])).toMatchObject({ allowUserEndSession: false });
  });

  it('shows the disabled toggle as off while the indicator is off, without changing the saved value', () => {
    render(<RemoteAccessTab {...baseProps} />);
    const toggleFor = (text: string) =>
      screen.getByText(text).closest('div')?.parentElement?.querySelector('button') as HTMLButtonElement;
    const indicator = toggleFor('Active-session indicator');
    expect(toggleFor('Let the user end the session').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(indicator);
    const endToggle = toggleFor('Let the user end the session');
    expect(endToggle.disabled).toBe(true);
    expect(endToggle.getAttribute('aria-pressed')).toBe('false');
    clickSave();
    expect(inlineSettingsFromCall(saveMock.mock.calls[0])).toMatchObject({
      showActiveIndicator: false,
      allowUserEndSession: true,
    });

    fireEvent.click(indicator);
    expect(toggleFor('Let the user end the session').getAttribute('aria-pressed')).toBe('true');
  });

  it('disables the toggle with a hint when the active-session indicator is off', () => {
    render(<RemoteAccessTab {...baseProps} />);
    const indicator = screen.getByText('Active-session indicator');
    fireEvent.click(indicator.closest('div')?.parentElement?.querySelector('button') as HTMLButtonElement);
    const label = screen.getByText('Let the user end the session');
    const toggle = label.closest('div')?.parentElement?.querySelector('button') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText('Turn on the active-session indicator to let users end a session.')).toBeTruthy();
  });
});
