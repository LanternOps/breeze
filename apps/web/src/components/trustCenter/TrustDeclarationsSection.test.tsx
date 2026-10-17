// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@/lib/i18n';
import { DECLARED_CONTROL_CATALOG } from '@breeze/shared';
const api = vi.hoisted(() => ({ getTrustDeclarations: vi.fn(), declareTrustControl: vi.fn(), withdrawTrustDeclaration: vi.fn() }));
vi.mock('@/lib/api/trustPageDeclarations', () => api);
const lib = vi.hoisted(() => ({ listOrgDocuments: vi.fn() }));
vi.mock('@/lib/api/orgDocuments', () => lib);
import TrustDeclarationsSection from './TrustDeclarationsSection';
import type { TrustPageState } from '@/lib/api/trustPage';

const DAY = 86_400_000;
const orgFetch = vi.fn() as never;
const iso = (ms: number) => new Date(ms).toISOString();
const decl = (over: Record<string, unknown> = {}) => ({
  id: 'd1', controlId: 'incident_response_plan', statement: 'We keep a tested incident response plan.',
  evidenceDocumentId: null, evidenceDocumentSha256: null, declaredByPartnerName: 'Northwind IT', declaredByUserId: 'u1',
  declaredAt: iso(Date.now() - 100 * DAY), expiresAt: iso(Date.now() + 200 * DAY),
  supersededAt: null, withdrawnAt: null, reminderSentAt: null, ...over,
});
const declState = (over: Record<string, unknown> = {}) => ({
  catalog: DECLARED_CONTROL_CATALOG, active: [], history: [], publishedDeclarationIds: [], publicationRevision: 7, partnerName: 'Northwind IT', ...over,
});
const state = { page: { publicationRevision: 7, publishedAt: '2026-10-01T00:00:00Z' } } as unknown as TrustPageState;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const mount = (props: Record<string, unknown> = {}) => {
  const onReload = vi.fn(async () => {});
  render(<TrustDeclarationsSection orgId="o1" orgFetch={orgFetch} state={state} canWrite onReload={onReload} {...props} />);
  return onReload;
};

describe('TrustDeclarationsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getTrustDeclarations.mockResolvedValue(declState());
    api.declareTrustControl.mockResolvedValue(json(201, { data: { publicationRevision: 8 } }));
    api.withdrawTrustDeclaration.mockResolvedValue(json(200, { data: { publicationRevision: 8 } }));
    lib.listOrgDocuments.mockResolvedValue([{ id: 'doc1', title: 'IR plan', category: 'policy', supersededByDocumentId: null }]);
  });

  it('lists all 8 declared catalog controls, each not declared by default', async () => {
    mount();
    expect(await screen.findByTestId('trust-declaration-incident_response_plan-status')).toHaveTextContent('Not declared');
    expect(screen.getAllByTestId(/^trust-declaration-[a-z_]+-status$/)).toHaveLength(8);
    expect(api.getTrustDeclarations).toHaveBeenCalledWith(orgFetch, 'o1');
  });

  it('the attestation checkbox gates submit; submit sends the trimmed statement, evidence and the page revision', async () => {
    const onReload = mount();
    fireEvent.click(await screen.findByTestId('trust-declare-incident_response_plan'));
    const dialog = await screen.findByTestId('trust-declare-dialog');
    expect(within(dialog).getByText(/on behalf of Northwind IT/)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('trust-declare-statement'), { target: { value: '  We test our IR plan every year.  ' } });
    const submit = screen.getByTestId('trust-declare-submit');
    expect(submit).toBeDisabled();
    await screen.findByRole('option', { name: 'IR plan' });
    fireEvent.change(screen.getByTestId('trust-declare-evidence'), { target: { value: 'doc1' } });
    fireEvent.click(screen.getByTestId('trust-declare-confirm'));
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => expect(api.declareTrustControl).toHaveBeenCalledWith(orgFetch, 'o1', {
      controlId: 'incident_response_plan', statement: 'We test our IR plan every year.', evidenceDocumentId: 'doc1', expectedRevision: 7,
    }));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });

  it('a statement under 10 characters keeps submit disabled even when confirmed', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('trust-declare-cyber_insurance'));
    fireEvent.change(await screen.findByTestId('trust-declare-statement'), { target: { value: '123456789' } });
    fireEvent.click(screen.getByTestId('trust-declare-confirm'));
    expect(screen.getByTestId('trust-declare-submit')).toBeDisabled();
  });

  it('shows the "expires in N days" badge at 30 days and not at 31', async () => {
    api.getTrustDeclarations.mockResolvedValueOnce(declState({ active: [
      decl({ id: 'a', controlId: 'incident_response_plan', expiresAt: iso(Date.now() + 30 * DAY - 60_000) }),
      decl({ id: 'b', controlId: 'cyber_insurance', expiresAt: iso(Date.now() + 31 * DAY - 60_000) }),
    ] }));
    mount();
    expect(await screen.findByTestId('trust-declaration-incident_response_plan-expiring')).toHaveTextContent('Expires in 30 days');
    expect(screen.queryByTestId('trust-declaration-cyber_insurance-expiring')).toBeNull();
    expect(screen.getByTestId('trust-declaration-cyber_insurance-status')).toHaveTextContent('Current');
    expect(screen.getByText(/Declared by Northwind IT on/, { selector: '[data-testid="trust-declaration-cyber_insurance"] *' })).toBeInTheDocument();
  });

  it('an expired active declaration reads Expired and offers Re-declare', async () => {
    api.getTrustDeclarations.mockResolvedValueOnce(declState({ active: [decl({ expiresAt: iso(Date.now() - DAY) })] }));
    mount();
    expect(await screen.findByTestId('trust-declaration-incident_response_plan-status')).toHaveTextContent('Expired');
    expect(screen.getByTestId('trust-declare-incident_response_plan')).toHaveTextContent('Re-declare');
  });

  it('marks what is on the public page and when a publish is needed', async () => {
    api.getTrustDeclarations.mockResolvedValueOnce(declState({
      active: [decl({ id: 'live' }), decl({ id: 'new', controlId: 'cyber_insurance' })],
      publishedDeclarationIds: ['live'],
    }));
    mount();
    expect(await screen.findByTestId('trust-declaration-incident_response_plan-published')).toBeInTheDocument();
    expect(screen.queryByTestId('trust-declaration-cyber_insurance-published')).toBeNull();
    expect(screen.getByTestId('trust-declarations-republish')).toHaveTextContent('Changes appear after you publish again');
  });

  it('read-only users (canWrite=false) see no buttons', async () => {
    api.getTrustDeclarations.mockResolvedValueOnce(declState({ active: [decl()] }));
    mount({ canWrite: false });
    await screen.findByTestId('trust-declaration-incident_response_plan-status');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('withdraw asks for confirmation, then sends the page revision', async () => {
    api.getTrustDeclarations.mockResolvedValueOnce(declState({ active: [decl()] }));
    const onReload = mount();
    fireEvent.click(await screen.findByTestId('trust-withdraw-incident_response_plan'));
    expect(api.withdrawTrustDeclaration).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('trust-withdraw-confirm'));
    await waitFor(() => expect(api.withdrawTrustDeclaration).toHaveBeenCalledWith(orgFetch, 'o1', 'd1', 7));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });

  it('a withdraw 409 REVISION_MISMATCH reloads too', async () => {
    api.getTrustDeclarations.mockResolvedValue(declState({ active: [decl()] }));
    api.withdrawTrustDeclaration.mockResolvedValueOnce(json(409, { error: 'stale', code: 'REVISION_MISMATCH' }));
    const onReload = mount();
    fireEvent.click(await screen.findByTestId('trust-withdraw-incident_response_plan'));
    fireEvent.click(await screen.findByTestId('trust-withdraw-confirm'));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });

  it('a withdrawn id still frozen on the live page does not ask for a republish', async () => {
    api.getTrustDeclarations.mockResolvedValueOnce(declState({
      active: [],
      history: [decl({ id: 'gone', withdrawnAt: iso(Date.now() - DAY) })],
      publishedDeclarationIds: ['gone'],
    }));
    mount();
    await screen.findByTestId('trust-declaration-incident_response_plan-status');
    expect(screen.queryByTestId('trust-declarations-republish')).toBeNull();
  });

  it('a 409 REVISION_MISMATCH calls onReload', async () => {
    api.declareTrustControl.mockResolvedValueOnce(json(409, { error: 'stale', code: 'REVISION_MISMATCH' }));
    const onReload = mount();
    fireEvent.click(await screen.findByTestId('trust-declare-incident_response_plan'));
    fireEvent.change(await screen.findByTestId('trust-declare-statement'), { target: { value: 'We test our IR plan every year.' } });
    fireEvent.click(screen.getByTestId('trust-declare-confirm'));
    fireEvent.click(screen.getByTestId('trust-declare-submit'));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('trust-declare-dialog')).toBeNull());
  });

  it('a failed load shows an error, not an empty list', async () => {
    api.getTrustDeclarations.mockRejectedValueOnce(new Error('boom'));
    mount();
    expect(await screen.findByTestId('trust-declarations-load-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('trust-declaration-incident_response_plan-status')).toBeNull();
  });
});
