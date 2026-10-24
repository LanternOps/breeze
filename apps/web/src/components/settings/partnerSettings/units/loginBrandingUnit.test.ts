import '@/lib/i18n';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../../../stores/auth';
import { showToast } from '../../../shared/Toast';
import { usePartnerSettingsDraftStore } from '../partnerSettingsDraftStore';
import { loadLoginBranding, useLoginBrandingUnit, type LoginBrandingValue } from './loginBrandingUnit';

vi.mock('../../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const json = (payload: unknown, status = 200) =>
  ({ ok: status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;
const store = () => usePartnerSettingsDraftStore.getState();

beforeEach(async () => {
  vi.clearAllMocks();
  store().reset();
  store().setPartner('p1');
  vi.mocked(fetchWithAuth).mockResolvedValue(json({ data: { logoUrl: 'https://x/logo.png', accentColor: '#112233', headline: null } }));
  await store().ensureLoaded('loginBranding', loadLoginBranding);
});

describe('login page save unit', () => {
  it('loads the current branding as text fields', () => {
    expect(store().slices.loginBranding.draft).toEqual({ logoUrl: 'https://x/logo.png', accentColor: '#112233', headline: '' });
  });

  it('a failed load leaves the slice in error so a full-replace PUT can never go out over it', async () => {
    store().reset();
    store().setPartner('p1');
    vi.mocked(fetchWithAuth).mockResolvedValue(json({ error: 'down' }, 500));
    await store().ensureLoaded('loginBranding', loadLoginBranding);
    expect(store().slices.loginBranding.status).toBe('error');
    const { result } = renderHook(() => useLoginBrandingUnit());
    expect(result.current.isDirty()).toBe(false);
  });

  it('header Save sends the existing full-replace body with no per-unit success toast', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(json({ data: {} }));
    store().setDraft<LoginBrandingValue>('loginBranding', v => ({ ...v, headline: '  Welcome  ', logoUrl: ' ' }));
    const { result } = renderHook(() => useLoginBrandingUnit());
    expect(result.current.isDirty()).toBe(true);
    expect((await result.current.save()).status).toBe('saved');
    const [url, init] = vi.mocked(fetchWithAuth).mock.calls.at(-1)!;
    expect(url).toBe('/partners/me/login-branding');
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe('{"logoUrl":null,"accentColor":"#112233","headline":"Welcome"}');
    expect(vi.mocked(showToast)).not.toHaveBeenCalled();
    expect(result.current.isDirty()).toBe(false);
  });

  it('a 500 is a failed outcome, toasted once, and keeps the draft', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(json({ error: 'boom' }, 500));
    store().setDraft<LoginBrandingValue>('loginBranding', v => ({ ...v, headline: 'Hi' }));
    const { result } = renderHook(() => useLoginBrandingUnit());
    expect(await result.current.save()).toEqual({ status: 'failed' });
    expect(vi.mocked(showToast)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(result.current.isDirty()).toBe(true);
  });
});
