/**
 * Unit tests for the AI software-policy audit helpers — specifically the
 * autoInstall refusal guard (contract-A D4, #5505 W05) and its greppable
 * audit-summary line.
 */
import { describe, it, expect } from 'vitest';
import {
  AI_AUTO_INSTALL_REFUSAL_MESSAGE,
  remediationOptionsArmsAutoInstall,
  summarizeEnforcementChange,
} from './aiToolsSoftwarePolicyAudit';

describe('remediationOptionsArmsAutoInstall (contract-A D4)', () => {
  it('is true only for a literal { autoInstall: true }', () => {
    expect(remediationOptionsArmsAutoInstall({ autoInstall: true })).toBe(true);
  });

  it('is false when autoInstall is absent', () => {
    expect(remediationOptionsArmsAutoInstall({ autoUninstall: true })).toBe(false);
  });

  it('is false when autoInstall is explicitly false', () => {
    expect(remediationOptionsArmsAutoInstall({ autoInstall: false })).toBe(false);
  });

  it('is false for a truthy non-boolean value (string "true")', () => {
    expect(remediationOptionsArmsAutoInstall({ autoInstall: 'true' })).toBe(false);
  });

  it('is false for null, undefined, arrays, and non-objects', () => {
    expect(remediationOptionsArmsAutoInstall(null)).toBe(false);
    expect(remediationOptionsArmsAutoInstall(undefined)).toBe(false);
    expect(remediationOptionsArmsAutoInstall([{ autoInstall: true }])).toBe(false);
    expect(remediationOptionsArmsAutoInstall('autoInstall')).toBe(false);
    expect(remediationOptionsArmsAutoInstall(42)).toBe(false);
  });

  it('exports the exact contract-A D4 refusal message', () => {
    expect(AI_AUTO_INSTALL_REFUSAL_MESSAGE).toBe(
      'Arming autoInstall requires a human operator with devices.execute and MFA; the AI agent cannot arm software installation.'
    );
  });
});

describe('summarizeEnforcementChange — autoInstall is greppable (contract-A D4)', () => {
  it('surfaces autoInstall:true at the top level, not just buried in remediationOptions', () => {
    const summary = summarizeEnforcementChange({ remediationOptions: { autoInstall: true } });
    expect(summary.autoInstall).toBe(true);
  });

  it('surfaces autoInstall:false when remediationOptions is present without it', () => {
    const summary = summarizeEnforcementChange({ remediationOptions: { autoUninstall: true } });
    expect(summary.autoInstall).toBe(false);
  });

  it('omits autoInstall entirely when remediationOptions is absent', () => {
    const summary = summarizeEnforcementChange({ enforceMode: true });
    expect(summary).not.toHaveProperty('autoInstall');
  });

  it('still reports autoUninstall unchanged (regression — this wave adds a verb, not replaces one)', () => {
    const summary = summarizeEnforcementChange({ remediationOptions: { autoUninstall: true, autoInstall: false } });
    expect(summary.autoUninstall).toBe(true);
    expect(summary.autoInstall).toBe(false);
  });
});
