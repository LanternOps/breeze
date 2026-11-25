import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_FEATURE_TYPES } from '@breeze/shared';

import { configFeatureLabel, configTargetLevelLabel } from './configPolicyLabels';
import { FEATURE_META } from './featureTabs/types';
import { ALL_FEATURE_TYPES, EFFECTIVE_FEATURE_META } from '../devices/DeviceEffectiveConfigTab';
import { i18n, loadLocale } from '../../lib/i18n';

describe('configPolicyLabels (#12306)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('every ConfigFeatureType has a label that resolves in en', async () => {
    await i18n.changeLanguage('en');
    for (const ft of CONFIG_FEATURE_TYPES) {
      const label = configFeatureLabel(ft);
      expect(label, ft).toBeTruthy();
      // An unresolved key renders as its own key path.
      expect(label, ft).not.toMatch(/featureNames|featureTabs\.|\.title$|\.label$/);
      expect(label, ft).not.toBe(ft);
    }
  });

  it('every level has a label that resolves in en', async () => {
    await i18n.changeLanguage('en');
    expect(configTargetLevelLabel('partner')).toBe('All organizations');
    expect(configTargetLevelLabel('organization')).toBe('Organization');
    expect(configTargetLevelLabel('site')).toBe('Site');
    expect(configTargetLevelLabel('device_group')).toBe('Device group');
    expect(configTargetLevelLabel('device')).toBe('Device');
    expect(configTargetLevelLabel('default')).toBe('Breeze Defaults');
  });

  it("the editor's words win over the device tab's old ones", async () => {
    await i18n.changeLanguage('en');
    expect(configFeatureLabel('patch')).toBe('Patches');
    expect(configFeatureLabel('automation')).toBe('Automations');
  });

  it('the editor and the device tab show the same label for every feature type', async () => {
    await i18n.changeLanguage('en');
    for (const ft of ALL_FEATURE_TYPES) {
      expect(EFFECTIVE_FEATURE_META[ft].label, ft).toBe(FEATURE_META[ft].label);
      expect(FEATURE_META[ft].label, ft).toBe(configFeatureLabel(ft));
    }
  });

  it('pt-BR renders a translated feature label', async () => {
    await loadLocale('pt-BR');
    await i18n.changeLanguage('pt-BR');
    expect(configFeatureLabel('patch')).not.toBe('Patches');
    expect(configFeatureLabel('patch')).not.toMatch(/featureNames/);
    expect(configTargetLevelLabel('partner')).not.toBe('All organizations');
    // The getter re-reads on a language switch.
    expect(FEATURE_META.patch.label).toBe(configFeatureLabel('patch'));
  });
});
