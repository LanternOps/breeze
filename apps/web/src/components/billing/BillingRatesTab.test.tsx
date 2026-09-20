import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import BillingRatesTab from './BillingRatesTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const profile = { id: 'p1', name: 'Standard', currencyCode: 'USD', isDefault: true, isActive: true, baseCoverage: 'billable', baseHourlyRate: '150', baseMinimumMinutes: null, roundingIncrementMinutes: null, notes: null, rules: [{ workTypeId: 'remote', coverage: 'included', hourlyRate: null, minimumMinutes: null }] };
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
let status = 200;
beforeEach(() => {
  vi.clearAllMocks(); status = 200;
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
it('edits a whole profile and saves all rules with exactly one PUT through runAction', async () => {
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-cell-p1-remote'));
  fireEvent.change(screen.getByTestId('billing-coverage-remote'), { target: { value: 'non_billable' } });
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  const mutations = vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method);
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toEqual(['/billing-profiles/p1/rows', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ rows: [{ workTypeId: 'remote', coverage: 'non_billable', hourlyRate: null, minimumMinutes: null }] }) })]);
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
it('reports partial metadata save and retries only the remaining rules PUT', async () => {
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
  await screen.findByText(/Profile details were saved, but work type rates were not/);
  status = 200;
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(screen.queryByTestId('billing-profile-save')).not.toBeInTheDocument());
  const methods = vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method).map(([, init]) => init?.method);
  expect(methods).toEqual(['PATCH', 'PUT', 'PUT']);
});
it('creates a profile then saves its full rule set', async () => {
  render(<BillingRatesTab currencyCode="EUR" />);
  await screen.findByTestId('billing-profile-row-p1');
  fireEvent.click(screen.getByTestId('billing-profile-create'));
  fireEvent.change(screen.getByTestId('billing-profile-name'), { target: { value: 'Premium' } });
  expect(screen.getByTestId('billing-profile-currency')).toHaveValue('EUR');
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(screen.queryByTestId('billing-profile-save')).not.toBeInTheDocument());
  const mutations = vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method);
  expect(mutations.map(([url, init]) => [url, init?.method])).toEqual([['/billing-profiles', 'POST'], ['/billing-profiles/p1/rows', 'PUT']]);
  expect(JSON.parse(mutations[0][1]!.body as string)).toMatchObject({ name: 'Premium', currencyCode: 'EUR', baseCoverage: 'billable' });
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
it('keeps partial-save warning when retrying rules fails again', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async (url, init) => {
    if (init?.method === 'PUT') return response({ error: 'Rows failed' }, 500);
    if (init?.method) return response({ profile });
    return response(String(url).includes('work-types') ? { workTypes: [] } : { profiles: [profile] });
  });
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-cell-p1-base'));
  fireEvent.change(screen.getByTestId('billing-rate-base'), { target: { value: '175' } });
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await screen.findByText(/Profile details were saved, but work type rates were not/);
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2));
  await waitFor(() => expect(screen.getByTestId('billing-profile-save')).not.toBeDisabled());
  expect(screen.getByText(/Profile details were saved, but work type rates were not/)).toBeInTheDocument();
});
