// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const verifyAccess = vi.hoisted(() => vi.fn());
vi.mock('@/lib/trustAccessApi', () => ({ verifyAccess }));
import AccessVerifyView from './AccessVerifyView';

beforeEach(() => {
  verifyAccess.mockReset();
  window.history.replaceState(null, '', '/trust/access/verify#tok123');
});

describe('AccessVerifyView', () => {
  it('clears the fragment before any request and does not POST on mount', () => {
    const spy = vi.spyOn(window.history, 'replaceState');
    render(<AccessVerifyView />);
    expect(spy).toHaveBeenCalledWith(null, '', '/trust/access/verify');
    expect(window.location.hash).toBe('');
    expect(verifyAccess).not.toHaveBeenCalled();
    expect(screen.getByTestId('trust-access-confirm')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('POSTs only on click, with the token; success shows the org', async () => {
    verifyAccess.mockImplementation(async () => {
      expect(window.location.hash).toBe('');
      return { orgName: 'Acme' };
    });
    render(<AccessVerifyView />);
    fireEvent.click(screen.getByTestId('trust-access-confirm'));
    await waitFor(() => expect(screen.getByTestId('trust-access-verified')).toHaveTextContent('Request confirmed. Acme will review it.'));
    expect(verifyAccess).toHaveBeenCalledTimes(1);
    expect(verifyAccess).toHaveBeenCalledWith('tok123');
  });

  it('failure shows invalid', async () => {
    verifyAccess.mockResolvedValue(null);
    render(<AccessVerifyView />);
    fireEvent.click(screen.getByTestId('trust-access-confirm'));
    await waitFor(() => expect(screen.getByTestId('trust-access-invalid')).toHaveTextContent('This link is invalid or has expired.'));
  });

  it('no token in the hash shows invalid and never requests', () => {
    window.history.replaceState(null, '', '/trust/access/verify');
    render(<AccessVerifyView />);
    expect(screen.getByTestId('trust-access-invalid')).toBeInTheDocument();
    expect(screen.queryByTestId('trust-access-confirm')).toBeNull();
    expect(verifyAccess).not.toHaveBeenCalled();
  });

  it('a transient failure (rate limit, outage) keeps Confirm so the requester can try again on this page', async () => {
    verifyAccess.mockResolvedValueOnce('retry').mockResolvedValueOnce({ orgName: 'Acme' });
    render(<AccessVerifyView />);
    fireEvent.click(screen.getByTestId('trust-access-confirm'));
    await waitFor(() => expect(screen.getByTestId('trust-access-retry')).toBeInTheDocument());
    expect(screen.queryByTestId('trust-access-invalid')).toBeNull();
    fireEvent.click(screen.getByTestId('trust-access-confirm'));
    await waitFor(() => expect(screen.getByTestId('trust-access-verified')).toBeInTheDocument());
    expect(verifyAccess).toHaveBeenNthCalledWith(2, 'tok123');
  });
});
