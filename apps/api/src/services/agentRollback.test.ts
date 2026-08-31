import { describe, expect, it } from 'vitest';
import {
  buildRollbackArtifacts,
  selectImmediateStableRollbackTarget,
  type RegisteredRollbackArtifact,
} from './agentRollback';
import { CommandTypes } from './commandQueue';
import { getCommandTimeoutMs } from './commandTimeouts';

const release = (overrides: Partial<RegisteredRollbackArtifact> = {}): RegisteredRollbackArtifact => ({
  id: crypto.randomUUID(),
  version: '1.9.0',
  platform: 'windows',
  architecture: 'amd64',
  edition: 'hosted',
  component: 'agent',
  downloadUrl: 'https://updates.example/agent.exe',
  checksum: 'a'.repeat(64),
  fileSize: 100n,
  releaseManifest: '{}',
  manifestSignature: 'signature',
  signingKeyId: 'deploy-test',
  ...overrides,
});

describe('selectImmediateStableRollbackTarget', () => {
  it('selects the greatest verified stable version strictly below current', () => {
    expect(selectImmediateStableRollbackTarget({
      currentVersion: '2.0.0', platform: 'windows', architecture: 'amd64', edition: 'hosted',
      releases: [release({ version: '1.8.0' }), release({ version: '1.9.0' }), release({ version: '1.9.5-beta.1' })],
    }).version).toBe('1.9.0');
  });

  it.each([
    ['equal', release({ version: '2.0.0' })],
    ['newer', release({ version: '2.1.0' })],
    ['prerelease', release({ version: '1.9.0-rc.1' })],
    ['platform mismatch', release({ platform: 'linux' })],
    ['architecture mismatch', release({ architecture: 'arm64' })],
    ['edition mismatch', release({ edition: 'self-host' })],
  ])('rejects %s as an immediate target', (_name, candidate) => {
    expect(() => selectImmediateStableRollbackTarget({
      currentVersion: '2.0.0', platform: 'windows', architecture: 'amd64', edition: 'hosted', releases: [candidate],
    })).toThrow(/rollback target/i);
  });

  it('rejects ambiguous duplicate target registrations', () => {
    expect(() => selectImmediateStableRollbackTarget({
      currentVersion: '2.0.0', platform: 'windows', architecture: 'amd64', edition: 'hosted',
      releases: [release(), release({ id: crypto.randomUUID() })],
    })).toThrow(/ambiguous/i);
  });

  it('rejects two raw registrations that normalize to the live current version', () => {
    expect(() => selectImmediateStableRollbackTarget({
      currentVersion: '2.0.0', platform: 'windows', architecture: 'amd64', edition: 'hosted',
      releases: [release(), release({ version: '2.0.0' }), release({ version: 'v2.0.0' })],
    })).toThrow(/current.*ambiguous/i);
  });
});

describe('buildRollbackArtifacts', () => {
  it('builds agent plus each durably observed installed companion', () => {
    const rows = [
      release(),
      release({ component: 'helper', downloadUrl: 'https://updates.example/helper.exe', fileSize: 70n }),
      release({ component: 'user-helper', downloadUrl: 'https://updates.example/user-helper.exe', fileSize: 75n }),
      release({ component: 'watchdog', downloadUrl: 'https://updates.example/watchdog.exe', fileSize: 80n }),
      release({ component: 'backup', downloadUrl: 'https://updates.example/backup.exe', fileSize: 90n }),
    ];
    const built = buildRollbackArtifacts({
      targetVersion: '1.9.0',
      currentVersions: {
        agent: '2.0.0', helper: '2.0.0', 'user-helper': '2.0.0', watchdog: '2.0.0', backup: '2.0.0',
      },
      releases: rows,
    });
    expect(built.artifacts.map((row) => row.component))
      .toEqual(['agent', 'helper', 'user-helper', 'watchdog', 'backup']);
    expect(built.componentVersions.backup).toEqual({ current: '2.0.0', target: '1.9.0' });
  });

  it('fails closed when an installed companion has no exact signed target artifact', () => {
    expect(() => buildRollbackArtifacts({
      targetVersion: '1.9.0', currentVersions: { agent: '2.0.0', watchdog: '2.0.0' }, releases: [release()],
    })).toThrow(/watchdog/);
  });

  it.each([
    ['missing manifest', { releaseManifest: null }],
    ['missing signature', { manifestSignature: null }],
    ['missing key id', { signingKeyId: null }],
    ['missing size', { fileSize: null }],
  ])('fails closed for %s', (_name, overrides) => {
    expect(() => buildRollbackArtifacts({
      targetVersion: '1.9.0', currentVersions: { agent: '2.0.0' }, releases: [release(overrides)],
    })).toThrow(/signed target artifact/i);
  });
});

it('gives rollback enough time for verified multi-component replacement', () => {
  expect(CommandTypes.AGENT_ROLLBACK_V1).toBe('agent_rollback_v1');
  expect(getCommandTimeoutMs(CommandTypes.AGENT_ROLLBACK_V1)).toBe(2 * 60 * 60 * 1000);
});
