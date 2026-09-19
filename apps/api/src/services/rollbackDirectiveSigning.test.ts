import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import golden from '../testFixtures/agent-rollback-directive-v1.json';
import {
  canonicalRollbackDirectiveBytes,
  type AgentRollbackDirectiveV1,
  verifyRollbackDirectiveSignature,
} from './rollbackDirectiveSigning';

const seed = Buffer.alloc(32, 7);
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der',
  type: 'pkcs8',
});
const publicKeyB64 = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  .subarray(-32).toString('base64');

const unsigned = {
  schemaVersion: 1 as const,
  rollbackId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
  orgId: '33333333-3333-4333-8333-333333333333',
  platform: 'windows' as const,
  architecture: 'amd64' as const,
  currentVersion: '2.0.0',
  targetVersion: '1.9.0',
  componentVersions: { agent: { current: '2.0.0', target: '1.9.0' } },
  releaseManifest: '{"schemaVersion":1,"release":"v1.9.0"}',
  manifestSignature: 'manifest-signature',
  manifestSigningKeyId: 'release-artifact-manifest-ed25519',
  artifacts: [{
    component: 'agent' as const,
    currentVersion: '2.0.0',
    targetVersion: '1.9.0',
    downloadUrl: 'https://updates.example/agent.exe',
    sha256: 'a'.repeat(64),
    size: 1234,
  }],
  reason: 'Recover from regression',
  authorizedBy: '44444444-4444-4444-8444-444444444444',
  approvedAt: '2026-08-25T12:00:00Z',
  expiresAt: '2026-08-25T12:05:00Z',
  directiveSigningKeyId: 'deploy-test',
};

function signedDirective(): AgentRollbackDirectiveV1 {
  return {
    ...unsigned,
    directiveSignature: sign(null, canonicalRollbackDirectiveBytes(unsigned), privateKey).toString('base64'),
  };
}

describe('rollback directive signing', () => {
  it('pins the complete canonical record to a stable digest', () => {
    expect(createHash('sha256').update(canonicalRollbackDirectiveBytes(unsigned)).digest('hex'))
      .toBe(golden.canonicalSha256);
    expect(verifyRollbackDirectiveSignature(
      golden.directive as AgentRollbackDirectiveV1,
      golden.publicKeyB64,
    )).toBe(true);
  });

  it('verifies the golden signature and rejects every signed field tamper', () => {
    const directive = signedDirective();
    expect(verifyRollbackDirectiveSignature(directive, publicKeyB64)).toBe(true);

    const tampered: AgentRollbackDirectiveV1[] = [
      { ...directive, rollbackId: crypto.randomUUID() },
      { ...directive, deviceId: crypto.randomUUID() },
      { ...directive, orgId: crypto.randomUUID() },
      { ...directive, platform: 'linux' },
      { ...directive, architecture: 'arm64' },
      { ...directive, currentVersion: '2.0.1' },
      { ...directive, targetVersion: '1.8.0' },
      { ...directive, componentVersions: { agent: { current: '2.0.0', target: '1.8.0' } } },
      { ...directive, releaseManifest: '{}' },
      { ...directive, manifestSignature: 'changed' },
      { ...directive, manifestSigningKeyId: 'changed' },
      { ...directive, artifacts: [{ ...directive.artifacts[0]!, size: 1235 }] },
      { ...directive, reason: 'changed' },
      { ...directive, authorizedBy: crypto.randomUUID() },
      { ...directive, approvedAt: '2026-08-25T12:00:01Z' },
      { ...directive, expiresAt: '2026-08-25T12:05:01Z' },
      { ...directive, directiveSigningKeyId: 'changed' },
    ];
    for (const value of tampered) {
      expect(verifyRollbackDirectiveSignature(value, publicKeyB64)).toBe(false);
    }
  });

  it('rejects line separators in scalar fields', () => {
    expect(() => canonicalRollbackDirectiveBytes({ ...unsigned, reason: 'bad\nreason' }))
      .toThrow(/newline/);
  });
});
