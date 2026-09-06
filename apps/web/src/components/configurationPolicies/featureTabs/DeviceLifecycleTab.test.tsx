import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DeviceLifecycleTab from './DeviceLifecycleTab';

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

import type { FeatureLink, FeatureTabProps } from './types';

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

function link(purgeRemovedAfterDays: number | null): FeatureLink {
  return {
    id: 'link-parent',
    featureType: 'device_lifecycle',
    featurePolicyId: null,
    inlineSettings: { purgeRemovedAfterDays },
  };
}

function clickSave() {
  const saveButton = screen
    .getAllByRole('button')
    .find((b) => /^save/i.test(b.textContent?.trim() ?? '')) as HTMLButtonElement;
  fireEvent.click(saveButton);
  return saveButton;
}

function savedSettings(call: unknown[]): Record<string, unknown> | undefined {
  for (const arg of call) {
    if (arg && typeof arg === 'object' && 'inlineSettings' in (arg as object)) {
      return (arg as { inlineSettings: Record<string, unknown> }).inlineSettings;
    }
  }
  return undefined;
}

describe('DeviceLifecycleTab', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
  });

  it('defaults to OFF, so adding the feature to a policy never starts deleting anything on its own', () => {
    render(<DeviceLifecycleTab {...baseProps} />);

    const toggle = screen.getByTestId('device-lifecycle-tab-enabled-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    // The day input is not offered while purging is off.
    expect(screen.queryByTestId('device-lifecycle-tab-days')).toBeNull();
  });

  it('saves purgeRemovedAfterDays: null while off', () => {
    render(<DeviceLifecycleTab {...baseProps} />);

    clickSave();

    expect(saveMock).toHaveBeenCalled();
    expect(savedSettings(saveMock.mock.calls[0]!)).toEqual({ purgeRemovedAfterDays: null });
  });

  it('saves the entered window once purging is switched on', () => {
    render(<DeviceLifecycleTab {...baseProps} />);

    fireEvent.click(screen.getByTestId('device-lifecycle-tab-enabled-toggle'));
    fireEvent.change(screen.getByTestId('device-lifecycle-tab-days'), { target: { value: '30' } });
    clickSave();

    expect(saveMock).toHaveBeenCalled();
    const call = saveMock.mock.calls[0]!;
    expect(call.some((arg) => (arg as { featureType?: string })?.featureType === 'device_lifecycle')).toBe(true);
    expect(savedSettings(call)).toEqual({ purgeRemovedAfterDays: 30 });
  });

  it('switching back off discards the number and saves null', () => {
    render(<DeviceLifecycleTab {...baseProps} />);
    const toggle = screen.getByTestId('device-lifecycle-tab-enabled-toggle');

    fireEvent.click(toggle);
    fireEvent.change(screen.getByTestId('device-lifecycle-tab-days'), { target: { value: '30' } });
    fireEvent.click(toggle);
    clickSave();

    expect(savedSettings(saveMock.mock.calls[0]!)).toEqual({ purgeRemovedAfterDays: null });
  });

  it('refuses to save 0 days client-side rather than letting the server 400 it', () => {
    render(<DeviceLifecycleTab {...baseProps} />);

    fireEvent.click(screen.getByTestId('device-lifecycle-tab-enabled-toggle'));
    fireEvent.change(screen.getByTestId('device-lifecycle-tab-days'), { target: { value: '0' } });

    // 0 would read as "delete every removed device on the next run"; the API
    // validator's floor of 1 exists for that reason and the UI must not let a
    // user express it at all.
    expect(screen.getByTestId('device-lifecycle-tab-days-error')).toBeTruthy();
    clickSave();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it.each([['-5'], ['4000'], ['']])('refuses to save an out-of-range window (%s)', (value) => {
    render(<DeviceLifecycleTab {...baseProps} />);

    fireEvent.click(screen.getByTestId('device-lifecycle-tab-enabled-toggle'));
    fireEvent.change(screen.getByTestId('device-lifecycle-tab-days'), { target: { value } });

    expect(screen.getByTestId('device-lifecycle-tab-days-error')).toBeTruthy();
    clickSave();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('shows the inherited window read-only when only a parent link exists', () => {
    render(<DeviceLifecycleTab {...baseProps} parentLink={link(45)} />);

    expect(screen.getByText(/Configured \(inherited\)/i)).toBeTruthy();
    expect((screen.getByTestId('device-lifecycle-tab-days') as HTMLInputElement).value).toBe('45');
  });

  it('warns that the purge is irreversible and that draining uninstalls are skipped', () => {
    render(<DeviceLifecycleTab {...baseProps} />);

    const warning = screen.getByTestId('device-lifecycle-tab-warning').textContent ?? '';
    expect(warning).toMatch(/irreversible/i);
    expect(warning).toMatch(/uninstall/i);
  });

  it('hydrates from an existing link rather than the default', () => {
    render(<DeviceLifecycleTab {...baseProps} existingLink={{ ...link(90), id: 'link-own' }} />);

    expect((screen.getByTestId('device-lifecycle-tab-days') as HTMLInputElement).value).toBe('90');
    expect(screen.getByTestId('device-lifecycle-tab-enabled-toggle').getAttribute('aria-checked')).toBe('true');
  });

  // Paper cut (#5023): the hint under the toggle was hard-coded to the OFF
  // sentence, so a policy that purges after 30 days still read "Off — keep
  // removed devices until someone deletes them manually" directly above the
  // window it was about to enforce. The hint has to follow the toggle.
  describe('the hint under the toggle describes the state actually selected', () => {
    it('says nothing is deleted while purging is off', () => {
      render(<DeviceLifecycleTab {...baseProps} />);

      const hint = screen.getByTestId('device-lifecycle-tab-mode-hint').textContent ?? '';
      expect(hint).toMatch(/^Off/);
      expect(hint).toMatch(/until someone deletes them manually/i);
    });

    it('states the configured window once purging is on', () => {
      render(<DeviceLifecycleTab {...baseProps} existingLink={{ ...link(45), id: 'link-own' }} />);

      const hint = screen.getByTestId('device-lifecycle-tab-mode-hint').textContent ?? '';
      expect(hint).toMatch(/permanently deleted 45 days after removal/i);
      // The discriminating half: the OFF sentence must be GONE, not merely
      // joined by the new one.
      expect(hint).not.toMatch(/until someone deletes them manually/i);
    });

    it('follows the toggle rather than the saved link', () => {
      render(<DeviceLifecycleTab {...baseProps} existingLink={{ ...link(45), id: 'link-own' }} />);
      fireEvent.click(screen.getByTestId('device-lifecycle-tab-enabled-toggle'));

      const hint = screen.getByTestId('device-lifecycle-tab-mode-hint').textContent ?? '';
      expect(hint).toMatch(/until someone deletes them manually/i);
      expect(hint).not.toMatch(/45 days/);
    });
  });
});
