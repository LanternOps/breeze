import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Partner fetch drives the AI-for-Office nav gate at runtime.
const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  useAuthStore: Object.assign(
    (selector: (s: { user: { isPlatformAdmin: boolean } }) => unknown) =>
      selector({ user: { isPlatformAdmin: false } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../../stores/uiStore', () => ({
  useUiStore: () => ({ isMobileMenuOpen: false, closeMobileMenu: vi.fn() }),
}));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'partner' }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar from './Sidebar';

function mockPartner(aiForOfficeEnabled: boolean) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url === '/orgs/partners/me') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ name: 'Acme MSP', aiForOfficeEnabled, settings: {} }),
      } as Response);
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
  });
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  localStorage.clear();
  localStorage.setItem('sidebar-mode', 'open');
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
    dispatchEvent: vi.fn(), onchange: null,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => vi.clearAllMocks());

describe('Sidebar — AI for Office per-partner gate', () => {
  it('shows the AI for Office nav item when the partner is enabled', async () => {
    mockPartner(true);
    const { container } = render(<Sidebar currentPath="/ai-for-office" />);
    await waitFor(() =>
      expect(container.querySelector('a[href="/ai-for-office"]')).not.toBeNull(),
    );
  });

  it('hides the AI for Office nav item when the partner is not enabled', async () => {
    mockPartner(false);
    const { container } = render(<Sidebar currentPath="/ai-for-office" />);
    await waitFor(() => expect(container.querySelector('a[href="/fleet"]')).not.toBeNull());
    expect(container.querySelector('a[href="/ai-for-office"]')).toBeNull();
  });
});
