import { describe, expect, it } from 'vitest';

import canonical from '../../../../packages/shared/src/fixtures/pam-lifetime-v2-command-contract.json';
import {
  buildPamActuationCommand,
  type PamDispatchSnapshot,
} from './pamActuationCommandPayload';

const base: PamDispatchSnapshot = {
  actuationId: canonical.apply.actuationId,
  generation: canonical.apply.generation,
  requestId: canonical.apply.requestId,
  deviceId: canonical.apply.deviceId,
  orgId: canonical.apply.orgId,
  desiredState: 'active',
  targetPath: canonical.apply.targetPath,
  targetHash: canonical.apply.targetHash,
  subjectUsername: canonical.apply.subjectUsername,
  expiresAt: new Date(canonical.apply.expiresAt),
};

describe('buildPamActuationCommand', () => {
  it('builds the exact frozen apply v2 payload', () => {
    const result = buildPamActuationCommand(base, new Date(canonical.apply.serverTime));

    expect(result).toEqual({
      kind: 'command',
      commandType: 'pam_apply_v2',
      payload: canonical.apply,
    });
    expect(result.kind).toBe('command');
    if (result.kind !== 'command') return;
    expect(result.payload).not.toHaveProperty('elevationRequestId');
    expect(result.payload).not.toHaveProperty('requestRevision');
    expect(result.payload).not.toHaveProperty('targetExecutablePath');
    expect(result.payload).not.toHaveProperty('targetExecutableHash');
    if (result.commandType !== 'pam_apply_v2') return;
    expect(Date.parse(result.payload.serverTime) + result.payload.maxRemainingLifetimeMs)
      .toBe(Date.parse(result.payload.expiresAt));
  });

  it('builds cleanup with no apply-only keys', () => {
    const result = buildPamActuationCommand({
      ...base,
      generation: canonical.cleanup.generation,
      desiredState: 'cleanup',
    }, new Date(canonical.apply.serverTime));

    expect(result).toEqual({
      kind: 'command',
      commandType: 'pam_cleanup_v2',
      payload: canonical.cleanup,
    });
    expect(Object.keys(result.kind === 'command' ? result.payload : {}).sort()).toEqual([
      'actuationId',
      'deviceId',
      'generation',
      'orgId',
      'protocolVersion',
      'requestId',
    ]);
  });

  it.each([
    ['missing', null, new Date(canonical.apply.serverTime)],
    ['elapsed', new Date(canonical.apply.serverTime), new Date(canonical.apply.serverTime)],
    ['invalid expiry', new Date(Number.NaN), new Date(canonical.apply.serverTime)],
    ['invalid server time', new Date(canonical.apply.expiresAt), new Date(Number.NaN)],
  ] as const)('blocks a %s apply lifetime', (_name, expiresAt, serverTime) => {
    expect(buildPamActuationCommand({ ...base, expiresAt }, serverTime)).toEqual({
      kind: 'blocked',
      failureCode: 'expired_before_dispatch',
    });
  });
});
