import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import BillingRatesTab from './BillingRatesTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
let canManagePartnerWide: boolean | undefined = true;
let hasWriteGrant = true;
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) => sel({ user: { canManagePartnerWide } }),
}));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => hasWriteGrant }) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const profile = { id: 'p1', name: 'Standard', currencyCode: 'USD', isDefault: true, isActive: true, baseCoverage: 'billable', baseHourlyRate: '150', baseMinimumMinutes: null, roundingIncrementMinutes: null, notes: null, rules: [{ workTypeId: 'remote', coverage: 'included', hourlyRate: null, minimumMinutes: null }] };
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
let status = 200;
beforeEach(() => {
  vi.clearAllMocks(); status = 200; canManagePartnerWide = true; hasWriteGrant = true;
  vi.mocked(fetchWithAuth).mockImplementation(async (url, init) => {
    if (init?.method) return response({ profile, ...(status >= 400 ? { error: 'Save failed' } : {}) }, status);
    return response(String(url).includes('work-types') ? { workTypes: [{ id: 'remote', name: 'Remote', isActive: true }, { id: 'onsite', name: 'Onsite', isActive: true }] } : { profiles: [profile] });
  });
});
it('renders profile rows, work type columns, a base column and inherited cells', async () => {
  render(<BillingRatesTab />);
  const row = await screen.findByTestId('billing-profile-row-p1');
  expect(screen.getByRole('columnheader', { name: /All other work/i })).toBeInTheDocument();
  expect(within(row).getByTestId('billing-cell-p1-base')).toHaveTextContent(/150/);
  expect(within(row).getByTestId('billing-cell-p1-remote')).toHaveTextContent(/Included/i);
  expect(within(row).getByTestId('billing-cell-p1-onsite')).toHaveTextContent(/uses All other work/i);
  expect(screen.getByTestId('work-types-card')).toBeInTheDocument();
});
it('saves metadata, base pricing and all rules with exactly one PUT through runAction', async () => {
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-cell-p1-remote'));
  fireEvent.change(screen.getByTestId('billing-coverage-remote'), { target: { value: 'non_billable' } });
  fireEvent.change(screen.getByTestId('billing-rate-base'), { target: { value: '175' } });
  fireEvent.change(screen.getByTestId('billing-minimum-base'), { target: { value: '45' } });
  fireEvent.change(screen.getByTestId('billing-profile-rounding'), { target: { value: '30' } });
  fireEvent.change(screen.getByTestId('billing-profile-name'), { target: { value: 'Revised' } });
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  const mutations = vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method);
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toEqual(['/billing-profiles/p1/save', expect.objectContaining({ method: 'PUT' })]);
  expect(JSON.parse(mutations[0][1]!.body as string)).toEqual({ name: 'Revised', notes: null, currencyCode: 'USD',
    roundingIncrementMinutes: 30, baseCoverage: 'billable', baseHourlyRate: '175', baseMinimumMinutes: 45,
    aiCoverage: 'non_billable', aiMarkupPercent: null, aiRates: [],
    rows: [{ workTypeId: 'remote', coverage: 'non_billable', hourlyRate: null, minimumMinutes: null }] });
});
it('surfaces failed saves and keeps the drawer open', async () => {
  status = 500; render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-cell-p1-base'));
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  expect(screen.getByTestId('billing-profile-save')).toBeInTheDocument();
});
it('places currency and rounding on the profile and offers clone, default and archive actions', async () => {
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-profile-edit-p1'));
  expect(screen.getByTestId('billing-profile-currency')).toBeInTheDocument();
  expect(screen.getByTestId('billing-profile-rounding')).toBeInTheDocument();
  expect(screen.getByTestId('billing-profile-clone-p1')).toBeInTheDocument();
  expect(screen.getByTestId('billing-profile-default-p1')).toBeDisabled();
  expect(screen.getByTestId('billing-profile-archive-p1')).toBeDisabled();
});
it('retains the whole draft on failure and retries one atomic save', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async (url, init) => {
    if (init?.method === 'PUT') return response({ error: 'Rows failed' }, status);
    if (init?.method) return response({ profile });
    return response(String(url).includes('work-types') ? { workTypes: [] } : { profiles: [profile] });
  });
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-cell-p1-base'));
  fireEvent.change(screen.getByTestId('billing-rate-base'), { target: { value: '175' } });
  status = 500;
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  expect(screen.getByTestId('billing-rate-base')).toHaveValue(175);
  expect(screen.queryByText(/Profile details were saved/)).not.toBeInTheDocument();
  status = 200;
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(screen.queryByTestId('billing-profile-save')).not.toBeInTheDocument());
  const methods = vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method).map(([, init]) => init?.method);
  expect(methods).toEqual(['PUT', 'PUT']);
  const mutations = vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method);
  expect(mutations[0][1]?.body).toEqual(mutations[1][1]?.body);
});
it('creates a profile with its full rule set in one request', async () => {
  render(<BillingRatesTab currencyCode="EUR" />);
  await screen.findByTestId('billing-profile-row-p1');
  fireEvent.click(screen.getByTestId('billing-profile-create'));
  fireEvent.change(screen.getByTestId('billing-profile-name'), { target: { value: 'Premium' } });
  fireEvent.change(screen.getByTestId('billing-coverage-remote'), { target: { value: 'included' } });
  expect(screen.getByTestId('billing-profile-currency')).toHaveValue('EUR');
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(screen.queryByTestId('billing-profile-save')).not.toBeInTheDocument());
  const mutations = vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method);
  expect(mutations.map(([url, init]) => [url, init?.method])).toEqual([['/billing-profiles', 'POST']]);
  expect(JSON.parse(mutations[0][1]!.body as string)).toMatchObject({ name: 'Premium', currencyCode: 'EUR', baseCoverage: 'billable', rows: [{ workTypeId: 'remote', coverage: 'included', hourlyRate: null, minimumMinutes: null }] });
});
it('clones by name without accidentally replacing copied rules', async () => {
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-profile-clone-p1'));
  fireEvent.change(screen.getByTestId('billing-profile-name'), { target: { value: 'Silver' } });
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/billing-profiles/p1/clone', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Silver' }) })));
  expect(vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
});
it('sets defaults and archives through the real endpoints', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async (url, init) => init?.method ? response({ profile }) : response(String(url).includes('work-types') ? { workTypes: [] } : { profiles: [{ ...profile, isDefault: false }] }));
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-profile-default-p1'));
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/billing-profiles/p1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ isDefault: true }) })));
  await waitFor(() => expect(screen.getByTestId('billing-profile-archive-p1')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('billing-profile-archive-p1'));
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/billing-profiles/p1', expect.objectContaining({ method: 'DELETE' })));
});
it('shows non-billable outcomes and billable minimums', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async url => response(String(url).includes('work-types') ? { workTypes: [{ id: 'remote', name: 'Remote', isActive: true }] } : { profiles: [{ ...profile, baseMinimumMinutes: 60, rules: [{ workTypeId: 'remote', coverage: 'non_billable', hourlyRate: null, minimumMinutes: null }] }] }));
  render(<BillingRatesTab />);
  expect(await screen.findByTestId('billing-cell-p1-base')).toHaveTextContent(/60 min minimum/);
  expect(screen.getByTestId('billing-cell-p1-remote')).toHaveTextContent('Non-billable');
});
it('column actions reuse the single work type manager', async () => {
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-work-type-rename-remote'));
  expect(screen.getByTestId('work-type-edit-name')).toHaveValue('Remote');
  fireEvent.click(screen.getByTestId('billing-work-type-add-remote'));
  expect(screen.getByTestId('work-type-new-name')).toHaveFocus();
  fireEvent.click(screen.getByTestId('billing-work-type-archive-remote'));
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/billing-profiles/work-types/remote', expect.objectContaining({ method: 'DELETE' })));
});

it('keeps persisted currency locked when draft pricing is cleared', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async url => response(String(url).includes('work-types') ? { workTypes: [] } : { profiles: [{ ...profile, isDefault: false }] }));
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-cell-p1-base'));
  fireEvent.change(screen.getByTestId('billing-rate-base'), { target: { value: '' } });
  expect(screen.getByTestId('billing-profile-currency')).toBeDisabled();
});
it('retains the draft and reports failure on repeated atomic-save failures', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async (url, init) => {
    if (init?.method === 'PUT') return response({ error: 'Rows failed' }, 500);
    if (init?.method) return response({ profile });
    return response(String(url).includes('work-types') ? { workTypes: [] } : { profiles: [profile] });
  });
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-cell-p1-base'));
  fireEvent.change(screen.getByTestId('billing-rate-base'), { target: { value: '175' } });
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  expect(screen.getByTestId('billing-rate-base')).toHaveValue(175);
  expect(screen.queryByText(/Profile details were saved/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2));
  await waitFor(() => expect(screen.getByTestId('billing-profile-save')).not.toBeDisabled());
  expect(screen.getByTestId('billing-rate-base')).toHaveValue(175);
  expect(screen.queryByText(/Profile details were saved/)).not.toBeInTheDocument();
  expect(showToast).toHaveBeenCalledTimes(2);
});

it('retries failed creation with one complete POST and no partial identity', async () => {
  render(<BillingRatesTab />);
  await screen.findByTestId('billing-profile-row-p1');
  fireEvent.click(screen.getByTestId('billing-profile-create'));
  fireEvent.change(screen.getByTestId('billing-profile-name'), { target: { value: 'Premium' } });
  fireEvent.change(screen.getByTestId('billing-coverage-remote'), { target: { value: 'included' } });
  status = 500;
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  expect(screen.getByTestId('billing-profile-name')).toHaveValue('Premium');
  status = 200;
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(screen.queryByTestId('billing-profile-save')).not.toBeInTheDocument());
  const mutations = vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method);
  expect(mutations.map(([url, init]) => [url, init?.method])).toEqual([['/billing-profiles', 'POST'], ['/billing-profiles', 'POST']]);
  expect(mutations[0][1]?.body).toEqual(mutations[1][1]?.body);
});
const aiRow = { modelId: 'claude-sonnet-4-5', inputPricePerM: '3.000000', outputPricePerM: '15.000000', cacheReadPricePerM: '0.300000', cacheWritePricePerM: '3.750000' };
const aiProfile = (over: Record<string, unknown> = {}) => ({ ...profile, aiCoverage: 'non_billable', aiMarkupPercent: null, aiRates: [], ...over });
const CHOICES_URL = '/billing-profiles/ai-model-choices';
function mockApi(profiles: unknown[], opts: { choicesStatus?: number } = {}) {
  vi.mocked(fetchWithAuth).mockImplementation(async (url, init) => {
    if (init?.method) return response({ profile: profiles[0] });
    const u = String(url);
    if (u === CHOICES_URL) {
      return opts.choicesStatus && opts.choicesStatus >= 400
        ? response({ error: 'nope' }, opts.choicesStatus)
        : response({ choices: [{ modelId: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', source: 'offering' }, { modelId: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', source: 'recent_usage' }] });
    }
    return response(u.includes('work-types') ? { workTypes: [] } : { profiles });
  });
}
const choiceCalls = () => vi.mocked(fetchWithAuth).mock.calls.filter(([url]) => url === CHOICES_URL);
const change = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

it('shows an AI usage column summarising each card', async () => {
  mockApi([
    aiProfile({ id: 'a', name: 'A', isDefault: true, aiCoverage: 'billable', aiMarkupPercent: '25.00' }),
    aiProfile({ id: 'b', name: 'B', isDefault: false, aiCoverage: 'billable', aiRates: [aiRow, { ...aiRow, modelId: 'm2' }, { ...aiRow, modelId: 'm3' }] }),
    aiProfile({ id: 'c', name: 'C', isDefault: false, aiCoverage: 'included' }),
    aiProfile({ id: 'd', name: 'D', isDefault: false }),
    { ...profile, id: 'e', name: 'E', isDefault: false },
  ]);
  render(<BillingRatesTab />);
  expect(await screen.findByTestId('billing-ai-column-header')).toHaveTextContent('AI usage');
  expect(screen.getByTestId('billing-ai-cell-a')).toHaveTextContent('Billable · cost +25%');
  expect(screen.getByTestId('billing-ai-cell-b')).toHaveTextContent('Billable · price list (3 models)');
  expect(screen.getByTestId('billing-ai-cell-c')).toHaveTextContent('Included');
  expect(screen.getByTestId('billing-ai-cell-d')).toHaveTextContent('Not billed');
  expect(screen.getByTestId('billing-ai-cell-e')).toHaveTextContent('Not billed');
});

it('opens the drawer from the AI cell and fetches model choices once per open with a plain GET', async () => {
  mockApi([aiProfile()]);
  render(<BillingRatesTab />);
  expect(choiceCalls()).toHaveLength(0);
  fireEvent.click(await screen.findByTestId('billing-ai-cell-p1'));
  await waitFor(() => expect(choiceCalls()).toHaveLength(1));
  expect(choiceCalls()[0][1]).toBeUndefined();
  change('billing-ai-coverage', 'billable');
  fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
  change('billing-profile-name', 'Renamed');
  expect(await screen.findByTestId('billing-ai-model-option-claude-sonnet-4-5')).toBeInTheDocument();
  expect(choiceCalls()).toHaveLength(1);
  expect(vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
});

it('saves AI terms with the existing single PUT', async () => {
  mockApi([aiProfile()]);
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-profile-edit-p1'));
  change('billing-ai-coverage', 'billable');
  change('billing-ai-markup', '25');
  fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
  change('billing-ai-rate-model-0', 'claude-sonnet-4-5');
  change('billing-ai-rate-input-0', '3.00');
  change('billing-ai-rate-output-0', '15.00');
  change('billing-ai-rate-cache-read-0', '0.30');
  change('billing-ai-rate-cache-write-0', '3.75');
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  const mutations = vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method);
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toEqual(['/billing-profiles/p1/save', expect.objectContaining({ method: 'PUT' })]);
  expect(JSON.parse(mutations[0][1]!.body as string)).toMatchObject({
    aiCoverage: 'billable', aiMarkupPercent: '25',
    aiRates: [{ modelId: 'claude-sonnet-4-5', inputPricePerM: '3.00', outputPricePerM: '15.00', cacheReadPricePerM: '0.30', cacheWritePricePerM: '3.75' }],
  });
});

it('includes AI terms when creating a profile and defaults them to not billed', async () => {
  mockApi([aiProfile()]);
  render(<BillingRatesTab />);
  await screen.findByTestId('billing-profile-row-p1');
  fireEvent.click(screen.getByTestId('billing-profile-create'));
  expect(screen.getByTestId('billing-ai-coverage')).toHaveValue('non_billable');
  change('billing-profile-name', 'Premium');
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(screen.queryByTestId('billing-profile-save')).not.toBeInTheDocument());
  const mutations = vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method);
  expect(mutations.map(([url, init]) => [url, init?.method])).toEqual([['/billing-profiles', 'POST']]);
  expect(JSON.parse(mutations[0][1]!.body as string)).toMatchObject({ aiCoverage: 'non_billable', aiMarkupPercent: null, aiRates: [] });
});

it('blocks Save on an invalid markup or incomplete price row without sending anything', async () => {
  mockApi([aiProfile({ aiCoverage: 'billable' })]);
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-profile-edit-p1'));
  expect(screen.getByTestId('billing-profile-save')).not.toBeDisabled();
  change('billing-ai-markup', '1500');
  expect(screen.getByTestId('billing-ai-markup-error')).toBeInTheDocument();
  expect(screen.getByTestId('billing-profile-save')).toBeDisabled();
  change('billing-ai-markup', '20');
  expect(screen.getByTestId('billing-profile-save')).not.toBeDisabled();
  fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
  expect(screen.getByTestId('billing-profile-save')).toBeDisabled();
  expect(vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
});

it('warns for a billable EUR card with no price list and hides the warning on USD', async () => {
  mockApi([aiProfile({ id: 'eur', name: 'Euro', currencyCode: 'EUR', isDefault: false, aiCoverage: 'billable', aiMarkupPercent: '20' }), aiProfile({ aiCoverage: 'billable', aiMarkupPercent: '20' })]);
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-profile-edit-eur'));
  expect(screen.getByTestId('billing-ai-currency-warning')).toHaveTextContent('Markup applies only to USD cards; add a price list for EUR or usage will be recorded unpriced.');
  fireEvent.click(screen.getByTestId('billing-profile-cancel'));
  fireEvent.click(screen.getByTestId('billing-profile-edit-p1'));
  expect(screen.queryByTestId('billing-ai-currency-warning')).not.toBeInTheDocument();
});

it('degrades to free-text model ids when the choices request fails', async () => {
  mockApi([aiProfile({ aiCoverage: 'billable' })], { choicesStatus: 500 });
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-profile-edit-p1'));
  expect(await screen.findByTestId('billing-ai-choices-unavailable')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
  change('billing-ai-rate-model-0', 'my-private-model');
  expect(screen.getByTestId('billing-ai-rate-model-0')).toHaveValue('my-private-model');
  expect(showToast).not.toHaveBeenCalled();
});

it('shows no AI section and makes no choices request when cloning', async () => {
  mockApi([aiProfile({ aiCoverage: 'billable', aiMarkupPercent: '25.00' })]);
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-profile-clone-p1'));
  expect(screen.queryByTestId('billing-ai-section')).not.toBeInTheDocument();
  change('billing-profile-name', 'Silver');
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/billing-profiles/p1/clone', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Silver' }) })));
  expect(choiceCalls()).toHaveLength(0);
});

it('keeps price rows editable across a failed save and retries the identical body', async () => {
  mockApi([aiProfile({ aiCoverage: 'billable', aiRates: [aiRow] })]);
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-profile-edit-p1'));
  change('billing-ai-rate-input-0', '4.00');
  vi.mocked(fetchWithAuth).mockImplementationOnce(async () => response({ error: 'boom' }, 500));
  // first mutation call fails; remaining GETs are not re-issued during save
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  expect(screen.getByTestId('billing-ai-rate-input-0')).toHaveValue('4.00');
});

it.each([
  ['lacks partner-wide access', { partnerWide: false, grant: true }],
  ['lacks billing_profiles:write', { partnerWide: true, grant: false }],
])('is read-only when the user %s (#7597)', async (_label, { partnerWide, grant }) => {
  canManagePartnerWide = partnerWide; hasWriteGrant = grant;
  render(<BillingRatesTab />);
  await screen.findByTestId('billing-profile-row-p1');
  await screen.findByTestId('work-type-row-remote');
  expect(screen.getByTestId('billing-rates-readonly')).toBeInTheDocument();
  expect(screen.getByTestId('billing-profile-create')).toBeDisabled();
  expect(screen.queryByTestId('billing-profile-clone-p1')).not.toBeInTheDocument();
  expect(screen.queryByTestId('billing-profile-default-p1')).not.toBeInTheDocument();
  expect(screen.queryByTestId('billing-profile-archive-p1')).not.toBeInTheDocument();
  expect(screen.queryByTestId('billing-work-type-rename-remote')).not.toBeInTheDocument();
  expect(screen.queryByTestId('billing-work-type-archive-remote')).not.toBeInTheDocument();
  expect(screen.queryByTestId('work-type-new-name')).not.toBeInTheDocument();
  expect(screen.queryByTestId('work-type-rename-remote')).not.toBeInTheDocument();
  expect(screen.queryByTestId('work-type-archive-remote')).not.toBeInTheDocument();
  // Opening a profile shows its rates but offers no Save.
  fireEvent.click(screen.getByTestId('billing-profile-edit-p1'));
  expect(screen.getByTestId('billing-profile-name')).toBeDisabled();
  expect(screen.queryByTestId('billing-profile-save')).not.toBeInTheDocument();
});
it('stays editable when canManagePartnerWide is absent (stale session)', async () => {
  canManagePartnerWide = undefined;
  render(<BillingRatesTab />);
  await screen.findByTestId('billing-profile-row-p1');
  expect(screen.queryByTestId('billing-rates-readonly')).not.toBeInTheDocument();
  expect(screen.getByTestId('billing-profile-create')).toBeEnabled();
});
