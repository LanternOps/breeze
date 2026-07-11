import { describe, it, expect } from 'vitest';
import {
  remoteAccessConsentSettingsSchema,
  remoteAccessInlineSettingsSchema,
} from './configurationPolicy';

// The capability shape the web RemoteAccessTab sends on save — the exact
// payload the reporter's instance had stored / kept re-submitting (#2320).
const CAPABILITY_SETTINGS = {
  webrtcDesktop: true,
  vncRelay: false,
  remoteTools: true,
  clipboardHostToViewer: true,
  clipboardViewerToHost: true,
  enableProxy: false,
  defaultAllowedPorts: [80, 443, 8080, 8443],
  autoEnableProxy: false,
  maxConcurrentTunnels: 5,
  idleTimeoutMinutes: 5,
  maxSessionDurationHours: 8,
};

describe('remoteAccessConsentSettingsSchema (decompose subset)', () => {
  it('applies spec defaults when empty', () => {
    const parsed = remoteAccessConsentSettingsSchema.parse({});
    expect(parsed).toEqual({
      sessionPromptMode: 'notify',
      consentUnavailableBehavior: 'proceed',
      notifyOnSessionEnd: true,
      showActiveIndicator: true,
      technicianIdentityLevel: 'name_email',
    });
  });

  it('rejects an invalid mode', () => {
    expect(() => remoteAccessConsentSettingsSchema.parse({ sessionPromptMode: 'always' })).toThrow();
  });

  it('ignores the capability fields sharing the same JSONB blob (#2320)', () => {
    // decomposeInlineSettings parses the whole inlineSettings blob with this
    // schema; capability keys must be stripped, never rejected — a throw here
    // is what made every RemoteAccessTab save fail.
    const parsed = remoteAccessConsentSettingsSchema.parse({
      ...CAPABILITY_SETTINGS,
      sessionPromptMode: 'consent',
    });
    expect(parsed.sessionPromptMode).toBe('consent');
    expect(parsed).not.toHaveProperty('webrtcDesktop');
  });
});

describe('remoteAccessInlineSettingsSchema (write-path combined shape)', () => {
  it('accepts the capability payload the RemoteAccessTab sends (#2320 regression)', () => {
    const parsed = remoteAccessInlineSettingsSchema.parse(CAPABILITY_SETTINGS);
    expect(parsed).toEqual(CAPABILITY_SETTINGS);
  });

  it('accepts a mixed capability + consent payload, preserving both', () => {
    const parsed = remoteAccessInlineSettingsSchema.parse({
      ...CAPABILITY_SETTINGS,
      sessionPromptMode: 'consent',
      technicianIdentityLevel: 'generic',
    });
    expect(parsed).toEqual({
      ...CAPABILITY_SETTINGS,
      sessionPromptMode: 'consent',
      technicianIdentityLevel: 'generic',
    });
  });

  it('does not inject consent defaults on a capability-only save', () => {
    const parsed = remoteAccessInlineSettingsSchema.parse(CAPABILITY_SETTINGS);
    expect(parsed).not.toHaveProperty('sessionPromptMode');
  });

  it('strips unknown legacy keys instead of rejecting them', () => {
    // Pre-existing rows can carry stale keys the tab round-trips back on save.
    const parsed = remoteAccessInlineSettingsSchema.parse({
      ...CAPABILITY_SETTINGS,
      someAncientKey: 'x',
    });
    expect(parsed).toEqual(CAPABILITY_SETTINGS);
  });

  it('still rejects invalid consent values', () => {
    expect(() => remoteAccessInlineSettingsSchema.parse({ sessionPromptMode: 'always' })).toThrow();
  });

  it('still rejects invalid capability values', () => {
    expect(() => remoteAccessInlineSettingsSchema.parse({ webrtcDesktop: 'yes' })).toThrow();
    expect(() => remoteAccessInlineSettingsSchema.parse({ idleTimeoutMinutes: 99999 })).toThrow();
    expect(() => remoteAccessInlineSettingsSchema.parse({ defaultAllowedPorts: [0] })).toThrow();
  });
});
