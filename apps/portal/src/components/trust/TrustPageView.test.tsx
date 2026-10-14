// @vitest-environment jsdom
// apps/portal/src/components/trust/TrustPageView.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import TrustPageView from './TrustPageView';

// @/lib/api -> lib/navigation dynamically imports an Astro virtual module vitest cannot resolve.
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const payload = {
  schemaVersion: 1, snapshotId: 's1', generatedAt: '2026-10-13T12:00:00.000Z', publishedAt: '2026-10-01T09:00:00.000Z',
  org: { name: 'Acme Dental', logoUrl: null, primaryColor: '#123456', websiteUrl: 'https://acme.example', securityContactEmail: 'security@acme.example' },
  managedBy: { name: 'Northwind IT', logoUrl: null, websiteUrl: 'https://northwind.example' },
  introHtml: '<p>We take <strong>security</strong> seriously.</p>',
  summary: { catalogTotal: 15, controlsShown: 3, controlsMet: 1, deviceCount: 50 },
  methodology: { catalogVersion: '2026-10-13.1', evidenceMaxAgeDays: 30, definitionsMaxAgeDays: 7, coverageFloorPct: 80, thresholds: { met: 95, attention: 80 }, eligibilityNote: 'Eligible devices are…' },
  controls: [
    { id: 'disk_encryption', category: 'data_protection', source: 'telemetry', unit: 'devices', status: 'met', reason: null, percent: 98, assessed: 46, eligible: 50, evidenceAsOf: '2026-10-13T11:00:00.000Z', frameworkRefs: [{ framework: 'cis_v8', ref: '3.6' }] },
    { id: 'host_firewall', category: 'endpoint_protection', source: 'telemetry', unit: 'devices', status: 'not_assessed', reason: 'insufficient_telemetry', percent: null, assessed: null, eligible: null, evidenceAsOf: null, frameworkRefs: [{ framework: 'cis_v8', ref: '4.5' }] },
    { id: 'mfa_registered_m365', category: 'identity_access', source: 'telemetry', unit: 'users', status: 'attention', reason: null, percent: 90, assessed: 48, eligible: 50, evidenceAsOf: '2026-10-13T06:00:00.000Z', frameworkRefs: [{ framework: 'essential_eight', ref: 'mfa' }] },
  ],
  documents: [{ id: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d', title: 'Security policy', category: 'policy', contentType: 'application/pdf', byteSize: 123456, updatedAt: '2026-09-01T00:00:00.000Z', visibility: 'public' }],
  footer: { poweredByBreeze: true, frameworkAttributions: ['cis_v8', 'essential_eight'] },
} as const;
const initial = { payload, lastEvaluatedAt: '2026-10-13T11:30:00.000Z', stale: false };

describe('TrustPageView', () => {
  it('renders header, summary, grouped controls with pills, coverage notes, chips, method, documents, managed-by and footer', () => {
    render(<TrustPageView partnerSlug="nw" orgSlug="acme" card={null} initial={initial as never} />);
    expect(screen.getByRole('heading', { level: 1, name: /Acme Dental/ })).toBeInTheDocument();
    expect(screen.getByText(/Showing 3 of 15 Breeze-verifiable controls/)).toBeInTheDocument();
    expect(screen.getByText(/publisher-selected/i)).toBeInTheDocument();
    const enc = screen.getByTestId('trust-control-disk_encryption');
    expect(within(enc).getByText('Met')).toBeInTheDocument();
    expect(within(enc).getByText('46 of 50 devices assessed')).toBeInTheDocument();
    expect(within(enc).getByText('CIS v8 3.6 · IG1')).toBeInTheDocument();
    const fw = screen.getByTestId('trust-control-host_firewall');
    expect(within(fw).getByText('Not assessed')).toBeInTheDocument();
    expect(within(fw).getByText(/Fewer than 80%/)).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText(/not a certification/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Security policy/ })).toHaveAttribute('href', '/api/v1/trust/public/nw/acme/documents/0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d');
    expect(screen.getByText(/Managed by/)).toBeInTheDocument();
    expect(screen.getByText(/Powered by Breeze/)).toBeInTheDocument();
    expect(screen.getByText(/CIS Controls® are a registered trademark/)).toBeInTheDocument();
    expect(screen.getByText(/security@acme.example/)).toBeInTheDocument();
  });
  it('renders server-sanitized intro HTML', () => {
    render(<TrustPageView partnerSlug="nw" orgSlug="acme" card={null} initial={{ ...initial, payload: { ...payload, introHtml: '<p>Hi</p>' } } as never} />);
    expect(screen.getByText('Hi')).toBeInTheDocument();
    expect(screen.getByText('Hi').parentElement!.innerHTML).toBe('<p>Hi</p>');
  });
  it('not-assessed users control says users; preview mode shows document titles as plain text', () => {
    const users = { ...payload.controls[2], status: 'not_assessed', reason: 'insufficient_telemetry', percent: null, assessed: null, eligible: null };
    render(<TrustPageView partnerSlug={null} orgSlug={null} card={null} previewToken="t" initial={{ ...initial, payload: { ...payload, controls: [users] } } as never} />);
    expect(within(screen.getByTestId('trust-control-mfa_registered_m365')).getByText(/eligible users reported/)).toBeInTheDocument();
    expect(screen.getByText('Security policy').tagName).toBe('SPAN');
    expect(screen.queryByText('Download')).toBeNull();
  });
  it('stale → "Verification paused" banner and muted pills', () => {
    render(<TrustPageView partnerSlug="nw" orgSlug="acme" card={null} initial={{ ...initial, stale: true, lastEvaluatedAt: '2026-10-11T00:00:00.000Z' } as never} />);
    expect(screen.getByText(/Verification paused since/)).toBeInTheDocument();
    expect(screen.getByTestId('trust-controls')).toHaveAttribute('data-stale', 'true');
  });
  it('hides the footer badge when unbranded, hides documents section when empty', () => {
    render(<TrustPageView partnerSlug="nw" orgSlug="acme" card={null} initial={{ ...initial, payload: { ...payload, documents: [], footer: { poweredByBreeze: false, frameworkAttributions: [] } } } as never} />);
    expect(screen.queryByText(/Powered by Breeze/)).toBeNull();
    expect(screen.queryByTestId('trust-documents')).toBeNull();
  });
  it('fetches client-side when no initial data, shows the generic error on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }), { status: 404 })));
    render(<TrustPageView partnerSlug="nw" orgSlug="nope" card={null} />);
    expect(await screen.findByTestId('trust-page-error')).toHaveTextContent(/isn’t available|not available/i);
    vi.unstubAllGlobals();
  });
});
