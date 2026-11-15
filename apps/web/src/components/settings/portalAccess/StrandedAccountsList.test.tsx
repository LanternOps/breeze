import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { StrandedAccountsList } from './StrandedAccountsList';

const fetchWithAuthMock = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

const ORG = '11111111-1111-4111-8111-111111111111';

function mockStranded() {
  fetchWithAuthMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
    data: { items: [{ portalUserId: 'u1', email: 'pat@acme.example.com', name: 'Pat Doe', status: 'active' }], total: 1 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
}

describe('StrandedAccountsList (W7 #11384 provider-conditional copy)', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    mockStranded();
  });

  it('ships dark: Microsoft only (the default) keeps the Microsoft copy and never says Google', async () => {
    render(<StrandedAccountsList orgId={ORG} />);
    const list = await screen.findByTestId('portal-access-stranded');
    expect(within(list).getByTestId('portal-access-stranded-invite-u1')).toHaveTextContent('Send Microsoft sign-in invite');
    expect(list).toHaveTextContent('These accounts have no Microsoft connection');
    expect(list.textContent ?? '').not.toMatch(/google/i);
  });

  it('both effective: "Microsoft or Google" and a provider-neutral invite button', async () => {
    render(<StrandedAccountsList orgId={ORG} providers="both" />);
    const list = await screen.findByTestId('portal-access-stranded');
    expect(list).toHaveTextContent('These accounts have no Microsoft or Google connection');
    expect(within(list).getByTestId('portal-access-stranded-invite-u1')).toHaveTextContent(/^Send sign-in invite$/);
  });

  it('only Google effective: Google copy, no Microsoft', async () => {
    render(<StrandedAccountsList orgId={ORG} providers="google" />);
    const list = await screen.findByTestId('portal-access-stranded');
    expect(within(list).getByTestId('portal-access-stranded-invite-u1')).toHaveTextContent('Send Google sign-in invite');
    expect(list.textContent ?? '').not.toMatch(/microsoft/i);
  });
});
