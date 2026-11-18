import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import BuyCreditsLink, { BUY_CREDITS_HREF } from './BuyCreditsLink';
import { useFeaturesStore } from '@/stores/featuresStore';

const setBilling = (billing: boolean, loaded = true) =>
  useFeaturesStore.setState({ features: { ...useFeaturesStore.getState().features, billing }, loaded });

describe('BuyCreditsLink', () => {
  beforeEach(() => setBilling(false));

  it('points at the billing sidecar credits page', () => {
    expect(BUY_CREDITS_HREF).toBe('/billing/credits');
  });

  it('renders the link when hosted billing is configured', () => {
    setBilling(true);
    render(<BuyCreditsLink />);
    expect(screen.getByRole('link', { name: 'Buy credits' })).toHaveAttribute('href', '/billing/credits');
  });

  it('renders nothing on a self-hosted deployment', () => {
    setBilling(false);
    const { container } = render(<BuyCreditsLink />);
    expect(container).toBeEmptyDOMElement();
  });
});
