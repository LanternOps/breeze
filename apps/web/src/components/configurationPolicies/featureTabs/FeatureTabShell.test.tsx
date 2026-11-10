import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeatureTabShell from './FeatureTabShell';
import { i18n } from '../../../lib/i18n';

// FeatureTabShell renders the footer controls for EVERY configuration-policy
// feature tab, so the disabled-state rules below apply fleet-wide, not just to
// the tab that surfaced the bug (#2336, OneDrive Helper).
describe('FeatureTabShell footer controls', () => {
  const baseProps = {
    title: 'OneDrive Helper',
    description: 'Auto-mount SharePoint libraries.',
    icon: <span data-testid="icon" />,
    isConfigured: false,
    children: <div data-testid="body" />,
  };

  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  const overrideButton = () => screen.getByRole('button', { name: /Override/i });

  it('disables Override while a save is in flight (#2336)', () => {
    // Override POSTs a brand-new link (persist(null)). Only Save was gated on
    // `saving`, so a double-click during the round-trip fired the create twice
    // — the second one landing on a policy that already had the link.
    const onOverride = vi.fn();
    render(
      <FeatureTabShell
        {...baseProps}
        saving
        isInherited
        onOverride={onOverride}
        onSave={vi.fn()}
      />,
    );

    expect(overrideButton()).toBeDisabled();
    fireEvent.click(overrideButton());
    expect(onOverride).not.toHaveBeenCalled();
  });

  it('still disables Override on client-side validation failure while idle', () => {
    render(
      <FeatureTabShell
        {...baseProps}
        saving={false}
        saveDisabled
        isInherited
        onOverride={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(overrideButton()).toBeDisabled();
  });

  it('enables Override when idle and valid', () => {
    const onOverride = vi.fn();
    render(
      <FeatureTabShell
        {...baseProps}
        saving={false}
        isInherited
        onOverride={onOverride}
        onSave={vi.fn()}
      />,
    );

    expect(overrideButton()).toBeEnabled();
    fireEvent.click(overrideButton());
    expect(onOverride).toHaveBeenCalledTimes(1);
  });

  describe('blocked save feedback (#11554)', () => {
    let scrollSpy: ReturnType<typeof vi.fn>;
    const originalScroll = Element.prototype.scrollIntoView;
    beforeEach(() => {
      scrollSpy = vi.fn();
      Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView;
    });
    afterEach(() => {
      Element.prototype.scrollIntoView = originalScroll;
    });

    it('focuses the first invalid field, scrolls to it, and says why next to Save', async () => {
      render(
        <FeatureTabShell {...baseProps} saving={false} onSave={vi.fn()}>
          <div>
            <input data-testid="bad-input" />
            <p data-field-error="">Add at least one backup path</p>
          </div>
        </FeatureTabShell>,
      );

      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

      await waitFor(() => expect(screen.getByTestId('bad-input')).toHaveFocus());
      expect(scrollSpy).toHaveBeenCalled();
      expect(screen.getByTestId('save-blocked-hint')).toBeInTheDocument();
    });

    it('falls back to the error banner and shows the message next to Save', async () => {
      render(
        <FeatureTabShell
          {...baseProps}
          saving={false}
          error="Please select a backup configuration"
          onSave={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

      const hint = await screen.findByTestId('save-blocked-hint');
      expect(hint).toHaveTextContent('Please select a backup configuration');
      await waitFor(() => expect(screen.getByTestId('feature-tab-error')).toHaveFocus());
    });

    it('reveals a failure from a void-returning onSave once saving settles, and drops the hint when the error clears', async () => {
      const props = { ...baseProps, onSave: () => undefined };
      const { rerender } = render(<FeatureTabShell {...props} saving={false} />);
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
      rerender(<FeatureTabShell {...props} saving />);
      rerender(<FeatureTabShell {...props} saving={false} error="Server said no" />);

      expect(await screen.findByTestId('save-blocked-hint')).toHaveTextContent('Server said no');
      await waitFor(() => expect(screen.getByTestId('feature-tab-error')).toHaveFocus());

      // error cleared (e.g. user fixed it / later save succeeded) -> hint goes away
      rerender(<FeatureTabShell {...props} saving={false} />);
      await waitFor(() => expect(screen.queryByTestId('save-blocked-hint')).toBeNull());
    });

    it('is not mute when onSave rejects', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      render(
        <FeatureTabShell
          {...baseProps}
          saving={false}
          onSave={() => Promise.reject(new Error('boom'))}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
      expect(await screen.findByTestId('save-blocked-hint')).toHaveTextContent('boom');
      spy.mockRestore();
    });

    it('shows no hint when the save left nothing wrong', async () => {
      const onSave = vi.fn();
      render(<FeatureTabShell {...baseProps} saving={false} onSave={onSave} />);
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByTestId('save-blocked-hint')).toBeNull();
    });
  });
});
