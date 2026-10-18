import { afterEach, describe, expect, it } from 'vitest';
import { defaultFrameworkView, frameworkOptionsFor, resolveFrameworkView } from './frameworks';

const KEY = 'BREEZE_TRUST_CIS_FRAMEWORK_VIEW';
afterEach(() => { delete process.env[KEY]; });

describe('framework view resolution', () => {
  it('flag unset: default is NIST CSF 2.0 and CIS is unavailable', () => {
    expect(defaultFrameworkView()).toEqual(['nist_csf_2']);
    const opts = frameworkOptionsFor({ partnerCountry: null });
    expect(opts.find((o) => o.framework === 'cis_v8')?.available).toBe(false);
    expect(opts.filter((o) => o.framework !== 'cis_v8').every((o) => o.available)).toBe(true);
  });

  it('flag on: default is CIS v8 and CIS is available', () => {
    process.env[KEY] = 'true';
    expect(defaultFrameworkView()).toEqual(['cis_v8']);
    expect(frameworkOptionsFor({ partnerCountry: null }).find((o) => o.framework === 'cis_v8')?.available).toBe(true);
  });

  it('drops CIS from a selection while the flag is off, dedupes, and uses canonical order', () => {
    expect(resolveFrameworkView(['cis_v8', 'nist_csf_2'])).toEqual(['nist_csf_2']);
    expect(resolveFrameworkView(['nist_csf_2', 'essential_eight', 'nist_csf_2'])).toEqual(['essential_eight', 'nist_csf_2']);
    process.env[KEY] = '1';
    expect(resolveFrameworkView(['nist_csf_2', 'cis_v8'])).toEqual(['cis_v8', 'nist_csf_2']);
  });

  it('suggests by partner country, case-insensitively', () => {
    const suggested = (c: string | null) => frameworkOptionsFor({ partnerCountry: c }).filter((o) => o.suggested).map((o) => o.framework);
    expect(suggested('AU')).toEqual(['essential_eight']);
    expect(suggested('au')).toEqual(['essential_eight']);
    expect(suggested('GB')).toEqual(['cyber_essentials']);
    expect(suggested('uk')).toEqual(['cyber_essentials']);
    expect(suggested('US')).toEqual([]);
    expect(suggested(null)).toEqual([]);
  });
});
