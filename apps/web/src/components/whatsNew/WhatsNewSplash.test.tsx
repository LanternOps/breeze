import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WhatsNewSplash from './WhatsNewSplash';
import { LAST_SEEN_KEY } from '../../lib/whatsNewState';

// t returns key + interpolated version so assertions are stable without real i18n.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts?.version ? `${k}:${opts.version}` : k,
  }),
}));

// Force a known decision by stubbing the running version and entries indirectly:
// seed localStorage floor below the bundled entry so the newest entry shows.
vi.mock('../../lib/version', () => ({ WEB_VERSION: '99.0.0' }));

beforeEach(() => {
  window.localStorage.clear();
  // floor below any real entry so decideWhatsNew returns the newest bundled entry
  window.localStorage.setItem(LAST_SEEN_KEY, '0.0.1');
});

describe('WhatsNewSplash', () => {
  it('renders the newest entry title + highlights', async () => {
    render(<WhatsNewSplash />);
    // The decision runs in a useEffect, so wait for the post-mount render.
    expect(await screen.findByText(/whatsNew\.title:/)).toBeInTheDocument();
    // at least one highlight bullet is present
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it('"Got it" writes lastSeen and closes', async () => {
    render(<WhatsNewSplash />);
    const gotIt = await screen.findByText('whatsNew.gotIt');
    fireEvent.click(gotIt);
    expect(window.localStorage.getItem(LAST_SEEN_KEY)).not.toBe('0.0.1');
    await waitFor(() => {
      expect(screen.queryByText('whatsNew.gotIt')).not.toBeInTheDocument();
    });
  });

  it('"Show me later" closes without writing', async () => {
    render(<WhatsNewSplash />);
    const later = await screen.findByText('whatsNew.later');
    fireEvent.click(later);
    expect(window.localStorage.getItem(LAST_SEEN_KEY)).toBe('0.0.1');
    await waitFor(() => {
      expect(screen.queryByText('whatsNew.later')).not.toBeInTheDocument();
    });
  });

  // #3646: with no stored floor (existing user upgrading from a pre-feature
  // build) the newest shipped entry must still auto-show rather than be
  // silently baselined away.
  it('shows the newest entry when no floor is stored', async () => {
    window.localStorage.clear();
    render(<WhatsNewSplash />);
    expect(await screen.findByText(/whatsNew\.title:/)).toBeInTheDocument();
    // Nothing is written until the user acknowledges it.
    expect(window.localStorage.getItem(LAST_SEEN_KEY)).toBeNull();
  });

  it('renders nothing once the newest entry has been acknowledged', async () => {
    window.localStorage.setItem(LAST_SEEN_KEY, '99.0.0');
    const { container } = render(<WhatsNewSplash />);
    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
