import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fetchWithAuth } from '../../stores/auth';
import OrgAutopayCard from './OrgAutopayCard';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
it('requires an override when billing contact is absent and sends it only for this request', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, init) => Response.json(init?.method
    ? { requested: ['11111111-1111-4111-8111-111111111111'], skipped: [] }
    : { orgId: '11111111-1111-4111-8111-111111111111', orgName: 'Example client', billingContact: null,
        status: 'not_requested', enrollment: null, method: null, stripeReadiness:{ready:true,missing:[]} }));
  render(<OrgAutopayCard orgId="11111111-1111-4111-8111-111111111111" />);
  expect(await screen.findByTestId('autopay-request')).toBeDisabled();
  fireEvent.change(screen.getByTestId('autopay-recipient'), { target: { value: 'billing@example.com' } });
  fireEvent.click(screen.getByTestId('autopay-request'));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true));
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, i]) => i?.method === 'POST')!;
  expect(JSON.parse(call[1]!.body as string).recipientOverride).toBe('billing@example.com');
});

it('disables enrollment and names missing Stripe permissions even with a valid recipient',async()=>{
  vi.mocked(fetchWithAuth).mockResolvedValue(Response.json({
    orgId:'11111111-1111-4111-8111-111111111111',orgName:'Example client',
    billingContact:{email:'billing@example.test'},status:'not_requested',enrollment:null,method:null,
    stripeReadiness:{ready:false,missing:['setup_intents_write','mandates_read']},
  }));
  render(<OrgAutopayCard orgId="11111111-1111-4111-8111-111111111111"/>);
  expect(await screen.findByTestId('autopay-request')).toBeDisabled();
  expect(screen.getByTestId('autopay-stripe-not-ready')).toHaveTextContent('setup_intents_write');
  expect(screen.getByTestId('autopay-stripe-not-ready')).toHaveTextContent('mandates_read');
});

it('uses the stored paused status when needs attention is projected over enrollment', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async () => Response.json({
    orgId: '11111111-1111-4111-8111-111111111111', orgName: 'Example client',
    billingContact: { email: 'billing@example.test' }, status: 'needs_attention',
    enrollment: { status: 'paused', generation: 1, effectiveFrom: null, needsAttentionReason: 'method_unavailable' },
    method: null, stripeReadiness: { ready: true, missing: [] },
  }));
  render(<OrgAutopayCard orgId="11111111-1111-4111-8111-111111111111" />);
  expect(await screen.findByTestId('autopay-resume')).toBeEnabled();
  expect(screen.queryByTestId('autopay-request')).toBeNull();
});
