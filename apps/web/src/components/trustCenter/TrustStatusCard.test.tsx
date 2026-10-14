// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@/lib/i18n';
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'organization' } }) }));
vi.mock('@/lib/api/trustPage', () => ({ trustPublicUrl: (p: string) => `https://breeze.test${p}` }));
import TrustStatusCard, { gateReasonKey } from './TrustStatusCard';
import type { TrustPageState } from '@/lib/api/trustPage';

function stateWith(reason: string | null): TrustPageState {
  return {
    page: { publishedAt: null, lastEvaluatedAt: null, isPartnerHome: false },
    slugs: { valid: true, problems: [] },
    canPublish: { allowed: false, reason },
    publicPath: '/portal/trust/a/b',
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
