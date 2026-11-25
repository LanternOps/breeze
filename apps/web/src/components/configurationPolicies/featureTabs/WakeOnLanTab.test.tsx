import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

const m = vi.hoisted(() => ({
  save: vi.fn(async () => ({ id: 'link-1' })),
  remove: vi.fn(async () => true),
}));

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: m.save,
    remove: m.remove,
    saving: false,
    error: undefined,
    clearError: vi.fn(),
  }),
}));
vi.mock('./WakeStatusPanel', () => ({
  default: ({ policyId }: { policyId: string }) => (
    <div data-testid="wake-status-panel-stub">
      {policyId}
      <button type="button" data-testid="wake-stub-page">Next</button>
    </div>
  ),
}));

import WakeOnLanTab from './WakeOnLanTab';
import { FeatureDirtyReporterContext, FeatureReadOnlyContext } from './featureEditing';
import type { FeatureLink, FeatureTabProps } from './types';

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

const link = (inlineSettings: Record<string, unknown>): FeatureLink => ({
  id: 'link-1', featureType: 'wake_on_lan', featurePolicyId: null, inlineSettings,
});

function clickSave() {
  const button = screen.getAllByRole('button').find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
  fireEvent.click(button);
}

describe('WakeOnLanTab', () => {
  beforeEach(() => {
    m.save.mockClear();
  });

  it('defaults to Always and renders no configure toggle', () => {
    render(<WakeOnLanTab {...baseProps} />);
    expect((screen.getByTestId('wake-button-mode-always') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('wake-button-mode-verified') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByTestId('wake-configure-settings-toggle')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('saves { configureSettings: false, buttonMode } for the default', () => {
    render(<WakeOnLanTab {...baseProps} />);
    clickSave();
    expect(m.save).toHaveBeenCalledWith(null, {
      featureType: 'wake_on_lan',
      featurePolicyId: null,
      inlineSettings: { configureSettings: false, buttonMode: 'always' },
    });
  });

  it('saves verified after choosing it, updating the existing link', () => {
    render(<WakeOnLanTab {...baseProps} existingLink={link({ configureSettings: false, buttonMode: 'always' })} />);
    fireEvent.click(screen.getByTestId('wake-button-mode-verified'));
    clickSave();
    expect(m.save).toHaveBeenCalledWith('link-1', expect.objectContaining({
      inlineSettings: { configureSettings: false, buttonMode: 'verified' },
    }));
  });

  it('seeds from a stored link and never echoes unknown keys', () => {
    render(<WakeOnLanTab {...baseProps} existingLink={link({ configureSettings: true, buttonMode: 'verified', extra: 1 })} />);
    expect((screen.getByTestId('wake-button-mode-verified') as HTMLInputElement).checked).toBe(true);
    clickSave();
    expect(m.save).toHaveBeenCalledWith('link-1', expect.objectContaining({
      inlineSettings: { configureSettings: false, buttonMode: 'verified' },
    }));
  });

  it('warns that the button stays hidden until proven only while verified is selected', () => {
    render(<WakeOnLanTab {...baseProps} />);
    expect(screen.queryByTestId('wake-verified-warning')).toBeNull();
    fireEvent.click(screen.getByTestId('wake-button-mode-verified'));
    const warning = screen.getByTestId('wake-verified-warning');
    expect(warning.getAttribute('role')).toBe('note');
    expect(warning.textContent).toMatch(/hidden/i);
    expect(warning.textContent).toMatch(/proven/i);
    expect(warning.textContent).toMatch(/ready/i);
    fireEvent.click(screen.getByTestId('wake-button-mode-always'));
    expect(screen.queryByTestId('wake-verified-warning')).toBeNull();
  });

  it('shows the verified warning for a stored verified link', () => {
    render(<WakeOnLanTab {...baseProps} existingLink={link({ configureSettings: false, buttonMode: 'verified' })} />);
    expect(screen.getByTestId('wake-verified-warning')).toBeTruthy();
  });

  it('shows the status panel only once the policy has a saved link', () => {
    const { rerender } = render(<WakeOnLanTab {...baseProps} />);
    expect(screen.queryByTestId('wake-status-panel-stub')).toBeNull();
    rerender(<WakeOnLanTab {...baseProps} existingLink={link({ configureSettings: false, buttonMode: 'always' })} />);
    expect(screen.getByTestId('wake-status-panel-stub').textContent).toContain('policy-1');
  });

  const saved = link({ configureSettings: false, buttonMode: 'always' });

  it('paging the wake status list does not mark the feature dirty (#12469)', () => {
    const reporter = vi.fn();
    render(
      <FeatureDirtyReporterContext.Provider value={reporter}>
        <WakeOnLanTab {...baseProps} existingLink={saved} />
      </FeatureDirtyReporterContext.Provider>,
    );
    fireEvent.click(screen.getByTestId('wake-stub-page'));
    expect(reporter).not.toHaveBeenCalledWith(true);
    // A real edit still reports dirty.
    fireEvent.click(screen.getByTestId('wake-button-mode-verified'));
    expect(reporter).toHaveBeenCalledWith(true);
  });

  it('a read-only viewer can use the wake status list (#12469)', () => {
    render(
      <FeatureReadOnlyContext.Provider value>
        <WakeOnLanTab {...baseProps} existingLink={saved} />
      </FeatureReadOnlyContext.Provider>,
    );
    const panel = screen.getByTestId('wake-status-panel-stub');
    expect(panel.closest('fieldset[disabled]')).toBeNull();
    expect((screen.getByTestId('wake-stub-page') as HTMLButtonElement).matches(':disabled')).toBe(false);
  });
});
