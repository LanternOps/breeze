import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FeatureLock } from './FeatureLock';

const WHY = 'Wisp triages your fleet continuously; available on Pro and above.';

describe('FeatureLock', () => {
  it('unlocked renders children only — no lock testid, no CTA', () => {
    render(
      <FeatureLock locked={false} why={WHY}>
        <span>Surface content</span>
      </FeatureLock>,
    );
    expect(screen.getByText('Surface content')).toBeInTheDocument();
    expect(screen.queryByTestId('feature-lock')).toBeNull();
    expect(screen.queryByTestId('feature-lock-cta')).toBeNull();
    expect(screen.queryByText(WHY)).toBeNull();
    expect(screen.getByText('Surface content').closest('fieldset')).toBeNull();
  });

  it('upgradeHref={null}: a lock with its reason and no upgrade link (nothing to buy, e.g. a server without the feature)', () => {
    render(
      <FeatureLock locked why={WHY} upgradeHref={null} testId="srv-lock">
        <span>Surface content</span>
      </FeatureLock>,
    );
    expect(screen.getByTestId('srv-lock')).toHaveAttribute('data-locked', 'true');
    expect(screen.getByTestId('srv-lock-why')).toHaveTextContent(WHY);
    expect(screen.queryByTestId('srv-lock-cta')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Surface content').closest('fieldset')).toBeDisabled();
  });

  it('locked keeps the surface visible but disabled', () => {
    render(
      <FeatureLock locked why={WHY}>
        <span>Surface content</span>
      </FeatureLock>,
    );
    const content = screen.getByText('Surface content');
    expect(content).toBeInTheDocument();
    const fieldset = content.closest('fieldset');
    expect(fieldset).not.toBeNull();
    expect(fieldset).toHaveAttribute('disabled');
    expect(fieldset).toHaveAttribute('aria-disabled', 'true');
    const wrapper = screen.getByTestId('feature-lock');
    expect(wrapper).toHaveAttribute('data-locked', 'true');
  });

  it('locked renders the why line and a CTA to /settings/plan by default', () => {
    render(
      <FeatureLock locked why={WHY}>
        <span>Surface content</span>
      </FeatureLock>,
    );
    expect(screen.getByTestId('feature-lock-why')).toHaveTextContent(WHY);
    const cta = screen.getByTestId('feature-lock-cta');
    expect(cta.tagName).toBe('A');
    expect(cta.getAttribute('href')).toBe('/settings/plan');
    expect(cta).toHaveTextContent('See plans');
  });

  it('upgradeHref overrides the CTA target', () => {
    render(
      <FeatureLock locked why={WHY} upgradeHref="/settings/billing" testId="wisp-lock">
        <span>Surface content</span>
      </FeatureLock>,
    );
    expect(screen.getByTestId('wisp-lock')).toHaveAttribute('data-locked', 'true');
    expect(screen.getByTestId('wisp-lock-why')).toHaveTextContent(WHY);
    expect(screen.getByTestId('wisp-lock-cta').getAttribute('href')).toBe('/settings/billing');
  });

  it('a button inside a locked surface cannot be clicked', () => {
    const onClick = vi.fn();
    render(
      <FeatureLock locked why={WHY}>
        <button type="button" onClick={onClick}>Enable Wisp</button>
      </FeatureLock>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Enable Wisp' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
