import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));
const navigateTo = vi.hoisted(() => vi.fn());
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));

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
  getAgreementRequestDefaults: vi.fn(),
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
import { AGREEMENT_EMAIL_REASONS } from '../../lib/api/agreementRequests';
import enBilling from '../../locales/en/billing.json';

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
    api.getAgreementRequestDefaults.mockResolvedValue(resp({ data: { defaultExpiryDays: 30, autoReminder: null } }));
  });

  describe('#9075 W4a: expiry pre-filled from the partner default', () => {
    const inDays = (days: number) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    it("pre-fills now + the partner's default days and says where it came from, plus the reminder cadence", async () => {
      api.getAgreementRequestDefaults.mockResolvedValue(resp({ data: { defaultExpiryDays: 14, autoReminder: { intervalDays: 3, maxReminders: 2 } } }));
      renderDialog();
      await waitFor(() => expect(screen.getByTestId('agreements-send-expiry')).toHaveValue(inDays(14)));
      expect(api.getAgreementRequestDefaults).toHaveBeenCalledWith('org-1');
      expect(screen.getByTestId('agreements-send-expiry-default')).toHaveTextContent('14 days');
      expect(screen.getByTestId('agreements-send-auto-reminder')).toHaveTextContent(/every 3 days, up to 2/);
    });

    it('reminders off → no reminder line', async () => {
      api.getAgreementRequestDefaults.mockResolvedValue(resp({ data: { defaultExpiryDays: 7, autoReminder: null } }));
      renderDialog();
      await waitFor(() => expect(screen.getByTestId('agreements-send-expiry')).toHaveValue(inDays(7)));
      expect(screen.queryByTestId('agreements-send-auto-reminder')).not.toBeInTheDocument();
    });

    it('never clobbers an expiry the tech picked before the default arrived', async () => {
      let release: (r: Response) => void = () => {};
      api.getAgreementRequestDefaults.mockImplementation(() => new Promise<Response>((r) => { release = r; }));
      renderDialog();
      fireEvent.change(await screen.findByTestId('agreements-send-expiry'), { target: { value: '2099-01-15' } });
      release(resp({ data: { defaultExpiryDays: 14, autoReminder: null } }));
      await waitFor(() => expect(screen.getByTestId('agreements-send-expiry-default')).toBeInTheDocument());
      expect(screen.getByTestId('agreements-send-expiry')).toHaveValue('2099-01-15');
    });

    it('a failed defaults read keeps the built-in 30 days and SAYS so instead of naming a source', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      api.getAgreementRequestDefaults.mockResolvedValue(resp({ error: 'nope' }, 500));
      renderDialog();
      expect(await screen.findByTestId('agreements-send-expiry-default-unavailable')).toHaveTextContent(/built-in default/);
      expect(screen.getByTestId('agreements-send-expiry')).toHaveValue(inDays(30));
      expect(screen.queryByTestId('agreements-send-expiry-default')).not.toBeInTheDocument();
      warn.mockRestore();
    });

    it("switching org drops the previous org's hint until the new defaults arrive", async () => {
      api.getAgreementRequestDefaults.mockImplementation(async (orgId: string) => (orgId === 'org-1'
        ? resp({ data: { defaultExpiryDays: 14, autoReminder: { intervalDays: 3, maxReminders: 2 } } })
        : new Promise<Response>(() => {})));
      fetchWithAuth.mockImplementation(async (path: string) => {
        if (path.startsWith('/orgs/organizations/org-')) return resp({ billingContact: null });
        return resp({ data: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Globex' }] });
      });
      render(<SendAgreementDialog open onClose={vi.fn()} onSent={vi.fn()} />);
      const org = await screen.findByTestId('agreements-send-org');
      await waitFor(() => expect(org.querySelectorAll('option').length).toBeGreaterThan(2));
      fireEvent.change(org, { target: { value: 'org-1' } });
      expect(await screen.findByTestId('agreements-send-auto-reminder')).toBeInTheDocument();
      fireEvent.change(org, { target: { value: 'org-2' } });
      await waitFor(() => expect(screen.queryByTestId('agreements-send-auto-reminder')).not.toBeInTheDocument());
      expect(screen.queryByTestId('agreements-send-expiry-default')).not.toBeInTheDocument();
    });
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
  async function toPreview() {
    await waitFor(() => expect(screen.getByTestId('agreements-send-recipients')).toHaveValue('billing@acme.test'));
    await fillAndCreate();
    await screen.findByTestId('agreements-send-preview');
  }

  it.each([
    ['a 422', () => api.sendAgreementRequest.mockResolvedValue(resp({ error: 'Template unpublished' }, 422))],
    ['an HTTP 200 {success:false}', () => api.sendAgreementRequest.mockResolvedValue(resp({ success: false, error: 'nope' }))],
  ])('a failed send (%s) keeps the dialog open, keeps the draft, and re-enables Send', async (_n, arrange) => {
    arrange();
    const { onSent, onClose } = renderDialog();
    await toPreview();
    fireEvent.click(screen.getByTestId('agreements-send-submit'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    await waitFor(() => expect(screen.getByTestId('agreements-send-submit')).toBeEnabled());
    expect(onSent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(api.deleteAgreementRequest).not.toHaveBeenCalled();
    expect(screen.getByTestId('agreements-send-dialog')).toBeInTheDocument();
  });

  it('a second rapid click on Send calls sendAgreementRequest once', async () => {
    let release: (r: Response) => void = () => {};
    api.sendAgreementRequest.mockImplementation(() => new Promise<Response>((r) => { release = r; }));
    const { onSent } = renderDialog();
    await toPreview();
    const btn = screen.getByTestId('agreements-send-submit');
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(api.sendAgreementRequest).toHaveBeenCalledTimes(1);
    release(resp({ data: sendResult() }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });

  it('cancel when the draft DELETE fails (500) toasts the discard error and still closes', async () => {
    api.deleteAgreementRequest.mockResolvedValue(resp({}, 500));
    const { onClose } = renderDialog();
    await toPreview();
    fireEvent.click(screen.getByTestId('agreements-send-cancel'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringMatching(/still listed under Awaiting signature/),
    }));
  });

  it('cancel when the draft DELETE returns 404 (already gone) is a clean close with no error toast', async () => {
    api.deleteAgreementRequest.mockResolvedValue(resp({ error: 'Not found' }, 404));
    const { onClose } = renderDialog();
    await toPreview();
    fireEvent.click(screen.getByTestId('agreements-send-cancel'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(showToast).not.toHaveBeenCalled();
  });

  it('an unknown emailReason falls back to the send_failed copy', async () => {
    api.sendAgreementRequest.mockResolvedValue(resp({ data: sendResult({ emailed: false, emailReason: 'smtp_exploded' }) }));
    const { onSent } = renderDialog();
    await toPreview();
    fireEvent.click(screen.getByTestId('agreements-send-submit'));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning', message: enBilling.agreements.send.notEmailed.send_failed,
    }));
  });

  it('every emailReason enum value has an agreements.send.notEmailed.<reason> key in en', () => {
    expect(AGREEMENT_EMAIL_REASONS?.length).toBeGreaterThan(0);
    for (const reason of AGREEMENT_EMAIL_REASONS) {
      expect(enBilling.agreements.send.notEmailed, reason).toHaveProperty(reason);
    }
  });

  it('a 401 on the billing-contact prefill redirects to login', async () => {
    fetchWithAuth.mockImplementation(async (path: string) =>
      path === '/orgs/organizations/org-1' ? resp({}, 401) : resp({ data: [{ id: 'org-1', name: 'Acme' }] }));
    renderDialog();
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true }));
  });

  it('logs (console.warn) when the billing-contact prefill throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchWithAuth.mockImplementation(async (path: string) => {
      if (path === '/orgs/organizations/org-1') throw new Error('network');
      return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
    });
    renderDialog();
    await waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('logs (console.error) when the preview request throws and still shows the preview error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.previewAgreementRequest.mockRejectedValue(new Error('network'));
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('agreements-send-recipients')).toHaveValue('billing@acme.test'));
    await fillAndCreate();
    await screen.findByTestId('agreements-send-preview-error');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
