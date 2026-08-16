import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HelperTab from './HelperTab';

const saveMock = vi.hoisted(() => vi.fn(async () => ({ id: 'link-1' })));

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: vi.fn(async () => true),
    saving: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

import type { FeatureTabProps, FeatureLink } from './types';

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

const helperLink = (enabled: boolean): FeatureLink => ({
  id: 'link-1',
  featureType: 'helper',
  featurePolicyId: null,
  inlineSettings: { enabled },
});

describe('HelperTab', () => {
  it('keeps tray-menu options visible but disabled when deploy is off (#1863)', () => {
    render(<HelperTab {...baseProps} />);

    // The toggles are discoverable (rendered), not hidden...
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    // 4 = tray icon (#3202) + the three menu items.
    expect(checkboxes.length).toBe(4);
    // ...but disabled until deploy is enabled, with a hint explaining why.
    expect(checkboxes.every((c) => c.disabled)).toBe(true);
    expect(screen.getByText(/Enable "Deploy Breeze Assist to devices" above/i)).toBeTruthy();
  });

  it('shows a "Saved (not deployed)" badge when a link exists but deploy is off', () => {
    render(<HelperTab {...baseProps} existingLink={helperLink(false)} />);
    expect(screen.getByText('Saved (not deployed)')).toBeTruthy();
    expect(screen.queryByText('Configured')).toBeNull();
  });

  it('shows "Configured" and enables the toggles when deploy is on', () => {
    render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
    expect(screen.getByText('Configured')).toBeTruthy();
    expect(screen.queryByText('Saved (not deployed)')).toBeNull();
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.every((c) => !c.disabled)).toBe(true);
  });

  it('defaults the tray-icon toggle to on and saves it as true (#3202)', async () => {
    saveMock.mockClear();
    render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
    const trayIcon = screen.getByTestId('helper-show-tray-icon') as HTMLInputElement;
    expect(trayIcon.checked).toBe(true);

    fireEvent.click(screen.getByText('Save'));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    const call = saveMock.mock.calls[0] as unknown as [
      unknown,
      { inlineSettings: Record<string, unknown> },
    ];
    expect(call[1].inlineSettings.showTrayIcon).toBe(true);
  });

  it('saves showTrayIcon:false when the tray-icon toggle is turned off (#3202)', async () => {
    saveMock.mockClear();
    render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
    fireEvent.click(screen.getByTestId('helper-show-tray-icon'));
    expect((screen.getByTestId('helper-show-tray-icon') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByText('Save'));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    const call = saveMock.mock.calls[0] as unknown as [
      unknown,
      { inlineSettings: Record<string, unknown> },
    ];
    expect(call[1].inlineSettings.showTrayIcon).toBe(false);
  });

  it('hydrates the tray-icon toggle from an existing link storing showTrayIcon:false', () => {
    render(
      <HelperTab
        {...baseProps}
        existingLink={{
          ...helperLink(true),
          inlineSettings: { enabled: true, showTrayIcon: false },
        }}
      />,
    );
    expect((screen.getByTestId('helper-show-tray-icon') as HTMLInputElement).checked).toBe(false);
    // Menu-item toggles stay editable so re-showing the icon keeps the config.
    expect(
      (screen.getByTestId('helper-show-tray-icon') as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it('renders the lifecycle-mode select defaulting to auto', () => {
    render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
    const select = screen.getByTestId('helper-lifecycle-mode') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe('auto');
  });

  it('includes lifecycleMode in the saved inlineSettings when set to on-demand', async () => {
    saveMock.mockClear();
    render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
    fireEvent.change(screen.getByTestId('helper-lifecycle-mode'), {
      target: { value: 'on-demand' },
    });
    fireEvent.click(screen.getByText('Save'));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    const call = saveMock.mock.calls[0] as unknown as [
      unknown,
      { inlineSettings: Record<string, unknown> },
    ];
    expect(call[1].inlineSettings.lifecycleMode).toBe('on-demand');
  });

  it('omits lifecycleMode from the saved inlineSettings when left on auto', async () => {
    saveMock.mockClear();
    render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
    fireEvent.click(screen.getByText('Save'));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    const call = saveMock.mock.calls[0] as unknown as [
      unknown,
      { inlineSettings: Record<string, unknown> },
    ];
    expect('lifecycleMode' in call[1].inlineSettings).toBe(false);
  });
});
