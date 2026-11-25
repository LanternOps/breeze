import { describe, expect, it } from 'vitest';
import {
  canonicalDeviceReattachResource,
  confirmTargetNameMatches,
  deviceReattachRequestBody,
  isKnownReattachRefusal,
  parseReinstallCandidatesView,
  reattachPath,
  reinstallCandidatesPath,
} from './deviceReattach';

const resource = {
  sourceDeviceId: 'src',
  targetDeviceId: 'tgt',
  targetVersion: 'v'.repeat(43),
  evidenceLevel: 'hint' as const,
  restoreDecommissioned: false,
};

describe('deviceReattach (#8318)', () => {
  it('the step-up resource carries exactly the five keys the server schema accepts', () => {
    const extra = { ...resource, confirmTargetName: 'x' } as typeof resource;
    expect(Object.keys(canonicalDeviceReattachResource(extra)).sort()).toEqual(
      ['evidenceLevel', 'restoreDecommissioned', 'sourceDeviceId', 'targetDeviceId', 'targetVersion'],
    );
  });

  it('the body is built from the same resource, with the typed name trimmed and no grant unless given', () => {
    expect(deviceReattachRequestBody(resource, { confirmTargetName: '  PC-1 ', acknowledgeOsChange: false })).toEqual({
      targetDeviceId: 'tgt',
      targetVersion: 'v'.repeat(43),
      possessionConfirmed: true,
      confirmTargetName: 'PC-1',
      restoreDecommissioned: false,
      acknowledgeOsChange: false,
      expectedEvidenceLevel: 'hint',
    });
    // The expected level is the bound one: never a separate input.
    expect(deviceReattachRequestBody({ ...resource, evidenceLevel: 'tpm_continuity' }, { confirmTargetName: '', acknowledgeOsChange: false }))
      .toMatchObject({ expectedEvidenceLevel: 'tpm_continuity' });
    expect(deviceReattachRequestBody(resource, { confirmTargetName: 'PC-1', acknowledgeOsChange: true, stepUpGrant: 'g' }))
      .toMatchObject({ acknowledgeOsChange: true, stepUpGrant: 'g' });
  });

  it('compares the typed name as the server does', () => {
    expect(confirmTargetNameMatches(' pc-1 ', 'PC-1')).toBe(true);
    expect(confirmTargetNameMatches('', '')).toBe(false);
    expect(confirmTargetNameMatches('pc-2', 'PC-1')).toBe(false);
  });

  it('encodes the device id into the paths', () => {
    expect(reinstallCandidatesPath('a/b')).toBe('/devices/a%2Fb/reinstall-candidates');
    expect(reattachPath('abc')).toBe('/devices/abc/reattach');
  });

  it('parses the candidates read and rejects a body of the wrong shape', () => {
    expect(parseReinstallCandidatesView(null)).toBeNull();
    expect(parseReinstallCandidatesView({ source: {}, candidates: [] })).toBeNull();
    const view = parseReinstallCandidatesView({
      source: { deviceId: 'src' },
      candidates: [{ deviceId: 'tgt', targetVersion: 'v', hostname: 'PC' }, { deviceId: 'no-version' }],
      reviewPending: true,
      openIntent: null,
    });
    expect(view?.candidates.map((c) => c.deviceId)).toEqual(['tgt']);
    expect(view?.reviewPending).toBe(true);
    expect(view?.openIntent).toBeNull();
  });

  it('knows the refusal codes it has words for', () => {
    expect(isKnownReattachRefusal('target_alive')).toBe(true);
    expect(isKnownReattachRefusal('something_else')).toBe(false);
    expect(isKnownReattachRefusal(undefined)).toBe(false);
  });
});
