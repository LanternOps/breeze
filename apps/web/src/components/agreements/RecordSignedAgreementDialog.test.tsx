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

const requestsApi = vi.hoisted(() => ({ recordSignedAgreement: vi.fn() }));
vi.mock('../../lib/api/agreementRequests', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/api/agreementRequests')>();
  return { ...orig, ...requestsApi };
});

import RecordSignedAgreementDialog from './RecordSignedAgreementDialog';

const resp = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, statusText: status < 400 ? 'OK' : 'Error', json: async () => payload }) as unknown as Response;

const TEMPLATE = {
  id: 't-1',
  name: 'MSA',
  status: 'active',
  ownerScope: 'partner',
  orgId: null,
  partnerId: 'p-1',
  latestVersion: { id: 'v-1', templateId: 't-1', versionNumber: 3, status: 'published', declaredVariables: [] },
};

function renderDialog(props: Partial<React.ComponentProps<typeof RecordSignedAgreementDialog>> = {}) {
  const onRecorded = vi.fn();
  render(
    <RecordSignedAgreementDialog open onClose={vi.fn()} lockedOrgId="org-1" onRecorded={onRecorded} {...props} />,
  );
  return { onRecorded };
}

async function pickTemplate() {
  const select = await screen.findByTestId('agreements-record-template');
  await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: 't-1' } });
}

function fill() {
  fireEvent.change(screen.getByTestId('agreements-record-reference'), { target: { value: 'PO 4471' } });
  fireEvent.change(screen.getByTestId('agreements-record-signer-name'), { target: { value: 'Dana Buyer' } });
}

describe('RecordSignedAgreementDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuth.mockResolvedValue(resp({ data: [{ id: 'org-1', name: 'Acme' }] }));
    templatesApi.listContractTemplates.mockResolvedValue(resp({ data: [TEMPLATE] }));
    contractsApi.listContracts.mockResolvedValue(resp({ data: [] }));
    requestsApi.recordSignedAgreement.mockResolvedValue(
      resp({ data: { request: { id: 'r-1' }, signedAgreementId: 'sa-1', contentSha256: 'a'.repeat(64) } }, 201),
    );
  });

  it('keeps submit disabled until template, reference and signer are set', async () => {
    renderDialog();
    const submit = await screen.findByTestId('agreements-record-submit');
    expect(submit).toBeDisabled();
    await pickTemplate();
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId('agreements-record-reference'), { target: { value: 'PO 4471' } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId('agreements-record-signer-name'), { target: { value: 'Dana Buyer' } });
    expect(submit).toBeEnabled();
  });

  it('switches the method to signed_document when a file is attached', async () => {
    renderDialog();
    const method = (await screen.findByTestId('agreements-record-method')) as HTMLSelectElement;
    expect(method.value).toBe('verbal');
    const file = new File(['%PDF'], 'msa.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('agreements-record-file'), { target: { files: [file] } });
    expect(method.value).toBe('signed_document');
  });

  it('reverts the auto-picked method when the file is removed', async () => {
    renderDialog();
    const method = (await screen.findByTestId('agreements-record-method')) as HTMLSelectElement;
    const input = screen.getByTestId('agreements-record-file');
    fireEvent.change(input, { target: { files: [new File(['%PDF'], 'msa.pdf', { type: 'application/pdf' })] } });
    expect(method.value).toBe('signed_document');
    fireEvent.change(input, { target: { files: [] } });
    expect(method.value).toBe('verbal');
  });

  it('says so when the org\'s contracts fail to load (instead of an empty "no contracts" list)', async () => {
    contractsApi.listContracts.mockResolvedValue(resp({ error: 'boom' }, 500));
    renderDialog();
    expect(await screen.findByTestId('agreements-record-contracts-error')).toBeInTheDocument();
  });

  it('says so when organizations fail to load', async () => {
    fetchWithAuth.mockResolvedValue(resp({ error: 'boom' }, 500));
    renderDialog({ lockedOrgId: undefined });
    expect(await screen.findByTestId('agreements-record-orgs-error')).toBeInTheDocument();
  });

  it('contract-only embed: a failed contract lookup is shown, not a silently disabled form', async () => {
    contractsApi.getContract.mockResolvedValue(resp({ error: 'boom' }, 500));
    renderDialog({ lockedOrgId: undefined, lockedContractId: 'c-1' });
    expect(await screen.findByTestId('agreements-record-contract-error')).toBeInTheDocument();
    expect(screen.getByTestId('agreements-record-submit')).toBeDisabled();
  });

  it('locked org + locked contract: the contract field shows its name, not its id', async () => {
    const CONTRACT_ID = '5b0f3a52-8c1e-4d7a-9a3b-0c6d2f1e7b44';
    contractsApi.getContract.mockResolvedValue(
      resp({ data: { contract: { id: CONTRACT_ID, orgId: 'org-1', name: 'G4 Monthly active' } } }),
    );
    renderDialog({ lockedOrgId: 'org-1', lockedContractId: CONTRACT_ID });
    const select = (await screen.findByTestId('agreements-record-contract')) as HTMLSelectElement;
    await waitFor(() => expect(select.selectedOptions[0]?.textContent).toBe('G4 Monthly active'));
    expect(select.value).toBe(CONTRACT_ID);
    expect(select.textContent).not.toContain(CONTRACT_ID);
  });

  it('does not override a method the user already chose', async () => {
    renderDialog();
    const method = (await screen.findByTestId('agreements-record-method')) as HTMLSelectElement;
    fireEvent.change(method, { target: { value: 'purchase_order' } });
    const file = new File(['%PDF'], 'po.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('agreements-record-file'), { target: { files: [file] } });
    expect(method.value).toBe('purchase_order');
  });

  it('submits the pinned version and calls onRecorded with the new signed agreement id', async () => {
    const { onRecorded } = renderDialog();
    await pickTemplate();
    fill();
    fireEvent.click(screen.getByTestId('agreements-record-submit'));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledWith('sa-1'));
    const sent = requestsApi.recordSignedAgreement.mock.calls[0]![0];
    expect(sent).toMatchObject({
      orgId: 'org-1',
      templateVersionId: 'v-1',
      reference: 'PO 4471',
      signerName: 'Dana Buyer',
      method: 'verbal',
    });
    expect(sent.signedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The picked calendar day rides along as the effective date (the tech's
    // own timezone), never derived server-side from signedAt's UTC day.
    const picked = (screen.getByTestId('agreements-record-signed-at') as HTMLInputElement).value;
    expect(picked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sent.effectiveDate).toBe(picked);
  });

  it('does not render an input for an unresolved AUTO variable (the server would ignore a typed value)', async () => {
    templatesApi.listContractTemplates.mockResolvedValue(resp({ data: [{
      ...TEMPLATE,
      latestVersion: { ...TEMPLATE.latestVersion, declaredVariables: [{ name: 'totals.monthly', kind: 'auto' }] },
    }] }));
    requestsApi.recordSignedAgreement.mockResolvedValue(
      resp({ error: 'Agreement variables unresolved: totals.monthly', code: 'AGREEMENT_VARIABLES_UNRESOLVED' }, 422),
    );
    renderDialog();
    await pickTemplate();
    fill();
    fireEvent.click(screen.getByTestId('agreements-record-submit'));
    await waitFor(() => expect(requestsApi.recordSignedAgreement).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('agreements-record-submit')).not.toBeDisabled());
    expect(screen.queryByTestId('agreements-record-var-totals.monthly')).toBeNull();
  });

  it('renders the variables a 422 AGREEMENT_VARIABLES_UNRESOLVED names as required fields', async () => {
    requestsApi.recordSignedAgreement.mockResolvedValue(
      resp({ error: 'Agreement variables unresolved: custom.po', code: 'AGREEMENT_VARIABLES_UNRESOLVED' }, 422),
    );
    const { onRecorded } = renderDialog();
    await pickTemplate();
    fill();
    fireEvent.click(screen.getByTestId('agreements-record-submit'));
    const field = await screen.findByTestId('agreements-record-var-custom.po');
    expect(field).toBeRequired();
    expect(onRecorded).not.toHaveBeenCalled();
    // Required and empty -> cannot resubmit until the value is provided.
    expect(screen.getByTestId('agreements-record-submit')).toBeDisabled();
  });

  it('drops fields a 422 named for a previous template when the template changes', async () => {
    templatesApi.listContractTemplates.mockResolvedValue(resp({ data: [
      TEMPLATE,
      { ...TEMPLATE, id: 't-2', name: 'NDA', latestVersion: { ...TEMPLATE.latestVersion, id: 'v-2', templateId: 't-2' } },
    ] }));
    requestsApi.recordSignedAgreement.mockResolvedValue(
      resp({ error: 'Agreement variables unresolved: custom.po', code: 'AGREEMENT_VARIABLES_UNRESOLVED' }, 422),
    );
    renderDialog();
    await pickTemplate();
    fill();
    fireEvent.click(screen.getByTestId('agreements-record-submit'));
    await screen.findByTestId('agreements-record-var-custom.po');
    fireEvent.change(screen.getByTestId('agreements-record-template'), { target: { value: 't-2' } });
    expect(screen.queryByTestId('agreements-record-var-custom.po')).toBeNull();
    expect(screen.getByTestId('agreements-record-submit')).toBeEnabled();
  });
});
