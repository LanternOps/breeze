import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));

vi.mock('../../stores/uiStore', () => ({
  useUiStore: vi.fn(() => ({ isMobileMenuOpen: false, closeMobileMenu: vi.fn() })),
}));

import { VersionSpan } from './Sidebar';

describe('VersionSpan', () => {
  it('renders muted with "unknown" tooltip when latest is null', () => {
    const { container } = render(<VersionSpan version="0.65.9" latest={null} component="Web" />);
    const span = container.querySelector('span')!;
    expect(span.textContent).toBe('0.65.9');
    expect(span.className).toBe('');
    expect(span.getAttribute('title')).toContain('latest version unknown');
  });

  it('renders green when running version equals latest', () => {
    const { container } = render(<VersionSpan version="0.65.9" latest="0.65.9" component="Web" />);
    const span = container.querySelector('span')!;
    expect(span.className).toContain('text-green');
    expect(span.getAttribute('title')).toContain('up to date');
  });

  it('renders green when running version is newer than latest (dev build)', () => {
    const { container } = render(<VersionSpan version="0.65.11-dev" latest="0.65.10" component="API" />);
    const span = container.querySelector('span')!;
    expect(span.className).toContain('text-green');
    expect(span.getAttribute('title')).toContain('up to date');
  });

  it('renders red with upgrade tooltip when running version is older than latest', () => {
    const { container } = render(<VersionSpan version="0.65.5" latest="0.65.10" component="API" />);
    const span = container.querySelector('span')!;
    expect(span.className).toContain('text-red');
    const title = span.getAttribute('title')!;
    expect(title).toContain('update available');
    expect(title).toContain('0.65.10');
    expect(title).toContain('API');
  });

  it('renders muted when version is unparseable', () => {
    const { container } = render(<VersionSpan version="not-a-version" latest="0.65.10" component="Web" />);
    const span = container.querySelector('span')!;
    expect(span.className).toBe('');
    expect(span.getAttribute('title')).toContain('latest version unknown');
  });
});
