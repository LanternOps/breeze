// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { PublicQuoteView } from './PublicQuoteView';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('PublicQuoteView — replaced proposal', () => {
  it('renders a branded notice naming the partner, not a broken-link error', () => {
    render(<PublicQuoteView token="t" initial={null} superseded={{ partnerName: 'Acme MSP' }} />);

    const notice = screen.getByTestId('public-quote-superseded');
    expect(notice.textContent).toContain('replaced by an updated version');
    expect(notice.textContent).toContain('Acme MSP');
    // Telling the customer their link is "invalid or expired" would send them
    // back to the MSP for a fix that is already sitting in their inbox.
    expect(screen.queryByTestId('public-quote-error')).toBeNull();
  });

  it('still reads sensibly when the partner name is missing', () => {
    render(<PublicQuoteView token="t" initial={null} superseded={{}} />);

    const notice = screen.getByTestId('public-quote-superseded');
    expect(notice.textContent).toContain('replaced by an updated version');
    expect(notice.textContent).not.toContain('or contact');
  });

  it('shows no pricing, no actions, and no link to the replacement', () => {
    const { container } = render(
      <PublicQuoteView token="t" initial={null} superseded={{ partnerName: 'Acme MSP' }} />,
    );

    // The withdrawn prices must not leak, the customer must not be able to act
    // on a retired proposal, and the successor is reached through the newer
    // email — its id is not ours to hand out on a dead link.
    expect(screen.queryByTestId('public-quote-accept')).toBeNull();
    expect(screen.queryByTestId('public-quote-decline')).toBeNull();
    expect(container.textContent).not.toMatch(/\$\s?\d/);
    expect(container.querySelector('a[href*="/quote/"]')).toBeNull();
  });

  it('takes precedence over the generic invalid-link fallback', () => {
    render(<PublicQuoteView token="t" initial={null} error="This link is invalid or has expired" superseded={{ partnerName: 'Acme MSP' }} />);

    expect(screen.getByTestId('public-quote-superseded')).not.toBeNull();
    expect(screen.queryByTestId('public-quote-error')).toBeNull();
  });

  it('leaves the ordinary invalid-link path alone when nothing was superseded', () => {
    render(<PublicQuoteView token="t" initial={null} error="This link is invalid or has expired" />);

    expect(screen.getByTestId('public-quote-error')).not.toBeNull();
    expect(screen.queryByTestId('public-quote-superseded')).toBeNull();
  });
});
