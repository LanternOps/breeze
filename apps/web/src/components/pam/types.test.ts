import { describe, expect, it } from 'vitest';
import { requestToRuleDraft, type ElevationRequest } from './types';

/**
 * Base request used by the precedence table. Individual rows override only the
 * fields that drive the criterion choice; orgId/siteId stay fixed so we can
 * assert they're carried into every draft branch (#1286 review — Fix A/H).
 */
const base: ElevationRequest = {
  id: 'req-1',
  orgId: 'org-7',
  siteId: 'site-3',
  deviceId: 'dev-1',
  flowType: 'uac_intercept',
  subjectUsername: 'DOMAIN\\alice',
  reason: 'install',
  status: 'pending',
  requestedAt: '2026-06-01T00:00:00Z',
};

describe('requestToRuleDraft precedence', () => {
  it('uac with signer+hash+path → signer only', () => {
    const d = requestToRuleDraft({
      ...base,
      targetExecutableSigner: 'Acme Corp',
      targetExecutableHash: 'a'.repeat(64),
      targetExecutablePath: 'C:\\Temp\\x.exe',
    });
    expect(d.shape).toBe('executable');
    if (d.shape !== 'executable') throw new Error('unreachable');
    expect(d.matchSigner).toBe('Acme Corp');
    expect(d.matchHash).toBeUndefined();
    expect(d.matchPathGlob).toBeUndefined();
    expect(d.orgId).toBe('org-7');
    expect(d.siteId).toBe('site-3');
  });

  it('uac with hash+path (no signer) → hash', () => {
    const d = requestToRuleDraft({
      ...base,
      targetExecutableHash: 'b'.repeat(64),
      targetExecutablePath: 'C:\\Temp\\x.exe',
    });
    if (d.shape !== 'executable') throw new Error('unreachable');
    expect(d.matchHash).toBe('b'.repeat(64));
    expect(d.matchSigner).toBeUndefined();
    expect(d.matchPathGlob).toBeUndefined();
    expect(d.orgId).toBe('org-7');
    expect(d.siteId).toBe('site-3');
  });

  it('uac with path only → pathGlob', () => {
    const d = requestToRuleDraft({ ...base, targetExecutablePath: 'C:\\Temp\\x.exe' });
    if (d.shape !== 'executable') throw new Error('unreachable');
    expect(d.matchPathGlob).toBe('C:\\Temp\\x.exe');
    expect(d.orgId).toBe('org-7');
    expect(d.siteId).toBe('site-3');
  });

  it('uac with nothing → pathGlob null', () => {
    const d = requestToRuleDraft({ ...base });
    if (d.shape !== 'executable') throw new Error('unreachable');
    expect(d.matchPathGlob).toBeNull();
    expect(d.orgId).toBe('org-7');
    expect(d.siteId).toBe('site-3');
  });

  it('tech_jit_admin → matchUser', () => {
    const d = requestToRuleDraft({ ...base, flowType: 'tech_jit_admin' });
    if (d.shape !== 'executable') throw new Error('unreachable');
    expect(d.matchUser).toBe('DOMAIN\\alice');
    expect(d.orgId).toBe('org-7');
    expect(d.siteId).toBe('site-3');
  });

  it('ai_tool_action → toolName + riskTier + shape tool', () => {
    const d = requestToRuleDraft({
      ...base,
      flowType: 'ai_tool_action',
      toolName: 'run_script',
      riskTier: 3,
    });
    expect(d.shape).toBe('tool');
    if (d.shape !== 'tool') throw new Error('unreachable');
    expect(d.matchToolName).toBe('run_script');
    expect(d.matchRiskTier).toBe(3);
    expect(d.orgId).toBe('org-7');
    expect(d.siteId).toBe('site-3');
  });
});
