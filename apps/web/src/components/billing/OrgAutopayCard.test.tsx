import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const orgA = '11111111-1111-4111-8111-111111111111';
const orgB = '22222222-2222-4222-8222-222222222222';
beforeEach(() => vi.clearAllMocks());

function row(orgId: string, status = 'active') {
  return { orgId, orgName: 'Example client', billingContact: { email: 'billing@example.test' },
    status, enrollment: { status, generation: 1, effectiveFrom: null, needsAttentionReason: null },
    method: null, stripeReadiness: { ready: true, missing: [] } };
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

it('ignores an obsolete organization read when A completes after B', async () => {
  const a = deferred();
  const b = deferred();
  vi.mocked(fetchWithAuth).mockImplementation(url => url === `/orgs/${orgA}/autopay` ? a.promise : b.promise);
  const view = render(<OrgAutopayCard orgId={orgA} />);
  view.rerender(<OrgAutopayCard orgId={orgB} />);
  await act(async () => { b.resolve(Response.json(row(orgB, 'paused'))); });
  expect(screen.getByTestId('autopay-resume')).toBeEnabled();
  await act(async () => { a.resolve(Response.json(row(orgA))); });
  expect(screen.getByTestId('autopay-resume')).toBeEnabled();
  expect(screen.queryByTestId('autopay-pause')).toBeNull();
});

it('clears confirmation and result when changing organizations', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async url => Response.json(row(
    url === `/orgs/${orgA}/autopay` ? orgA : orgB)));
  const view = render(<OrgAutopayCard orgId={orgA} />);
  fireEvent.click(await screen.findByTestId('autopay-pause'));
  await screen.findByTestId('autopay-org-result');
  await waitFor(() => expect(screen.getByTestId('autopay-turn-off')).toBeEnabled());
  fireEvent.click(screen.getByTestId('autopay-turn-off'));
  expect(screen.getByTestId('autopay-off-confirm')).toBeInTheDocument();
  view.rerender(<OrgAutopayCard orgId={orgB} />);
  await screen.findByTestId('autopay-pause');
  expect(screen.queryByTestId('autopay-off-confirm')).toBeNull();
  expect(screen.queryByTestId('autopay-org-result')).toBeNull();
});

it('does not refresh or publish results from an action completed after navigation', async () => {
  const mutation = deferred();
  vi.mocked(fetchWithAuth).mockImplementation(async (url, init) => init?.method
    ? mutation.promise : Response.json(row(url === `/orgs/${orgA}/autopay` ? orgA : orgB,
      url === `/orgs/${orgA}/autopay` ? 'active' : 'paused')));
  const view = render(<OrgAutopayCard orgId={orgA} />);
  fireEvent.click(await screen.findByTestId('autopay-pause'));
  view.rerender(<OrgAutopayCard orgId={orgB} />);
  await screen.findByTestId('autopay-resume');
  await act(async () => { mutation.resolve(Response.json({ success: true })); });
  expect(screen.getByTestId('autopay-resume')).toBeEnabled();
  expect(screen.queryByTestId('autopay-org-result')).toBeNull();
  expect(vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
});

it.each([
  ['pause', 'active', 'paused'],
  ['resume', 'paused', 'active'],
  ['turn_off', 'active', 'cancelled'],
])('submits %s to the displayed organization and refreshes its status', async (action, initial, next) => {
  let status = initial;
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, init) => {
    if (init?.method) { status = next; return Response.json({ success: true }); }
    return Response.json(row(orgA, status));
  });
  render(<OrgAutopayCard orgId={orgA} />);
  if (action === 'turn_off') {
    fireEvent.click(await screen.findByTestId('autopay-turn-off'));
    expect(vi.mocked(fetchWithAuth).mock.calls.every(([, init]) => !init?.method)).toBe(true);
    fireEvent.click(screen.getByTestId('autopay-off-confirm-submit'));
  } else {
    fireEvent.click(await screen.findByTestId(`autopay-${action}`));
  }
  await screen.findByTestId('autopay-org-result');
  await waitFor(() => expect(screen.getByTestId('autopay-status')).toHaveTextContent(
    next === 'cancelled' ? 'Off' : next === 'active' ? 'Active' : 'Paused'));
  const mutations = vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method);
  expect(mutations).toHaveLength(1);
  expect(mutations[0][0]).toBe(`/orgs/${orgA}/autopay`);
  expect(mutations[0][1]?.method).toBe('PATCH');
  expect(JSON.parse(mutations[0][1]!.body as string)).toEqual({ action });
  expect(screen.queryByTestId('autopay-off-confirm')).toBeNull();
});
