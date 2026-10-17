// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { summarizeFrameworkCoverage, type TrustPagePublicPayload } from '@breeze/shared';
import TrustFrameworkView from './TrustFrameworkView';
import { frameworkCopy } from './frameworkCopy';
import { copyParityProblems } from './trustCopy';

const payload = {
  schemaVersion: 2, locale: 'en',
  frameworks: ['nist_csf_2', 'essential_eight'],
  controls: [
    { id: 'mfa_registered_m365', category: 'identity_access', source: 'telemetry', unit: 'users', status: 'met', reason: null, percent: 99, assessed: 5, eligible: 5, evidenceAsOf: null,
      frameworkRefs: [{ framework: 'nist_csf_2', ref: 'PR.AA-03' }, { framework: 'essential_eight', ref: 'mfa' }] },
    { id: 'host_firewall', category: 'endpoint_protection', source: 'telemetry', unit: 'devices', status: 'not_assessed', reason: 'no_data', percent: null, assessed: null, eligible: null, evidenceAsOf: null,
      frameworkRefs: [{ framework: 'nist_csf_2', ref: 'PR.PS-01' }] },
  ],
  declaredControls: [
    { id: 'incident_response_plan', category: 'governance', source: 'declared', status: 'current', statement: 's', declaredBy: 'A', declaredAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', evidenceDocumentId: null,
      frameworkRefs: [{ framework: 'nist_csf_2', ref: 'RS.MA-01' }] },
  ],
} as unknown as TrustPagePublicPayload;

const props = (p: TrustPagePublicPayload) => ({ payload: p, lastEvaluatedAt: null, preview: false, partnerSlug: 'nw', orgSlug: 'acme' });

beforeEach(() => { window.location.hash = ''; });
afterEach(() => { window.location.hash = ''; });

describe('TrustFrameworkView', () => {
  it('renders nothing when no framework is selected', () => {
    const { container } = render(<TrustFrameworkView {...props({ ...payload, frameworks: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('summary numbers come from summarizeFrameworkCoverage', () => {
    render(<TrustFrameworkView {...props(payload)} />);
    const c = summarizeFrameworkCoverage(payload, 'nist_csf_2');
    expect(c).toMatchObject({ evidenced: 2, verified: 1, declaredOnly: 1, total: 106 });
    const text = screen.getByTestId('trust-framework-summary').textContent ?? '';
    expect(text).toContain('Evidence shown for 2 of 106 safeguards');
    expect(text).toContain('1 verified by Breeze telemetry');
    expect(text).toContain('1 declared by the provider');
  });

  it('shows one tab per framework and switches the summary', () => {
    render(<TrustFrameworkView {...props(payload)} />);
    expect(screen.getByTestId('trust-framework-tab-nist_csf_2')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('trust-framework-tab-essential_eight'));
    expect(screen.getByTestId('trust-framework-summary').textContent).toContain('1 of 8 safeguards');
    expect(window.location.hash).toBe('#framework-essential_eight');
  });

  it('restores the tab from the hash on mount', () => {
    window.location.hash = '#framework-essential_eight';
    render(<TrustFrameworkView {...props(payload)} />);
    expect(screen.getByTestId('trust-framework-tab-essential_eight')).toHaveAttribute('aria-selected', 'true');
  });

  it('never claims compliance, certification or IG1', () => {
    render(<TrustFrameworkView {...props(payload)} />);
    const text = screen.getByTestId('trust-framework-view').textContent ?? '';
    expect(text).not.toMatch(/compliant|certified|meets IG1/i);
    expect(text).toMatch(/not a statement of compliance/i);
  });

  it('renders the attribution line of the selected framework', () => {
    render(<TrustFrameworkView {...props(payload)} />);
    expect(screen.getByTestId('trust-framework-view').textContent).toContain('NIST CSF 2.0 is a work of the U.S. Government');
  });
});

describe('frameworkCopy', () => {
  it('has the same keys in every locale', () => {
    expect(copyParityProblems(frameworkCopy)).toEqual([]);
  });
});
