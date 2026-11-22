import '@/lib/i18n';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReinstalledBadge from './ReinstalledBadge';

describe('ReinstalledBadge (#8318)', () => {
  it('renders nothing for a record never reattached', () => {
    const { container } = render(<ReinstalledBadge lastReattachedAt={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an unparseable timestamp', () => {
    const { container } = render(<ReinstalledBadge lastReattachedAt="not-a-date" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says when the record took over the reinstalled machine', () => {
    render(<ReinstalledBadge lastReattachedAt="2026-11-10T12:00:00.000Z" />);
    const badge = screen.getByTestId('device-reinstalled-badge');
    expect(badge.textContent).toMatch(/^Reinstalled on /);
    expect(badge.textContent).toMatch(/2026/);
    expect(badge.getAttribute('title')).toMatch(/rebuilt its inventory/);
  });
});
