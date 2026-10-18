import { describe, expect, it } from 'vitest';
import {
  TRUST_BUILTIN_DEFAULTS, TRUST_SETTING_KEYS, resolveEffectiveTrustSettings, type TrustTemplateSettings,
} from './effectiveSettings';

const allNull = (): TrustTemplateSettings => Object.fromEntries(TRUST_SETTING_KEYS.map((k) => [k, null])) as TrustTemplateSettings;

describe('resolveEffectiveTrustSettings', () => {
  it.each<[string, Partial<TrustTemplateSettings>, Partial<TrustTemplateSettings> | null, Record<string, unknown>, Record<string, string>]>([
    ['page wins over template',
      { showPercentages: true, hiddenControlIds: ['dns_filtering'] }, { showPercentages: false, hiddenControlIds: ['edr_coverage'] },
      { showPercentages: true, hiddenControlIds: ['dns_filtering'] }, { showPercentages: 'page', hiddenControlIds: 'page' }],
    ['null page falls back to the template',
      {}, { showDeviceCount: true, introHtml: '<p>Template</p>' },
      { showDeviceCount: true, introHtml: '<p>Template</p>' }, { showDeviceCount: 'template', introHtml: 'template' }],
    ['both null fall back to the built-in default',
      {}, {},
      { showManagedBy: true, searchIndexable: false, showHistory: false, hiddenControlIds: [] }, { showManagedBy: 'default', searchIndexable: 'default', showHistory: 'default', hiddenControlIds: 'default' }],
    ['explicit empty page intro means "no intro", sourced from the page',
      { introHtml: '' }, { introHtml: '<p>Template</p>' },
      { introHtml: null }, { introHtml: 'page' }],
    ['no template row → defaults',
      {}, null,
      { showPercentages: false, showDeviceCount: false, introHtml: null }, { showPercentages: 'default', introHtml: 'default' }],
    ['explicit false on the page beats a true template',
      { showManagedBy: false }, { showManagedBy: true },
      { showManagedBy: false }, { showManagedBy: 'page' }],
  ])('%s', (_name, page, template, values, sources) => {
    const r = resolveEffectiveTrustSettings({ ...allNull(), ...page }, template === null ? null : { ...allNull(), ...template }, ['nist_csf_2']);
    expect(r.values).toMatchObject(values);
    expect(r.sources).toMatchObject(sources);
  });

  it('frameworkView default comes from the argument; page and template still win', () => {
    expect(resolveEffectiveTrustSettings(allNull(), null, ['cis_v8']).values.frameworkView).toEqual(['cis_v8']);
    expect(resolveEffectiveTrustSettings(allNull(), null, ['cis_v8']).sources.frameworkView).toBe('default');
    expect(resolveEffectiveTrustSettings(allNull(), { ...allNull(), frameworkView: ['essential_eight'] }, ['cis_v8']).values.frameworkView).toEqual(['essential_eight']);
    expect(resolveEffectiveTrustSettings({ ...allNull(), frameworkView: [] }, null, ['cis_v8']).values.frameworkView).toEqual([]);
  });

  it('reports a source for every key and never aliases the default arrays', () => {
    const r = resolveEffectiveTrustSettings(allNull(), null, ['nist_csf_2']);
    expect(Object.keys(r.sources).sort()).toEqual([...TRUST_SETTING_KEYS].sort());
    r.values.hiddenControlIds.push('dns_filtering');
    expect(TRUST_BUILTIN_DEFAULTS.hiddenControlIds).toEqual([]);
  });

  it('built-in defaults match W1 (§18.4: percentages and device count off, managed-by on)', () => {
    expect(TRUST_BUILTIN_DEFAULTS).toEqual({
      introHtml: null, searchIndexable: false, showPercentages: false, showDeviceCount: false, showManagedBy: true, showHistory: false, hiddenControlIds: [],
    });
  });
});
