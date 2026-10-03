// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { apiGet, apiPost } from '@/lib/api';
vi.mock('@/lib/api', () => ({apiGet:vi.fn(),apiPost:vi.fn()}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
import AutopayActionPage from './AutopayActionPage';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('loads a scanner-safe GET and changes state only after an explicit click', async () => {
 vi.mocked(apiGet).mockResolvedValue({data:{state:'scheduled'}});
 render(<AutopayActionPage token="opaque-token" action="skip" />);
 await screen.findByTestId('autopay-skip-submit');expect(apiPost).not.toHaveBeenCalled();
 vi.mocked(apiPost).mockResolvedValue({data:{status:'skipped'}});
 fireEvent.click(screen.getByTestId('autopay-skip-submit'));
 await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/autopay/public/opaque-token/skip', {}, {redirectOnUnauthorized:false}));
 expect((await screen.findByTestId('autopay-action-result')).textContent).toContain('skipped');
});
it('surfaces a rejected skip and retains the action', async () => {
 vi.mocked(apiGet).mockResolvedValue({data:{state:'processing'}});
 vi.mocked(apiPost).mockResolvedValue({error:'A payment is already processing',statusCode:409});
 render(<AutopayActionPage token="opaque-token" action="skip" />);
 fireEvent.click(await screen.findByTestId('autopay-skip-submit'));
 await waitFor(() => expect(screen.getByTestId('autopay-action-result').textContent).toContain('already processing'));
 expect((screen.getByTestId('autopay-skip-submit') as HTMLButtonElement).disabled).toBe(false);
});
it('reports pending cancellation without claiming a completed skip',async()=>{
 vi.mocked(apiGet).mockResolvedValue({data:{state:'scheduled'}});vi.mocked(apiPost).mockResolvedValue({data:{status:'pending',control:'skip'}});
 render(<AutopayActionPage token="token" action="skip"/>);fireEvent.click(await screen.findByTestId('autopay-skip-submit'));
 await waitFor(()=>expect(screen.getByTestId('autopay-action-result').textContent).toContain('Skip requested'));
 expect(screen.queryByTestId('autopay-skip-submit')).toBeNull();
});
it('does not offer a mutation for unavailable links',async()=>{vi.mocked(apiGet).mockResolvedValue({error:'Unavailable',statusCode:404});render(<AutopayActionPage token="token" action="skip"/>);await screen.findByTestId('autopay-action-result');expect(screen.queryByTestId('autopay-skip-submit')).toBeNull();expect(apiPost).not.toHaveBeenCalled();});

it('Confirm requires a click and reports processing without another payment',async()=>{
 vi.mocked(apiGet).mockResolvedValue({data:{state:'requires_action',amount:'100.00',currency:'USD'}});
 vi.mocked(apiPost).mockResolvedValue({data:{processing:true}});
 render(<AutopayActionPage token="token" action="confirm"/>);
 const button=await screen.findByTestId('autopay-confirm-submit');expect(apiPost).not.toHaveBeenCalled();fireEvent.click(button);
 await waitFor(()=>expect(screen.getByTestId('autopay-action-result').textContent).toContain('Payment is processing'));
 expect(screen.queryByTestId('autopay-confirm-submit')).toBeNull();
});

it('lands a cancelled confirmation without offering a payment action',async()=>{
 vi.mocked(apiGet).mockResolvedValue({data:{state:'not_needed'}});
 render(<AutopayActionPage token="token" action="confirm"/>);
 expect((await screen.findByTestId('autopay-action-result')).textContent).toContain('no longer needed');
 expect(screen.queryByTestId('autopay-confirm-submit')).toBeNull();expect(apiPost).not.toHaveBeenCalled();
});
it('lands a cancellation between GET and POST without navigating to pay',async()=>{
 vi.mocked(apiGet).mockResolvedValue({data:{state:'requires_action'}});
 vi.mocked(apiPost).mockResolvedValue({data:{notNeeded:true}});
 render(<AutopayActionPage token="token" action="confirm"/>);
 fireEvent.click(await screen.findByTestId('autopay-confirm-submit'));
 await waitFor(()=>expect(screen.getByTestId('autopay-action-result').textContent).toContain('no longer needed'));
 expect(screen.queryByTestId('autopay-confirm-submit')).toBeNull();
});
