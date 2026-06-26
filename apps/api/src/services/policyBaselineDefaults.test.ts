import { describe, it, expect, vi } from 'vitest';
import { CONFIG_FEATURE_TYPES } from './configurationPolicy';
import { getPolicyBaselineDefaults, getRemoteAccessBaseline, getPamBaseline } from './policyBaselineDefaults';
import { PAM_DEFAULTS } from '../routes/agents/pamSettings';
import { configFeatureTypeEnum } from '../db/schema/configurationPolicies';

describe('policyBaselineDefaults', () => {
  it('has exactly one entry per ConfigFeatureType', () => {
    const entries = getPolicyBaselineDefaults();
    const types = entries.map((e) => e.featureType).sort();
    expect(types).toEqual([...CONFIG_FEATURE_TYPES].sort());
    expect(entries.length).toBe(CONFIG_FEATURE_TYPES.length);
  });

  it('marks remote_access as applied with desktop/vnc/tools ON', () => {
    const entry = getPolicyBaselineDefaults().find((e) => e.featureType === 'remote_access')!;
    expect(entry.applied).toBe(true);
    expect(entry.inlineSettings).toMatchObject({ webrtcDesktop: true, vncRelay: true, remoteTools: true });
  });

  it('marks pam as applied with UAC interception OFF (opt-in)', () => {
    const entry = getPolicyBaselineDefaults().find((e) => e.featureType === 'pam')!;
    expect(entry.applied).toBe(true);
    expect(entry.inlineSettings).toEqual({ uacInterceptionEnabled: false });
  });

  it('marks patch (and other unenforced features) as not applied', () => {
    const entry = getPolicyBaselineDefaults().find((e) => e.featureType === 'patch')!;
    expect(entry.applied).toBe(false);
    expect(entry.inlineSettings).toBeNull();
    expect(entry.behavior.length).toBeGreaterThan(0);
  });

  it('getRemoteAccessBaseline returns the full settings shape', () => {
    const s = getRemoteAccessBaseline();
    expect(s.webrtcDesktop).toBe(true);
    expect(s.maxConcurrentTunnels).toBe(5);
    expect(s.idleTimeoutMinutes).toBe(5);
    expect(s.maxSessionDurationHours).toBe(8);
  });

  it('getPamBaseline returns UAC off', () => {
    expect(getPamBaseline()).toEqual({ uacInterceptionEnabled: false });
  });
});

describe('pam defaults single source of truth', () => {
  it('PAM_DEFAULTS equals the canonical pam baseline', () => {
    expect(PAM_DEFAULTS).toEqual(getPamBaseline());
  });
});

describe('getRemoteAccessBaseline IS_HOSTED clipboard branching', () => {
  it('clipboardHostToViewer is false when IS_HOSTED=true', async () => {
    const saved = process.env.IS_HOSTED;
    try {
      process.env.IS_HOSTED = 'true';
      vi.resetModules();
      const { getRemoteAccessBaseline: fresh } = await import('./policyBaselineDefaults');
      const s = fresh();
      expect(s.clipboardHostToViewer).toBe(false);
      expect(s.clipboardViewerToHost).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.IS_HOSTED;
      else process.env.IS_HOSTED = saved;
      vi.resetModules();
    }
  });

  it('clipboardHostToViewer is true when IS_HOSTED is unset', async () => {
    const saved = process.env.IS_HOSTED;
    try {
      delete process.env.IS_HOSTED;
      vi.resetModules();
      const { getRemoteAccessBaseline: fresh } = await import('./policyBaselineDefaults');
      const s = fresh();
      expect(s.clipboardHostToViewer).toBe(true);
      expect(s.clipboardViewerToHost).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.IS_HOSTED;
      else process.env.IS_HOSTED = saved;
      vi.resetModules();
    }
  });
});

describe('CONFIG_FEATURE_TYPES parity with DB enum', () => {
  it('matches configFeatureTypeEnum.enumValues exactly', () => {
    expect([...CONFIG_FEATURE_TYPES].sort()).toEqual([...configFeatureTypeEnum.enumValues].sort());
  });
});
