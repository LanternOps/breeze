import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PasswordFallbackNotice } from './PasswordFallbackNotice';
import type { PortalPasswordFallbackNotice } from './types';
import { installAstroClientRouterStandIn } from '../../../__tests__/astroClientRouterStandIn';

const fetchWithAuthMock = vi.fn();
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a),
}));
const navigateToMock = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateToMock(...a) }));
const showToastMock = vi.fn();
vi.mock('../../shared/Toast', () => ({
  showToast: (...a: unknown[]) => showToastMock(...a),
}));

const ORG = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const DISMISS = `/orgs/organizations/${ORG}/portal-entra-tenant/password-fallback/dismiss`;
const NOTICE: PortalPasswordFallbackNotice = { since: '2026-11-08T10:00:00.000Z', tenantId: TENANT, cause: 'tenant_removed' };

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

function renderNotice(notice: PortalPasswordFallbackNotice = NOTICE, rerun: { hash: string } | { onClick: () => void } = { hash: 'portal' }) {
  const onDismissed = vi.fn();
  render(<PasswordFallbackNotice orgId={ORG} notice={notice} rerun={rerun} onDismissed={onDismissed} testIdPrefix="pf" />);
  return { onDismissed };
}

describe('PasswordFallbackNotice (#11582)', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    navigateToMock.mockReset();
    showToastMock.mockReset();
  });

  it('says sign-in fell back to password, why, and links to re-run the proof', () => {
    renderNotice();
    const notice = screen.getByTestId('pf-password-fallback');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent(/fell back to password/i);
    expect(screen.getByTestId('pf-password-fallback-cause')).toHaveTextContent(/tenant link was removed/i);
    expect(screen.getByTestId('pf-password-fallback-cause')).toHaveTextContent(TENANT);
    expect(screen.getByTestId('pf-password-fallback-rerun')).toHaveAttribute('href', '#portal');
  });

  it.each([
    ['ai_for_office_mapping_removed', /AI for Office tenant mapping.*was removed/i],
    ['ai_for_office_mapping_changed', /changed to another tenant/i],
    ['tenant_displaced', /another organization proved/i],
    [null, /proof was lost/i],
  ] as const)('cause %s has its own sentence', (cause, text) => {
    renderNotice({ ...NOTICE, cause });
    expect(screen.getByTestId('pf-password-fallback-cause')).toHaveTextContent(text);
  });

  it('the re-run link fires hashchange under the Astro router (a bare #anchor would not switch tabs)', async () => {
    const router = installAstroClientRouterStandIn();
    window.location.hash = '#domains';
    try {
      renderNotice();
      const changed = new Promise<string>((resolve) => {
        window.addEventListener('hashchange', (e) => {
          if ((e as HashChangeEvent).newURL.endsWith('#portal')) resolve('ok');
        });
      });
      fireEvent.click(screen.getByTestId('pf-password-fallback-rerun'));
      expect(window.location.hash).toBe('#portal');
      await expect(changed).resolves.toBe('ok');
      expect(router.intercepted).toHaveLength(0);
    } finally {
      router.uninstall();
      window.location.hash = '';
    }
  });

  it('a re-run action can be a button (the Sign-in card focuses its own proof controls)', () => {
    const onClick = vi.fn();
    const onDismissed = vi.fn();
    render(<PasswordFallbackNotice orgId={ORG} notice={NOTICE} rerun={{ onClick }} onDismissed={onDismissed} testIdPrefix="pf" />);
    const rerun = screen.getByTestId('pf-password-fallback-rerun');
    expect(rerun.tagName).toBe('BUTTON');
    fireEvent.click(rerun);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('dismiss POSTs through runAction and reports back', async () => {
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) =>
      url === DISMISS && init?.method === 'POST' ? json({ data: { dismissed: true } }) : json({ error: 'unexpected' }, 500));
    const { onDismissed } = renderNotice();
    fireEvent.click(screen.getByTestId('pf-password-fallback-dismiss'));
    await waitFor(() => expect(onDismissed).toHaveBeenCalledTimes(1));
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('a failed dismiss keeps the notice and toasts once', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ error: 'boom' }, 500));
    const { onDismissed } = renderNotice();
    fireEvent.click(screen.getByTestId('pf-password-fallback-dismiss'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(onDismissed).not.toHaveBeenCalled();
    expect(screen.getByTestId('pf-password-fallback-dismiss')).not.toBeDisabled();
  });
});
