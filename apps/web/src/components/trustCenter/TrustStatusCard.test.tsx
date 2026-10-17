// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@/lib/i18n';
const scope = vi.hoisted(() => ({ value: 'organization' }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => ({ status: 'resolved', claims: { scope: scope.value } }) }));
const api = vi.hoisted(() => ({ setPartnerHome: vi.fn() }));
vi.mock('@/lib/api/trustPage', () => ({ trustPublicUrl: (p: string) => `https://breeze.test${p}`, setPartnerHome: api.setPartnerHome }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@/components/shared/Toast', () => toast);
import TrustStatusCard, { gateReasonKey } from './TrustStatusCard';
import type { TrustPageState } from '@/lib/api/trustPage';

function stateWith(reason: string | null): TrustPageState {
  return {
    page: { publishedAt: null, lastEvaluatedAt: null, isPartnerHome: false },
    slugs: { valid: true, problems: [] },
    canPublish: { allowed: false, reason },
    publicPath: '/portal/trust/a/b',
    effective: { values: { searchIndexable: false }, sources: { searchIndexable: 'default' } },
  } as unknown as TrustPageState;
}

function renderCard(reason: string | null) {
  return render(
    <TrustStatusCard orgId="o1" orgFetch={vi.fn() as never} state={stateWith(reason)} canWrite onPageChange={vi.fn()} onReload={vi.fn()} />,
  );
}

describe('TrustStatusCard gate reason', () => {
  it('maps known API reason codes to keys and unknown ones to generic', () => {
    expect(gateReasonKey('probation_default_deny')).toBe('probation_default_deny');
    expect(gateReasonKey('restricted')).toBe('restricted');
    expect(gateReasonKey('partner_unresolved')).toBe('partner_unresolved');
    expect(gateReasonKey('something_new')).toBe('generic');
    expect(gateReasonKey(null)).toBe('generic');
  });

  it('shows a translated sentence, not the raw reason code', () => {
    renderCard('probation_default_deny');
    const text = screen.getByTestId('trust-gate-notice').textContent ?? '';
    expect(text).not.toContain('probation_default_deny');
    expect(text.length).toBeGreaterThan(30);
  });

  it('falls back to the generic message for an unknown reason', () => {
    renderCard('brand_new_code');
    expect(screen.getByTestId('trust-gate-notice').textContent).not.toContain('brand_new_code');
  });
});

describe('TrustStatusCard partner-home errors (Ruling 25)', () => {
  it.each([
    ['PARTNER_HOME_INTERNAL_ONLY', /internal|own organization/i],
    ['PARTNER_HOME_UNPUBLISH_FIRST', /unpublish/i],
  ])('maps %s to translated copy, not the raw code', async (code, re) => {
    scope.value = 'partner';
    api.setPartnerHome.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'raw server text', code }), { status: 422, headers: { 'content-type': 'application/json' } }));
    renderCard(null);
    fireEvent.click(screen.getByTestId('trust-partner-home-switch'));
    await waitFor(() => expect(toast.showToast).toHaveBeenCalled());
    const msg = toast.showToast.mock.calls.map((c) => (c[0] as { message: string }).message).join(' | ');
    expect(msg).toMatch(re);
    expect(msg).not.toContain(code);
    expect(msg).not.toContain('raw server text');
    scope.value = 'organization';
    toast.showToast.mockClear();
  });
});
