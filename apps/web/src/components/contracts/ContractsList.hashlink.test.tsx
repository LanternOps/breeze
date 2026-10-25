import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installAstroClientRouterStandIn } from '../../__tests__/astroClientRouterStandIn';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));

const listContracts = vi.fn();
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...orig, listContracts: (...a: unknown[]) => listContracts(...a) };
});

import { ContractsList } from './ContractsList';

const json = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

async function expectHashLinkClick(testId: string, expected: string) {
  const router = installAstroClientRouterStandIn();
  window.location.hash = '';
  try {
    const changed = new Promise<void>((resolve) => {
      window.addEventListener('hashchange', (e) => {
        if ((e as HashChangeEvent).newURL.endsWith(expected)) resolve();
      });
    });
    await userEvent.click(screen.getByTestId(testId));
    expect(window.location.hash).toBe(expected);
    await expect(changed).resolves.toBeUndefined();
  } finally {
    router.uninstall();
    window.location.hash = '';
  }
}

describe('ContractsList currency-mismatch banner link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listContracts.mockResolvedValue(json({ data: [] }));
    fetchWithAuth.mockImplementation(async (url: string) =>
      String(url).includes('/contracts/currency-mismatches')
        ? json({ data: { items: [{ id: 'c1' }] } })
        : json({ data: [] }));
  });

  it('click sets #tab=currency-mismatches and fires hashchange under the Astro router', async () => {
    render(<ContractsList />);
    await screen.findByTestId('contracts-currency-mismatch-open');
    await expectHashLinkClick('contracts-currency-mismatch-open', '#tab=currency-mismatches');
  });
});
