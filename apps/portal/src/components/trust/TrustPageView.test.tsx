// @vitest-environment jsdom
// apps/portal/src/components/trust/TrustPageView.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import TrustPageView from './TrustPageView';

// @/lib/api -> lib/navigation dynamically imports an Astro virtual module vitest cannot resolve.
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
// W2 section seams: each stub records its props and its render order (the real stubs render nothing).
const seen = vi.hoisted(() => ({ order: [] as string[], props: {} as Record<string, unknown>, hardening: [] as string[] }));
vi.mock('./TrustDeclaredControls', () => ({ default: (p: unknown) => { seen.order.push('declared'); seen.props.declared = p; return <div data-testid="seam-declared" />; } }));
vi.mock('./TrustFrameworkView', () => ({ default: (p: unknown) => { seen.order.push('frameworks'); seen.props.frameworks = p; return <div data-testid="seam-frameworks" />; } }));
vi.mock('./TrustSubprocessors', () => ({ default: (p: unknown) => { seen.order.push('subprocessors'); return <div data-testid="seam-subprocessors" />; } }));
vi.mock('./TrustFaq', () => ({ default: (p: unknown) => { seen.order.push('faq'); seen.props.faq = p; return <div data-testid="seam-faq" />; } }));
vi.mock('./HardeningSafeguards', () => ({ default: (p: { control: { id: string } }) => { seen.hardening.push(p.control.id); return <div data-testid="seam-hardening-safeguards" />; } }));
vi.mock('./TrustHistory', () => ({ default: (p: unknown) => { seen.order.push('history'); return <div data-testid="seam-history" />; } }));

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
  it('I12: a partner-home page (org slug null) links documents to the partner-home document route', () => {
    render(<TrustPageView partnerSlug="nw" orgSlug={null} card={null} initial={initial as never} />);
    expect(screen.getByRole('link', { name: /Security policy/ })).toHaveAttribute('href', '/api/v1/trust/public/nw/documents/0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d');
    expect(screen.getByText('Download')).toBeInTheDocument();
  });
  it('a preview never links documents, even when a partner slug is known', () => {
    render(<TrustPageView partnerSlug="nw" orgSlug={null} card={null} previewToken="t" initial={initial as never} />);
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
    // The non-certification disclaimer is not branding: it renders on unbranded pages too.
    expect(screen.getByText(/Not a SOC 2, ISO or CIS attestation/)).toBeInTheDocument();
    expect(screen.queryByTestId('trust-documents')).toBeNull();
  });
  it('fetches client-side when no initial data, shows the generic error on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }), { status: 404 })));
    render(<TrustPageView partnerSlug="nw" orgSlug="nope" card={null} />);
    expect(await screen.findByTestId('trust-page-error')).toHaveTextContent(/isn’t available|not available/i);
    vi.unstubAllGlobals();
  });

  describe('W2 seams', () => {
    it('a v1 payload renders normalized, and the section seams render in plan order with the v2 payload', () => {
      seen.order = []; seen.props = {};
      render(<TrustPageView partnerSlug="nw" orgSlug="acme" card={null} initial={initial as never} />);
      expect(seen.order).toEqual(['declared', 'frameworks', 'subprocessors', 'faq', 'history']);
      const faq = seen.props.faq as { payload: { schemaVersion: number; locale: string; faq: unknown[] }; preview: boolean; partnerSlug: string; orgSlug: string };
      expect(faq.payload).toMatchObject({ schemaVersion: 2, locale: 'en', faq: [] });
      expect(faq).toMatchObject({ preview: false, partnerSlug: 'nw', orgSlug: 'acme' });
      // DOM order: controls → declared → frameworks → method → documents → subprocessors → faq → history → managed-by.
      const ids = ['trust-controls', 'seam-declared', 'seam-frameworks', 'trust-documents', 'seam-subprocessors', 'seam-faq', 'seam-history'];
      const nodes = ids.map((id) => screen.getByTestId(id));
      for (let i = 1; i < nodes.length; i++) {
        expect(nodes[i - 1]!.compareDocumentPosition(nodes[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `${ids[i - 1]} before ${ids[i]}`).toBeTruthy();
      }
    });
    it('a gated document lists its title as "Available on request" with no download link', () => {
      const gatedId = '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6e';
      const v2 = {
        ...payload, schemaVersion: 2, locale: 'en', declaredControls: [], frameworks: [], subprocessors: [], faq: [], history: [], access: { ndaText: null },
        documents: [...payload.documents, { ...payload.documents[0], id: gatedId, title: 'Pen test report', visibility: 'gated' }],
      };
      render(<TrustPageView partnerSlug="nw" orgSlug="acme" card={null} initial={{ ...initial, payload: v2 } as never} />);
      const row = screen.getByTestId(`trust-document-${gatedId}`);
      expect(within(row).getByText('Pen test report')).toBeInTheDocument();
      expect(within(row).getByTestId(`trust-document-on-request-${gatedId}`)).toHaveTextContent('Available on request');
      expect(within(row).queryByRole('link')).toBeNull();
      expect(screen.getByRole('link', { name: /Security policy/ })).toBeInTheDocument();
    });
    it('a preview never links documents', () => {
      render(<TrustPageView partnerSlug="nw" orgSlug="acme" card={null} previewToken="tok" initial={{ ...initial, preview: true } as never} />);
      expect(screen.queryByRole('link', { name: /Security policy/ })).toBeNull();
    });
  });

  describe('locale (W02h)', () => {
    const de = { ...payload, schemaVersion: 2, locale: 'de-DE', declaredControls: [], frameworks: [], subprocessors: [], faq: [], history: [], access: null,
      documents: payload.documents.map((d) => ({ ...d })) };
    it('a de-DE payload renders the German header summary, status pill and method block', () => {
      render(<TrustPageView partnerSlug="nw" orgSlug="acme" card={null} initial={{ ...initial, payload: de } as never} />);
      expect(screen.getByText(/3 von 15 mit Breeze überprüfbaren Kontrollen/)).toBeInTheDocument();
      const enc = screen.getByTestId('trust-control-disk_encryption');
      expect(within(enc).getByText('Festplattenverschlüsselung')).toBeInTheDocument();
      expect(within(enc).getByText('Erfüllt')).toBeInTheDocument();
      expect(screen.getByText('So wird diese Seite überprüft')).toBeInTheDocument();
      expect(screen.queryByText(/Showing 3 of 15/)).toBeNull();
    });
    it('an unknown payload locale falls back to English', () => {
      render(<TrustPageView partnerSlug="nw" orgSlug="acme" card={null} initial={{ ...initial, payload: { ...de, locale: 'xx-XX' } } as never} />);
      expect(screen.getByText(/Showing 3 of 15 Breeze-verifiable controls/)).toBeInTheDocument();
      expect(screen.getByText('Disk encryption')).toBeInTheDocument();
    });
  });

  describe('hardening safeguards (W03e)', () => {
    const hardeningControl = { id: 'hardening_baseline', category: 'patching_hardening', source: 'telemetry', unit: 'devices', status: 'met', reason: null, percent: null, assessed: null, eligible: null, evidenceAsOf: null, frameworkRefs: [{ framework: 'cis_v8', ref: '4.1' }] };
    it('mounts the safeguards disclosure only for hardening_baseline', () => {
      seen.hardening.length = 0;
      const withHardening = { ...initial, payload: { ...payload, controls: [...payload.controls, hardeningControl] } };
      render(<TrustPageView partnerSlug="nw" orgSlug="acme" card={null} initial={withHardening as never} />);
      expect(seen.hardening).toEqual(['hardening_baseline']);
      expect(within(screen.getByTestId('trust-control-hardening_baseline')).getByTestId('seam-hardening-safeguards')).toBeInTheDocument();
      expect(within(screen.getByTestId('trust-control-disk_encryption')).queryByTestId('seam-hardening-safeguards')).toBeNull();
    });
  });
});
