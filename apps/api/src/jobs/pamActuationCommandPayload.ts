export type PamApplyV2Payload = {
  protocolVersion: 2;
  actuationId: string;
  generation: number;
  requestId: string;
  deviceId: string;
  orgId: string;
  targetPath: string;
  targetHash: string | null;
  subjectUsername: string;
  expiresAt: string;
  serverTime: string;
  maxRemainingLifetimeMs: number;
};

export type PamCleanupV2Payload = {
  protocolVersion: 2;
  actuationId: string;
  generation: number;
  requestId: string;
  deviceId: string;
  orgId: string;
};

export type PamDispatchSnapshot = {
  actuationId: string;
  generation: number;
  requestId: string;
  deviceId: string;
  orgId: string;
  desiredState: 'active' | 'cleanup';
  targetPath: string;
  targetHash: string | null;
  subjectUsername: string;
  expiresAt: Date | null;
};

export type PamCommandBuildResult =
  | { kind: 'command'; commandType: 'pam_apply_v2'; payload: PamApplyV2Payload }
  | { kind: 'command'; commandType: 'pam_cleanup_v2'; payload: PamCleanupV2Payload }
  | { kind: 'blocked'; failureCode: 'expired_before_dispatch' };

export function buildPamActuationCommand(
  snapshot: PamDispatchSnapshot,
  serverTime: Date,
): PamCommandBuildResult {
  const identity = {
    protocolVersion: 2 as const,
    actuationId: snapshot.actuationId,
    generation: snapshot.generation,
    requestId: snapshot.requestId,
    deviceId: snapshot.deviceId,
    orgId: snapshot.orgId,
  };

  if (snapshot.desiredState === 'cleanup') {
    return {
      kind: 'command',
      commandType: 'pam_cleanup_v2',
      payload: identity,
    };
  }

  const serverTimeMs = serverTime.getTime();
  const expiresAtMs = snapshot.expiresAt?.getTime() ?? Number.NaN;
  const remainingMs = expiresAtMs - serverTimeMs;
  if (
    !Number.isFinite(serverTimeMs)
    || !Number.isFinite(expiresAtMs)
    || !Number.isSafeInteger(remainingMs)
    || remainingMs <= 0
  ) {
    return { kind: 'blocked', failureCode: 'expired_before_dispatch' };
  }

  return {
    kind: 'command',
    commandType: 'pam_apply_v2',
    payload: {
      ...identity,
      targetPath: snapshot.targetPath,
      targetHash: snapshot.targetHash,
      subjectUsername: snapshot.subjectUsername,
      expiresAt: snapshot.expiresAt!.toISOString(),
      serverTime: serverTime.toISOString(),
      maxRemainingLifetimeMs: remainingMs,
    },
  };
}
