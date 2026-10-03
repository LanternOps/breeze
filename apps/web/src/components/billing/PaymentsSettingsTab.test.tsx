import { beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import PaymentsSettingsTab, { usePaymentSettings } from './PaymentsSettingsTab';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const inherited = {
  autopayOffsetDays:{value:7,source:'partner'},autopayOffsetRule:{value:'later',source:'partner'},
  autopayCap:{value:{enabled:true,amount:'500.00',currency:'USD'},source:'partner'},
  achMode:{value:'ach_preferred',source:'default'},cardFeeBps:{value:0,source:'default'},
  achFeeAmount:{value:'0.00',source:'default'},feeAttested:false,
  remindersEnabled:{value:false,source:'default'},reminderBeforeDueDays:{value:3,source:'default'},
  reminderRepeatDays:{value:null,source:'default'},overdueReminderEveryDays:{value:7,source:'default'},
};
const values={autopayOffsetDays:null,autopayOffsetRule:null,autopayCapEnabled:null,
  autopayCapAmount:null,autopayCapCurrency:null,achMode:null,cardFeeBps:null,achFeeAmount:null};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, init) => Response.json(
    init?.method === 'PUT' ? { success: true } : { autopayEnabled: true, values, inherited, effective: inherited }));
});
function mount() {
  return render(<I18nextProvider i18n={i18n}><PaymentsSettingsTab orgId="11111111-1111-4111-8111-111111111111" /></I18nextProvider>);
}
it('keeps blank distinct from explicit unlimited and submits decimal cap without floats', async () => {
  mount();
  const days = await screen.findByTestId('autopay-offset-days');
  expect(days).toHaveValue(null);
  expect(days).toHaveAttribute('placeholder', '7');
  fireEvent.change(screen.getByTestId('autopay-cap-enabled'), { target: { value: 'false' } });
  fireEvent.click(screen.getByTestId('autopay-settings-save'));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(true));
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, i]) => i?.method === 'PUT')!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({ ...values, remindersEnabled: null, reminderBeforeDueDays: null, reminderRepeatDays: null, overdueReminderEveryDays: null, autopayCapEnabled: false });
});
it('requires amount and currency together and does not accept exponent money', async () => {
  mount();
  fireEvent.change(await screen.findByTestId('autopay-cap-enabled'), { target: { value: 'true' } });
  fireEvent.change(screen.getByTestId('autopay-cap-currency'), { target: { value: 'USD' } });
  fireEvent.change(screen.getByTestId('autopay-cap-amount'), { target: { value: '1e3' } });
  expect(screen.getByTestId('autopay-settings-save')).toBeDisabled();
  fireEvent.change(screen.getByTestId('autopay-cap-amount'), { target: { value: '1000.50' } });
  fireEvent.change(screen.getByTestId('autopay-cap-currency'), { target: { value: 'USD' } });
  expect(screen.getByTestId('autopay-settings-save')).not.toBeDisabled();
});
it('mounts reminders when autopay is disabled', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async () => Response.json(reminderView()));
  mount();
  expect(await screen.findByTestId('autopay-reminders-section')).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-settings-section')).toBeNull();
});

it('submits the exact decimal string only after valid complete cap terms', async () => {
  mount();
  fireEvent.change(await screen.findByTestId('autopay-cap-enabled'), { target: { value: 'true' } });
  fireEvent.change(screen.getByTestId('autopay-cap-amount'), { target: { value: '1000.50' } });
  expect(screen.getByTestId('autopay-settings-save')).toBeDisabled();
  expect(vi.mocked(fetchWithAuth).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  fireEvent.change(screen.getByTestId('autopay-cap-currency'), { target: { value: 'USD' } });
  fireEvent.click(screen.getByTestId('autopay-settings-save'));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({ ...values, remindersEnabled: null, reminderBeforeDueDays: null, reminderRepeatDays: null, overdueReminderEveryDays: null, autopayCapEnabled: true,
    autopayCapAmount: '1000.50', autopayCapCurrency: 'USD' });
});

it.each([['1000', '1000.00'], ['1000.5', '1000.50']])('submits %s as the API decimal string %s', async (input, expected) => {
  mount();
  fireEvent.change(await screen.findByTestId('autopay-cap-enabled'), { target: { value: 'true' } });
  fireEvent.change(screen.getByTestId('autopay-cap-amount'), { target: { value: input } });
  fireEvent.change(screen.getByTestId('autopay-cap-currency'), { target: { value: 'USD' } });
  fireEvent.click(screen.getByTestId('autopay-settings-save'));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(JSON.parse(call[1]!.body as string).autopayCapAmount).toBe(expected);
});

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const orgB = '22222222-2222-4222-8222-222222222222';
function settingsResponse(days: number) {
  return Response.json({ autopayEnabled: true, values: { ...values, autopayOffsetDays: days }, inherited, effective: inherited });
}
it.each(['success', 'error'])('ignores obsolete organization load %s after the new organization loads', async outcome => {
  const oldRequest = deferredResponse();
  const newRequest = deferredResponse();
  vi.mocked(fetchWithAuth).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
  const { rerender } = mount();
  rerender(<I18nextProvider i18n={i18n}><PaymentsSettingsTab orgId={orgB} /></I18nextProvider>);
  await act(async () => { newRequest.resolve(settingsResponse(12)); });
  expect(screen.getByTestId('autopay-offset-days')).toHaveValue(12);
  await act(async () => {
    if (outcome === 'success') oldRequest.resolve(settingsResponse(3));
    else oldRequest.reject(new Error('obsolete load failed'));
  });
  expect(screen.queryByTestId('autopay-settings-error')).toBeNull();
  expect(screen.getByTestId('autopay-offset-days')).toHaveValue(12);
  fireEvent.click(screen.getByTestId('autopay-settings-save'));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(call[0]).toBe(`/orgs/${orgB}/billing/payment-settings`);
  expect(JSON.parse(call[1]!.body as string).autopayOffsetDays).toBe(12);
});
it('keeps the new organization loading when an obsolete request completes', async () => {
  const oldRequest = deferredResponse();
  const newRequest = deferredResponse();
  vi.mocked(fetchWithAuth).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
  const { rerender } = mount();
  rerender(<I18nextProvider i18n={i18n}><PaymentsSettingsTab orgId={orgB} /></I18nextProvider>);
  await act(async () => { oldRequest.resolve(settingsResponse(3)); });
  expect(screen.getByTestId('autopay-settings-loading')).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-settings-save')).toBeNull();
  await act(async () => { newRequest.resolve(settingsResponse(12)); });
  expect(screen.getByTestId('autopay-offset-days')).toHaveValue(12);
});
it('clears previously loaded settings while switching organizations', async () => {
  const { rerender } = mount();
  await screen.findByTestId('autopay-offset-days');
  const newRequest = deferredResponse();
  vi.mocked(fetchWithAuth).mockReturnValueOnce(newRequest.promise);
  rerender(<I18nextProvider i18n={i18n}><PaymentsSettingsTab orgId={orgB} /></I18nextProvider>);
  expect(screen.queryByTestId('autopay-settings-save')).toBeNull();
  await act(async () => { newRequest.resolve(settingsResponse(12)); });
  expect(screen.getByTestId('autopay-offset-days')).toHaveValue(12);
});

const reminderView = () => {
  const effective = {
    autopayOffsetDays: { value: 0, source: 'default' }, autopayOffsetRule: { value: 'later', source: 'default' },
    autopayCap: { value: { enabled: false }, source: 'default' }, achMode: { value: 'ach_preferred', source: 'default' },
    cardFeeBps: { value: 0, source: 'default' }, achFeeAmount: { value: '0.00', source: 'default' }, feeAttested: false,
    remindersEnabled: { value: false, source: 'default' }, reminderBeforeDueDays: { value: 3, source: 'default' },
    reminderRepeatDays: { value: null, source: 'default' }, overdueReminderEveryDays: { value: 7, source: 'default' },
  };
  return { autopayEnabled: false, effective, inherited: effective, values: {
    autopayOffsetDays: null, autopayOffsetRule: null, autopayCapEnabled: null,
    autopayCapAmount: null, autopayCapCurrency: null, achMode: null,
  } };
};
it('saves reminder-only payload when rollout is off and retains draft after failure', async () => {
  const fetch = vi.mocked(fetchWithAuth);
  fetch.mockImplementation(async (_url, init) => Response.json(init?.method === 'PUT'
    ? { error: 'Save failed' } : reminderView(), { status: init?.method === 'PUT' ? 500 : 200 }));
  const { result } = renderHook(() => usePaymentSettings());
  await waitFor(() => expect(result.current.reminders).not.toBeNull());
  act(() => result.current.setReminders({ ...result.current.reminders!, reminderBeforeDueDays: '9', remindersEnabled: 'false' }));
  await act(async () => { await expect(result.current.save()).rejects.toThrow(); });
  expect(result.current.reminders?.reminderBeforeDueDays).toBe('9');
  const call = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({
    remindersEnabled: false, reminderBeforeDueDays: 9, reminderRepeatDays: null, overdueReminderEveryDays: null,
  });
});
it('does not let a late org-A load overwrite org-B and then save to B', async () => {
  let finishA!: (response: Response) => void;
  const fetch = vi.mocked(fetchWithAuth);
  fetch.mockImplementation(async url => String(url).includes('/orgs/a/')
    ? new Promise<Response>(resolve => { finishA = resolve; }) : Response.json(reminderView()));
  const { result, rerender } = renderHook(({ id }) => usePaymentSettings(id), { initialProps: { id: 'a' } });
  rerender({ id: 'b' });
  await waitFor(() => expect(result.current.reminders).not.toBeNull());
  act(() => result.current.setReminders({ ...result.current.reminders!, reminderBeforeDueDays: '8' }));
  await act(async () => { finishA(Response.json(reminderView())); });
  expect(result.current.reminders?.reminderBeforeDueDays).toBe('8');
});
it('saves blanks as null for an org then displays the inherited partner value', async () => {
  const data = reminderView();
  data.effective.reminderBeforeDueDays = { value: 5, source: 'partner' };
  data.inherited.reminderBeforeDueDays = { value: 5, source: 'partner' };
  const fetch = vi.mocked(fetchWithAuth); fetch.mockImplementation(async () => Response.json(data));
  const { result } = renderHook(() => usePaymentSettings('11111111-1111-4111-8111-111111111111'));
  await waitFor(() => expect(result.current.reminders).not.toBeNull());
  await act(async () => { await result.current.save(); });
  const call = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(JSON.parse(call[1]!.body as string).reminderBeforeDueDays).toBeNull();
  expect(result.current.view?.inherited.reminderBeforeDueDays.value).toBe(5);
});

it('isolates a deferred save across A to B to A, including draft and saving state', async () => {
  const oldSave = deferredResponse();
  const currentSave = deferredResponse();
  let puts = 0;
  const fetch = vi.mocked(fetchWithAuth);
  fetch.mockImplementation(async (_url, init) => init?.method === 'PUT'
    ? (++puts === 1 ? oldSave.promise : currentSave.promise) : Response.json(reminderView()));
  const { result, rerender } = renderHook(({ id }) => usePaymentSettings(id), { initialProps: { id: 'a' } });
  await waitFor(() => expect(result.current.reminders).not.toBeNull());
  let pendingOld!: Promise<void>;
  act(() => { pendingOld = result.current.save(); });
  rerender({ id: 'b' });
  await waitFor(() => expect(result.current.reminders).not.toBeNull());
  rerender({ id: 'a' });
  await waitFor(() => expect(result.current.reminders).not.toBeNull());
  act(() => result.current.setReminders({ ...result.current.reminders!, reminderBeforeDueDays: '8' }));
  let pendingCurrent!: Promise<void>;
  act(() => { pendingCurrent = result.current.save(); });
  expect(result.current.saving).toBe(true);
  const calls = fetch.mock.calls.length;
  await act(async () => { oldSave.resolve(Response.json({ success: true })); await pendingOld; });
  expect(fetch).toHaveBeenCalledTimes(calls);
  expect(result.current.reminders?.reminderBeforeDueDays).toBe('8');
  expect(result.current.saving).toBe(true);
  await act(async () => { currentSave.resolve(Response.json({ success: true })); await pendingCurrent; });
  expect(result.current.saving).toBe(false);
});

it('preserves zero overrides and displays the inherited fee', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, init) => Response.json(init?.method === 'PUT'
    ? { success: true } : { autopayEnabled: true, values: { ...values, cardFeeBps: null, achFeeAmount: null },
      inherited: { ...inherited, cardFeeBps: { value: 300, source: 'partner' }, achFeeAmount: { value: '2.50', source: 'partner' } },
      effective: { ...inherited, feeAttested: true } }));
  mount();
  const card = await screen.findByTestId('autopay-card-fee-bps');
  expect(card).toHaveAttribute('placeholder', '300');
  expect(screen.queryByTestId('autopay-attest-notified')).toBeNull();
  fireEvent.change(card, { target: { value: '0' } });
  fireEvent.change(screen.getByTestId('autopay-ach-fee'), { target: { value: '0.00' } });
  fireEvent.click(screen.getByTestId('autopay-settings-save'));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(true));
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, i]) => i?.method === 'PUT')!;
  expect(JSON.parse(call[1]!.body as string)).toMatchObject({ cardFeeBps: 0, achFeeAmount: '0.00' });
});
it('requires both attestation statements when either is checked', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(Response.json({ autopayEnabled: true,
    values: { ...values, cardFeeBps: 300, achFeeAmount: '0.00' },
    inherited: { ...inherited, cardFeeBps: { value: 0, source: 'default' }, achFeeAmount: { value: '0.00', source: 'default' } },
    effective: { ...inherited, feeAttested: false } }));
  render(<I18nextProvider i18n={i18n}><PaymentsSettingsTab /></I18nextProvider>);
  fireEvent.click(await screen.findByTestId('autopay-attest-notified'));
  expect(screen.getByTestId('autopay-settings-save')).toBeDisabled();
  fireEvent.click(screen.getByTestId('autopay-attest-cost'));
  expect(screen.getByTestId('autopay-settings-save')).not.toBeDisabled();
  expect(screen.getByTestId('autopay-fee-percent')).toHaveTextContent('3.00%');
});

it('shows clients with lower authorization after Save and requests updated authorization per client',async()=>{
 const orgId='11111111-1111-4111-8111-111111111111';let saved=false;
 const gap={orgId,orgName:'Example client',methodType:'card',authorizedCardFeeBps:0,authorizedAchFeeAmount:'0.00',cardFeeBps:300,achFeeAmount:'0.00'};
 vi.mocked(fetchWithAuth).mockImplementation(async (_url,init)=>{
  if(init?.method==='POST')return Response.json({requested:[orgId],skipped:[]});
  if(init?.method==='PUT')saved=true;
  return Response.json({autopayEnabled:true,values,inherited,effective:inherited,feeAuthorizationGaps:saved?[gap]:[]});
 });
 mount();fireEvent.click(await screen.findByTestId('autopay-settings-save'));
 expect(await screen.findByTestId('autopay-fee-authorization-gaps')).toHaveTextContent('Example client');
 fireEvent.click(screen.getByTestId(`autopay-reauthorize-${orgId}`));
 await waitFor(()=>expect(vi.mocked(fetchWithAuth).mock.calls.some(([,init])=>init?.method==='POST')).toBe(true));
 const call=vi.mocked(fetchWithAuth).mock.calls.find(([,init])=>init?.method==='POST')!;
 expect(call[0]).toBe('/billing/autopay/requests');
 expect(JSON.parse(call[1]!.body as string)).toEqual({orgIds:[orgId],mode:'reauthorize'});
});
it('submits affirmative attestation only at the partner scope and clears it after saving',async()=>{
 render(<I18nextProvider i18n={i18n}><PaymentsSettingsTab /></I18nextProvider>);
 fireEvent.click(await screen.findByTestId('autopay-attest-notified'));
 fireEvent.click(screen.getByTestId('autopay-attest-cost'));
 fireEvent.click(screen.getByTestId('autopay-settings-save'));
 await waitFor(()=>expect(vi.mocked(fetchWithAuth).mock.calls.some(([,init])=>init?.method==='PUT')).toBe(true));
 const call=vi.mocked(fetchWithAuth).mock.calls.find(([,init])=>init?.method==='PUT')!;
 expect(JSON.parse(call[1]!.body as string).feeAttestation).toEqual({acquirerAndNetworksNotified30DaysAgo:true,doesNotExceedAcceptanceCost:true});
 expect(await screen.findByTestId('autopay-attest-notified')).not.toBeChecked();
});

it('does not carry partner affirmations across organization scope changes',async()=>{
 const {result,rerender}=renderHook(({id}:{id:string|undefined})=>usePaymentSettings(id),{initialProps:{id:undefined as string|undefined}});
 await waitFor(()=>expect(result.current.view).not.toBeNull());
 act(()=>result.current.setAffirmations({notified:true,cost:true}));
 rerender({id:orgB});await waitFor(()=>expect(result.current.view).not.toBeNull());
 expect(result.current.affirmations).toEqual({notified:false,cost:false});
 rerender({id:undefined});await waitFor(()=>expect(result.current.view).not.toBeNull());
 expect(result.current.affirmations).toEqual({notified:false,cost:false});
});
it.each(['25.01','-0.01','1e1','1.001','01.00'])('disables Save for invalid ACH fee %s',async value=>{
 mount();fireEvent.change(await screen.findByTestId('autopay-ach-fee'),{target:{value}});
 expect(screen.getByTestId('autopay-settings-save')).toBeDisabled();
});
