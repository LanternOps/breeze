// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FRAMEWORK_CROSSWALK, trustCopyFor, type TrustPagePublicControl } from '@breeze/shared';
import HardeningSafeguards from './HardeningSafeguards';
import { hardeningSafeguardsCopy } from './hardeningSafeguardsCopy';
import { TrustLocaleContext, copyParityProblems } from './trustCopy';

const sg = (ref: string, over: Record<string, unknown> = {}) => ({ framework: 'cis_v8', ref, status: 'met', reason: null, percent: null, assessed: null, eligible: null, ...over });
const control = (over: Record<string, unknown> = {}) => ({
  id: 'hardening_baseline', category: 'patching_hardening', source: 'telemetry', unit: 'devices', status: 'met', reason: null,
  percent: null, assessed: null, eligible: null, evidenceAsOf: null, frameworkRefs: [{ framework: 'cis_v8', ref: '4.1' }],
  ...over,
}) as unknown as TrustPagePublicControl;

describe('HardeningSafeguards', () => {
  it('renders a collapsed disclosure with the count, one row per safeguard in the given order', () => {
    render(<HardeningSafeguards control={control({ safeguards: [sg('4.5'), sg('4.8', { status: 'attention' }), sg('10.5', { status: 'not_assessed', reason: 'no_data' })] })} />);
    const details = screen.getByTestId('trust-hardening-safeguards') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByTestId('trust-hardening-safeguards-toggle').textContent).toBe('Safeguards evidenced by hardening checks (3)');
    const row = screen.getByTestId('trust-hardening-safeguard-4.8').textContent ?? '';
    expect(row).toContain('CIS v8 4.8');
    expect(row).toContain(FRAMEWORK_CROSSWALK.cis_v8['4.8']!.label);
    expect(row).toContain('Needs attention');
    expect(screen.getByTestId('trust-hardening-safeguard-10.5').textContent).toContain('Not assessed');
  });

  it('shows the coverage note only when the numbers are present', () => {
    render(<HardeningSafeguards control={control({ safeguards: [sg('4.5', { percent: 100, assessed: 11, eligible: 12 }), sg('4.8')] })} />);
    expect(screen.getByTestId('trust-hardening-safeguard-4.5').textContent).toMatch(/11 of 12/);
    expect(screen.getByTestId('trust-hardening-safeguard-4.8').textContent).not.toMatch(/\d+ of \d+/);
  });

  it('renders nothing — no rows, no disclosure — when safeguards is absent or empty', () => {
    const a = render(<HardeningSafeguards control={control()} />);
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    const b = render(<HardeningSafeguards control={control({ safeguards: [] })} />);
    expect(b.container).toBeEmptyDOMElement();
  });

  it('renders nothing on any other control, even if one somehow carries safeguards', () => {
    const { container } = render(<HardeningSafeguards control={control({ id: 'host_firewall', safeguards: [sg('4.5')] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('labels come from the shared copy, never the payload (a hostile label field is ignored)', () => {
    render(<HardeningSafeguards control={control({ safeguards: [{ ...sg('4.5'), label: 'Ensure something verbatim' }] })} />);
    const text = screen.getByTestId('trust-hardening-safeguards').textContent ?? '';
    expect(text).not.toContain('Ensure something verbatim');
    expect(text).toContain(FRAMEWORK_CROSSWALK.cis_v8['4.5']!.label);
  });

  it('localizes the heading, labels and statuses to the page locale', () => {
    render(<TrustLocaleContext.Provider value="de-DE"><HardeningSafeguards control={control({ safeguards: [sg('4.5')] })} /></TrustLocaleContext.Provider>);
    expect(screen.getByTestId('trust-hardening-safeguards-toggle').textContent).toBe('Durch Härtungsprüfungen belegte Schutzmaßnahmen (1)');
    expect(screen.getByTestId('trust-hardening-safeguard-4.5').textContent).toContain(trustCopyFor('de-DE').crosswalk.cis_v8['4.5']);
  });

  it('never claims compliance, certification or IG1; says it is partial', () => {
    render(<HardeningSafeguards control={control({ safeguards: [sg('4.5')] })} />);
    const text = screen.getByTestId('trust-hardening-safeguards').textContent ?? '';
    expect(text).not.toMatch(/compliant|certified|meets IG1/i);
    expect(screen.getByTestId('trust-hardening-safeguards-note').textContent).toMatch(/partial.*not a statement of compliance/i);
  });
});

describe('hardeningSafeguardsCopy', () => {
  it('has the same keys in every locale and no empty strings', () => {
    expect(copyParityProblems(hardeningSafeguardsCopy)).toEqual([]);
  });
});
