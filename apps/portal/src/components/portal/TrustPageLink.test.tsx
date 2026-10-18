// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { withBase } from '@/lib/basePath';
import { TrustPageLink } from './TrustPageLink';

describe('TrustPageLink', () => {
  it('renders nothing when the org has no published trust page', () => {
    const { container } = render(<TrustPageLink publicPath={null} />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('portal-dashboard-trust-link')).toBeNull();
  });

  it('links the published page under the portal base path', () => {
    render(<TrustPageLink publicPath="/trust/nw/acme" />);
    const link = screen.getByTestId('portal-dashboard-trust-link');
    expect(link.getAttribute('href')).toBe(withBase('/trust/nw/acme'));
    expect(link.textContent).toContain('Public trust page');
  });

  it('a partner-home path links the partner page', () => {
    render(<TrustPageLink publicPath="/trust/nw" />);
    expect(screen.getByTestId('portal-dashboard-trust-link').getAttribute('href')).toBe(withBase('/trust/nw'));
  });
});
