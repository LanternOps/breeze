import { describe, expect, it } from 'vitest';
import { summarizeFrameworkCoverage } from './frameworkCoverage';
import type { TrustPagePublicPayload } from '../validators/trustCenter';

type Ctl = TrustPagePublicPayload['controls'][number];
type Dec = TrustPagePublicPayload['declaredControls'][number];

const tele = (id: Ctl['id'], status: Ctl['status'], refs: Array<[string, string]>): Ctl => ({
  id, category: 'identity_access', source: 'telemetry', unit: 'users', status,
  reason: status === 'not_assessed' ? 'no_data' : null, percent: status === 'not_assessed' ? null : 100,
  assessed: 1, eligible: 1, evidenceAsOf: null,
  frameworkRefs: refs.map(([framework, ref]) => ({ framework: framework as never, ref })),
});
const decl = (id: Dec['id'], status: Dec['status'], refs: Array<[string, string]>): Dec => ({
  id, category: 'governance', source: 'declared', status, statement: 's', declaredBy: 'x',
  declaredAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', evidenceDocumentId: null,
  frameworkRefs: refs.map(([framework, ref]) => ({ framework: framework as never, ref })),
});
const payload = (controls: Ctl[], declaredControls: Dec[]) => ({ controls, declaredControls }) as unknown as TrustPagePublicPayload;

describe('summarizeFrameworkCoverage', () => {
  it('counts assessed telemetry and lists non-counting declared refs', () => {
    const p = payload(
      [tele('mfa_registered_m365', 'met', [['cis_v8', '6.3'], ['cis_v8', '6.5']])],
      [decl('incident_response_plan', 'expired', [['cis_v8', '17.1'], ['cis_v8', '17.2'], ['cis_v8', '17.3']])],
    );
    const c = summarizeFrameworkCoverage(p, 'cis_v8');
    expect(c).toMatchObject({ total: 153, evidenced: 2, verified: 2, declaredOnly: 0 });
    expect(c.safeguards.map((s) => s.ref)).toEqual(['6.3', '6.5', '17.1', '17.2', '17.3']);
    expect(c.safeguards.find((s) => s.ref === '17.1')!.controls).toEqual([
      { id: 'incident_response_plan', source: 'declared', status: 'expired', counts: false },
    ]);
  });

  it('a safeguard evidenced only via hardening safeguards counts once (W3e); not_assessed ones do not', () => {
    const hardening: Ctl = {
      ...tele('hardening_baseline', 'met', [['cis_v8', '4.1']]),
      safeguards: [
        { framework: 'cis_v8', ref: '4.8', status: 'met', reason: null, percent: null, assessed: null, eligible: null },
        { framework: 'cis_v8', ref: '4.5', status: 'attention', reason: null, percent: null, assessed: null, eligible: null },
        { framework: 'cis_v8', ref: '8.5', status: 'not_assessed', reason: 'no_data', percent: null, assessed: null, eligible: null },
      ],
    };
    // host_firewall also references 4.5: the ref is evidenced once, by two controls.
    const p = payload([hardening, tele('host_firewall', 'met', [['cis_v8', '4.5']])], []);
    const c = summarizeFrameworkCoverage(p, 'cis_v8');
    expect(c).toMatchObject({ evidenced: 3, verified: 3, declaredOnly: 0 }); // 4.1, 4.5, 4.8 — not 8.5
    expect(c.safeguards.map((s) => s.ref)).toEqual(['4.1', '4.5', '4.8', '8.5']);
    expect(c.safeguards.find((s) => s.ref === '4.5')!.controls.map((x) => x.id)).toEqual(['hardening_baseline', 'host_firewall']);
    expect(c.safeguards.find((s) => s.ref === '8.5')!.controls[0]).toMatchObject({ counts: false });
    // Another framework's view ignores them.
    expect(summarizeFrameworkCoverage(p, 'nist_csf_2').safeguards).toEqual([]);
  });

  it('a not-assessed control does not count', () => {
    const c = summarizeFrameworkCoverage(payload([tele('mfa_registered_m365', 'not_assessed', [['cis_v8', '6.3']])], []), 'cis_v8');
    expect(c.evidenced).toBe(0);
    expect(c.safeguards).toHaveLength(1);
  });

  it('a current declaration counts as declaredOnly; telemetry on the same ref makes it verified', () => {
    const p = payload(
      [tele('mfa_registered_m365', 'attention', [['cis_v8', '6.3']])],
      [decl('access_review', 'current', [['cis_v8', '6.3'], ['cis_v8', '5.1']])],
    );
    expect(summarizeFrameworkCoverage(p, 'cis_v8')).toMatchObject({ evidenced: 2, verified: 1, declaredOnly: 1 });
  });

  it('sorts refs naturally', () => {
    const p = payload([], [
      decl('access_review', 'current', [['cis_v8', '10.1'], ['cis_v8', '5.4'], ['nist_csf_2', 'PR.AA-03'], ['nist_csf_2', 'PR.AA-01']]),
    ]);
    expect(summarizeFrameworkCoverage(p, 'cis_v8').safeguards.map((s) => s.ref)).toEqual(['5.4', '10.1']);
    expect(summarizeFrameworkCoverage(p, 'nist_csf_2').safeguards.map((s) => s.ref)).toEqual(['PR.AA-01', 'PR.AA-03']);
  });

  it('totals per framework', () => {
    const p = payload([], []);
    expect(['cis_v8', 'nist_csf_2', 'essential_eight', 'cyber_essentials'].map((f) => summarizeFrameworkCoverage(p, f as never).total))
      .toEqual([153, 106, 8, 5]);
  });
});
