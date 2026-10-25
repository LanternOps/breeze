import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));

const templatesApi = vi.hoisted(() => ({ listContractTemplates: vi.fn() }));
vi.mock('../../lib/api/contractTemplates', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/api/contractTemplates')>();
  return { ...orig, ...templatesApi };
});

const contractsApi = vi.hoisted(() => ({ listContracts: vi.fn(), getContract: vi.fn() }));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...orig, ...contractsApi };
});

const api = vi.hoisted(() => ({
  createAgreementRequest: vi.fn(),
  updateAgreementRequest: vi.fn(),
  deleteAgreementRequest: vi.fn(),
  previewAgreementRequest: vi.fn(),
  sendAgreementRequest: vi.fn(),
}));
vi.mock('../../lib/api/agreementRequests', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/api/agreementRequests')>();
  return { ...orig, ...api };
});

import SendAgreementDialog from './SendAgreementDialog';

const resp = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, statusText: status < 400 ? 'OK' : 'Error', json: async () => payload }) as unknown as Response;

const TEMPLATE = {
  id: 't-1', name: 'MSA', status: 'active', ownerScope: 'partner', orgId: null, partnerId: 'p-1',
  latestVersion: { id: 'v-1', templateId: 't-1', versionNumber: 3, status: 'published', declaredVariables: [] },
};
const preview = (over: Record<string, unknown> = {}) => ({
  sourceType: 'authored', html: '<p>Hello Acme</p>', unresolved: [], templateName: 'MSA', versionNumber: 3, ...over,
});
const sendResult = (over: Record<string, unknown> = {}) => ({
  request: { id: 'r-1' }, emailed: true, link: 'https://x/sign', recipients: ['billing@acme.test'], ...over,
});

function renderDialog(props: Partial<React.ComponentProps<typeof SendAgreementDialog>> = {}) {
  const onSent = vi.fn();
  const onClose = vi.fn();
  render(<SendAgreementDialog open onClose={onClose} onSent={onSent} lockedOrgId="org-1" {...props} />);
  return { onSent, onClose };
}

async function fillAndCreate() {
  const select = await screen.findByTestId('agreements-send-template');
  await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: 't-1' } });
  fireEvent.click(screen.getByTestId('agreements-send-create'));
}

describe('SendAgreementDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuth.mockImplementation(async (path: string) => {
      if (path === '/orgs/organizations/org-1') return resp({ billingContact: { email: 'billing@acme.test' } });
      return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
    });
    templatesApi.listContractTemplates.mockResolvedValue(resp({ data: [TEMPLATE] }));
    contractsApi.listContracts.mockResolvedValue(resp({ data: [] }));
    api.createAgreementRequest.mockResolvedValue(resp({ data: { id: 'r-1' } }, 201));
    api.previewAgreementRequest.mockResolvedValue(resp({ data: preview() }));
    api.updateAgreementRequest.mockResolvedValue(resp({ data: { id: 'r-1' } }));
    api.deleteAgreementRequest.mockResolvedValue(resp({ data: { id: 'r-1' } }));
    api.sendAgreementRequest.mockResolvedValue(resp({ data: sendResult() }));
  });

  it('locks the org and prefills recipients from the org billing contact', async () => {
    renderDialog();
    const org = await screen.findByTestId('agreements-send-org');
    expect(org).toBeDisabled();
    expect(org).toHaveValue('org-1');
    await waitFor(() => expect(screen.getByTestId('agreements-send-recipients')).toHaveValue('billing@acme.test'));
  });

  it('does not clobber recipients the tech already typed', async () => {
    let release: (r: Response) => void = () => {};
    fetchWithAuth.mockImplementation((path: string) =>
      path === '/orgs/organizations/org-1'
        ? new Promise<Response>((r) => { release = r; })
        : Promise.resolve(resp({ data: [{ id: 'org-1', name: 'Acme' }] })));
    renderDialog();
    fireEvent.change(await screen.findByTestId('agreements-send-recipients'), { target: { value: 'typed@acme.test' } });
    release(resp({ billingContact: { email: 'billing@acme.test' } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getByTestId('agreements-send-recipients')).toHaveValue('typed@acme.test');
  });

  it('creates a draft with the form values, previews it, and sends with an emailed toast', async () => {
    const { onSent } = renderDialog();
    await waitFor(() => expect(screen.getByTestId('agreements-send-recipients')).toHaveValue('billing@acme.test'));
    fireEvent.change(screen.getByTestId('agreements-send-recipients'), { target: { value: 'a@acme.test, b@acme.test\na@acme.test' } });
    fireEvent.change(screen.getByTestId('agreements-send-cover'), { target: { value: 'Please sign' } });
    fireEvent.change(screen.getByTestId('agreements-send-label'), { target: { value: 'Renewal' } });
    fireEvent.change(screen.getByTestId('agreements-send-expiry'), { target: { value: '2099-01-15' } });
    await fillAndCreate();

    await waitFor(() => expect(api.createAgreementRequest).toHaveBeenCalled());
    const input = api.createAgreementRequest.mock.calls[0]![0];
    expect(input).toMatchObject({
      orgId: 'org-1', templateId: 't-1', recipients: ['a@acme.test', 'b@acme.test'],
      coverMessage: 'Please sign', label: 'Renewal',
    });
    // END of the picked local day, as an instant.
    expect(new Date(input.expiresAt).getTime()).toBe(new Date(2099, 0, 15, 23, 59, 59, 999).getTime());
    expect(api.previewAgreementRequest).toHaveBeenCalledWith('r-1');
    expect(await screen.findByTestId('agreements-send-preview')).toHaveTextContent('Hello Acme');

    fireEvent.click(screen.getByTestId('agreements-send-submit'));
    await waitFor(() => expect(api.sendAgreementRequest).toHaveBeenCalledWith('r-1'));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Agreement sent to 1 recipient' }));
    // A sent draft is not discarded.
    expect(api.deleteAgreementRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['no_email_service', /email isn’t configured/],
    ['no_recipients', /no recipients to email/],
    ['send_failed', /failed to deliver/],
  ])('warns (not success) when the email did not go out: %s', async (reason, text) => {
    api.sendAgreementRequest.mockResolvedValue(resp({ data: sendResult({ emailed: false, emailReason: reason }) }));
    const { onSent } = renderDialog();
    await waitFor(() => expect(screen.getByTestId('agreements-send-recipients')).toHaveValue('billing@acme.test'));
    await fillAndCreate();
    fireEvent.click(await screen.findByTestId('agreements-send-submit'));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', message: expect.stringMatching(text) }));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('blocks Send while variables are unresolved until the PATCH + re-preview clears them', async () => {
    api.previewAgreementRequest
      .mockResolvedValueOnce(resp({ data: preview({ unresolved: ['custom.po', 'custom.term'] }) }))
      .mockResolvedValueOnce(resp({ data: preview({ unresolved: [] }) }));
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('agreements-send-recipients')).toHaveValue('billing@acme.test'));
    await fillAndCreate();

    await screen.findByTestId('agreements-send-unresolved');
    expect(screen.getByTestId('agreements-send-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('agreements-send-var-custom.po'), { target: { value: 'PO-9' } });
    fireEvent.change(screen.getByTestId('agreements-send-var-custom.term'), { target: { value: '12 months' } });
    fireEvent.click(screen.getByTestId('agreements-send-update-preview'));

    await waitFor(() =>
      expect(api.updateAgreementRequest).toHaveBeenCalledWith('r-1', {
        variableValues: { 'custom.po': 'PO-9', 'custom.term': '12 months' },
      }));
    await waitFor(() => expect(screen.queryByTestId('agreements-send-unresolved')).not.toBeInTheDocument());
    expect(screen.getByTestId('agreements-send-submit')).toBeEnabled();
    // No success toast for the intermediate PATCH / create.
    expect(showToast).not.toHaveBeenCalled();
  });

  it('deletes the draft when cancelled after it was created', async () => {
    const { onClose } = renderDialog();
    await waitFor(() => expect(screen.getByTestId('agreements-send-recipients')).toHaveValue('billing@acme.test'));
    await fillAndCreate();
    await screen.findByTestId('agreements-send-preview');
    fireEvent.click(screen.getByTestId('agreements-send-cancel'));
    await waitFor(() => expect(api.deleteAgreementRequest).toHaveBeenCalledWith('r-1'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('just closes (no DELETE) when cancelled before a draft exists', async () => {
    const { onClose } = renderDialog();
    fireEvent.click(await screen.findByTestId('agreements-send-cancel'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.deleteAgreementRequest).not.toHaveBeenCalled();
  });

  it('requires at least one valid recipient before creating a draft', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('agreements-send-recipients')).toHaveValue('billing@acme.test'));
    fireEvent.change(screen.getByTestId('agreements-send-recipients'), { target: { value: '' } });
    await fillAndCreate();
    expect(await screen.findByTestId('agreements-send-recipients-error')).toHaveTextContent(/at least one recipient/i);
    expect(api.createAgreementRequest).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('agreements-send-recipients'), { target: { value: 'not-an-email' } });
    expect(screen.getByTestId('agreements-send-recipients-error')).toHaveTextContent('not-an-email');
    fireEvent.click(screen.getByTestId('agreements-send-create'));
    expect(api.createAgreementRequest).not.toHaveBeenCalled();
  });

  it('rejects more than 50 recipients', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('agreements-send-recipients')).toHaveValue('billing@acme.test'));
    const many = Array.from({ length: 51 }, (_, i) => `u${i}@acme.test`).join(',');
    fireEvent.change(screen.getByTestId('agreements-send-recipients'), { target: { value: many } });
    await fillAndCreate();
    expect(await screen.findByTestId('agreements-send-recipients-error')).toHaveTextContent(/At most 50/);
    expect(api.createAgreementRequest).not.toHaveBeenCalled();
  });

  it('shows an uploaded-document note instead of HTML for an uploaded template', async () => {
    api.previewAgreementRequest.mockResolvedValue(resp({ data: preview({ sourceType: 'uploaded', html: null }) }));
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('agreements-send-recipients')).toHaveValue('billing@acme.test'));
    await fillAndCreate();
    expect(await screen.findByTestId('agreements-send-preview')).toHaveTextContent(/uploaded document/i);
  });

  it('resolves the org and locks the contract when only a contract is given', async () => {
    contractsApi.getContract.mockResolvedValue(resp({ data: { contract: { id: 'ct-1', name: 'Acme MSA', orgId: 'org-1' } } }));
    renderDialog({ lockedOrgId: undefined, lockedContractId: 'ct-1' });
    const contract = await screen.findByTestId('agreements-send-contract');
    expect(contract).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId('agreements-send-org')).toHaveValue('org-1'));
    await waitFor(() => expect(screen.getByTestId('agreements-send-recipients')).toHaveValue('billing@acme.test'));
    await fillAndCreate();
    await waitFor(() => expect(api.createAgreementRequest).toHaveBeenCalledWith(expect.objectContaining({ contractId: 'ct-1', orgId: 'org-1' })));
  });

  it('a refused preview shows the server reason (e.g. an organization-scope sender) and keeps Send disabled', async () => {
    api.previewAgreementRequest.mockResolvedValue(resp({
      error: "The sending partner's details are not available to this account — send the agreement from a partner account",
      code: 'SELLER_UNAVAILABLE',
    }, 422));
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('agreements-send-recipients')).toHaveValue('billing@acme.test'));
    await fillAndCreate();
    expect(await screen.findByTestId('agreements-send-preview-error')).toHaveTextContent(/send the agreement from a partner account/);
    expect(screen.getByTestId('agreements-send-submit')).toBeDisabled();
  });

  it('a past expiry date says why instead of silently refusing to create the draft', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('agreements-send-recipients')).toHaveValue('billing@acme.test'));
    fireEvent.change(screen.getByTestId('agreements-send-expiry'), { target: { value: '2001-01-01' } });
    await fillAndCreate();
    expect(await screen.findByTestId('agreements-send-expiry-error')).toHaveTextContent(/future/i);
    expect(api.createAgreementRequest).not.toHaveBeenCalled();
  });
});
