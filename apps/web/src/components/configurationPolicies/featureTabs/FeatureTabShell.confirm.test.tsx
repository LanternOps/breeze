import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import FeatureTabShell from './FeatureTabShell';
import { i18n } from '../../../lib/i18n';

// #5314: "Revert to Parent" and "Remove" both fire an irreversible
// DELETE …/features/:id that destroys the org's override. Both were one-click.
// The shell owns the footer for EVERY feature tab, so the guard lives here once.
describe('FeatureTabShell destructive-action confirmation (#5314)', () => {
  const baseProps = {
    title: 'OneDrive Helper',
    description: 'Auto-mount SharePoint libraries.',
    icon: <span data-testid="icon" />,
    children: <div data-testid="body" />,
    saving: false,
    onSave: vi.fn(),
  };

  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('does not revert on the first click — it asks first', () => {
    const onRevert = vi.fn();
    render(<FeatureTabShell {...baseProps} isConfigured onRevert={onRevert} />);

    fireEvent.click(screen.getByRole('button', { name: /Revert to Parent/i }));

    expect(onRevert).not.toHaveBeenCalled();
    expect(screen.getByTestId('feature-tab-revert-confirm')).toBeInTheDocument();
  });

  it('reverts once the confirmation is accepted', () => {
    const onRevert = vi.fn();
    render(<FeatureTabShell {...baseProps} isConfigured onRevert={onRevert} />);

    fireEvent.click(screen.getByRole('button', { name: /Revert to Parent/i }));
    fireEvent.click(screen.getByTestId('feature-tab-revert-confirm'));

    expect(onRevert).toHaveBeenCalledTimes(1);
  });

  it('does not revert when the confirmation is cancelled', () => {
    const onRevert = vi.fn();
    render(<FeatureTabShell {...baseProps} isConfigured onRevert={onRevert} />);

    fireEvent.click(screen.getByRole('button', { name: /Revert to Parent/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

    expect(onRevert).not.toHaveBeenCalled();
    expect(screen.queryByTestId('feature-tab-revert-confirm')).not.toBeInTheDocument();
  });

  it('does not remove on the first click — it asks first', () => {
    const onRemove = vi.fn();
    render(<FeatureTabShell {...baseProps} isConfigured onRemove={onRemove} />);

    fireEvent.click(screen.getByRole('button', { name: /^Remove$/i }));

    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByTestId('feature-tab-remove-confirm')).toBeInTheDocument();
  });

  it('removes once the confirmation is accepted', () => {
    const onRemove = vi.fn();
    render(<FeatureTabShell {...baseProps} isConfigured onRemove={onRemove} />);

    fireEvent.click(screen.getByRole('button', { name: /^Remove$/i }));
    fireEvent.click(screen.getByTestId('feature-tab-remove-confirm'));

    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
