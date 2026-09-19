import { describe, expect, it } from 'vitest';
import {
  evaluateRollbackObservationTransition,
  type RollbackDirectiveProjection,
  type RollbackObservationV1,
} from './agentRollbackResult';

const directive: RollbackDirectiveProjection = {
  id: '10000000-0000-4000-8000-000000000001',
  deviceId: '20000000-0000-4000-8000-000000000002',
  currentVersion: '2.0.0',
  targetVersion: '1.9.0',
  componentVersions: {
    agent: { current: '2.0.0', target: '1.9.0' },
    helper: { current: '2.0.0', target: '1.9.0' },
    'user-helper': { current: '2.0.0', target: '1.9.0' },
    watchdog: { current: '2.0.0', target: '1.9.0' },
    backup: { current: '2.0.0', target: '1.9.0' },
  },
  status: 'requested',
  latestPhase: null,
};

const currentLive = {
  agent: '2.0.0', helper: '2.0.0', 'user-helper': '2.0.0', watchdog: '2.0.0', backup: '2.0.0',
};
const targetLive = {
  agent: '1.9.0', helper: '1.9.0', 'user-helper': '1.9.0', watchdog: '1.9.0', backup: '1.9.0',
};

const observation = (overrides: Partial<RollbackObservationV1> = {}): RollbackObservationV1 => ({
  schemaVersion: 1,
  observationId: 'a'.repeat(64),
  rollbackId: directive.id,
  deviceId: directive.deviceId,
  phase: 'received',
  currentVersion: '2.0.0',
  componentVersions: currentLive,
  observedAt: '2026-08-25T12:00:00Z',
  ...overrides,
});

describe('evaluateRollbackObservationTransition', () => {
  it.each([
    ['wrong device', observation({ deviceId: '30000000-0000-4000-8000-000000000003' })],
    ['wrong rollback', observation({ rollbackId: '30000000-0000-4000-8000-000000000003' })],
    ['stale current version', observation({ currentVersion: '1.8.0' })],
    ['unbound component version', observation({ componentVersions: { ...currentLive, agent: '1.8.0' } })],
  ])('rejects %s without advancing', (_name, value) => {
    expect(evaluateRollbackObservationTransition({
      directive,
      observation: value,
      liveVersions: currentLive,
    })).toMatchObject({ accepted: false, advance: false });
  });

  it('rejects mixed-set failed evidence', () => {
    expect(evaluateRollbackObservationTransition({
      directive,
      observation: observation({ phase: 'failed', componentVersions: { ...currentLive, backup: '1.9.0' } }),
      liveVersions: currentLive,
    })).toMatchObject({ accepted: false, rejectionCode: 'version_binding_mismatch' });
  });

  it('advances forward while allowing skipped telemetry phases', () => {
    expect(evaluateRollbackObservationTransition({
      directive: { ...directive, status: 'in_progress', latestPhase: 'received' },
      observation: observation({ phase: 'staged' }),
      liveVersions: currentLive,
    })).toEqual({ accepted: true, advance: true, status: 'in_progress', rejectionCode: null });
  });

  it('durably accepts but does not advance a repeated or backward phase', () => {
    expect(evaluateRollbackObservationTransition({
      directive: { ...directive, status: 'in_progress', latestPhase: 'staged' },
      observation: observation({ phase: 'downloaded' }),
      liveVersions: currentLive,
    })).toEqual({ accepted: true, advance: false, status: 'in_progress', rejectionCode: 'phase_not_forward' });
  });

  it('rejects forged healthy until the live heartbeat proves every owned component is target', () => {
    const result = evaluateRollbackObservationTransition({
      directive: { ...directive, status: 'in_progress', latestPhase: 'restart_requested' },
      observation: observation({ phase: 'healthy', componentVersions: targetLive }),
      liveVersions: { ...targetLive, backup: '2.0.0' },
    });
    expect(result).toEqual({ accepted: true, advance: false, status: 'in_progress', rejectionCode: 'live_component_mismatch' });
  });

  it('completes only when target agent and the full owned component set are live', () => {
    expect(evaluateRollbackObservationTransition({
      directive: { ...directive, status: 'in_progress', latestPhase: 'restart_requested' },
      observation: observation({ phase: 'healthy', componentVersions: targetLive }),
      liveVersions: targetLive,
    })).toEqual({ accepted: true, advance: true, status: 'completed', rejectionCode: null });
  });

  it.each([
    ['failed', 'failed'],
    ['recovered', 'recovered'],
  ] as const)('retains terminal %s truth', (phase, status) => {
    expect(evaluateRollbackObservationTransition({
      directive: { ...directive, status: 'in_progress', latestPhase: 'staged' },
      observation: observation({ phase, errorCode: `${phase}_code` }),
      liveVersions: currentLive,
    })).toEqual({ accepted: true, advance: true, status, rejectionCode: null });
  });

  it('never advances a terminal projection', () => {
    expect(evaluateRollbackObservationTransition({
      directive: { ...directive, status: 'failed', latestPhase: 'failed' },
      observation: observation({ phase: 'healthy', componentVersions: targetLive }),
      liveVersions: targetLive,
    })).toMatchObject({ accepted: true, advance: false, rejectionCode: 'already_terminal' });
  });
});
